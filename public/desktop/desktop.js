/**
 * Remote desktop SPA: REST session lifecycle + noVNC over path-bound WS.
 *
 * Troubleshooting: open browser DevTools → Console for [desktop] logs, or the
 * on-page Debug log. URL ?debug=1 expands the log panel by default.
 *
 * Common failures:
 *   - 503 desktop offline → plugins.cpe_desktop.enabled / helper_socket
 *   - 401 UNAUTHORIZED → log in on home page first
 *   - 404 router offline → CPE not ONLINE (or require_online + wrong id)
 *   - Session ok but no display → vnc_port=0 (need rtdeskd helper, not only inprocess)
 *   - noVNC CDN load fail → network/CSP; see Debug log
 */
(function () {
  "use strict";

  var RFB = null; /* loaded async */
  var rfb = null;
  var sessionId = null;
  var pollTimer = 0;
  var connected = false;
  var lastMeta = null;
  var tearingDown = false;
  var logLines = [];
  var MAX_LOG = 200;
  var debugForce =
    typeof location !== "undefined" &&
    /(?:^|[?&])debug=1(?:&|$)/.test(location.search || "");

  var NOVNC_CDN =
    "https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/lib/rfb.js";
  var NOVNC_LOCAL = "./novnc/lib/rfb.js";

  function $(id) {
    return document.getElementById(id);
  }

  function log(level, msg, detail) {
    var line =
      new Date().toISOString().slice(11, 23) +
      " [" +
      level +
      "] " +
      msg +
      (detail !== undefined ? " " + safeJson(detail) : "");
    logLines.push(line);
    if (logLines.length > MAX_LOG) logLines.shift();
    try {
      if (level === "error") console.error("[desktop]", msg, detail || "");
      else if (level === "warn") console.warn("[desktop]", msg, detail || "");
      else console.log("[desktop]", msg, detail !== undefined ? detail : "");
    } catch (e) {
      /* ignore */
    }
    renderLog();
  }

  function safeJson(x) {
    try {
      if (typeof x === "string") return x;
      return JSON.stringify(x);
    } catch (e) {
      return String(x);
    }
  }

  function renderLog() {
    var el = $("debugLog");
    if (!el) return;
    el.textContent = logLines.join("\n");
    el.scrollTop = el.scrollHeight;
  }

  function setStatus(msg, ok) {
    var el = $("statusLine");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.remove("desk-status-ok", "desk-status-err", "desk-status-busy");
    if (ok === true) el.classList.add("desk-status-ok");
    else if (ok === false) el.classList.add("desk-status-err");
    else el.classList.add("desk-status-busy");
  }

  function setErrorBanner(msg) {
    var el = $("errorBanner");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function setPlaceholder(msg) {
    var el = $("placeholder");
    if (el) el.textContent = msg || "Connect to open the remote desktop";
  }

  function routerId() {
    var el = $("filterRouter");
    var v = el && el.value ? el.value.trim() : "";
    if (!v && window.EdgeContext && typeof EdgeContext.getRouter === "function") {
      v = EdgeContext.getRouter() || "";
    }
    return v;
  }

  function ticketId() {
    var el = $("ticketId");
    return el && el.value ? el.value.trim() : "";
  }

  function setConnected(on) {
    connected = !!on;
    var bc = $("btnConnect");
    var bd = $("btnDisconnect");
    if (bc) bc.disabled = on;
    if (bd) bd.disabled = !on;
    var screen = $("screen");
    if (screen) {
      if (on) screen.classList.add("is-live");
      else screen.classList.remove("is-live");
    }
    var meta = $("metaRow");
    if (meta) meta.hidden = !on && !sessionId;
  }

  function setBusy(busy) {
    var bc = $("btnConnect");
    if (bc && !connected) bc.disabled = !!busy;
  }

  function vncWsUrl(path) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    if (!path) return "";
    if (path.indexOf("ws") === 0) return path;
    if (path.charAt(0) !== "/") path = "/" + path;
    return proto + "//" + location.host + path;
  }

  function api(path, opts) {
    var method = (opts && opts.method) || "GET";
    log("info", method + " " + path);
    return fetch(path, Object.assign({ credentials: "same-origin" }, opts || {}))
      .then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          var parseErr = null;
          try {
            j = t ? JSON.parse(t) : null;
          } catch (e) {
            parseErr = String(e);
            j = { error: t ? t.slice(0, 300) : r.statusText, _raw: true };
          }
          log(
            r.ok ? "info" : "warn",
            method + " " + path + " → " + r.status,
            j && (j.error || j.hint || j.session)
              ? {
                  error: j.error,
                  hint: j.hint,
                  session_id: j.session && j.session.id,
                  state: j.session && j.session.state,
                  vnc_port: j.session && j.session.vnc_port
                }
              : t
                ? t.slice(0, 120)
                : ""
          );
          if (parseErr) log("warn", "JSON parse failed", parseErr);
          return { ok: r.ok, status: r.status, json: j, raw: t };
        });
      })
      .catch(function (e) {
        log("error", method + " " + path + " network error", String(e));
        throw e;
      });
  }

  function formatApiError(res) {
    if (!res) return "unknown error";
    var j = res.json || {};
    var parts = [];
    if (j.error) parts.push(String(j.error));
    if (j.hint) parts.push("(" + j.hint + ")");
    if (j.message && j.message !== j.error) parts.push(String(j.message));
    if (!parts.length) {
      if (res.status === 401)
        return "UNAUTHORIZED — log in on the home page first";
      if (res.status === 403) return "FORBIDDEN — need desktop RBAC (admin)";
      if (res.status === 404) return "not found (router offline?)";
      if (res.status === 409) return "conflict (session or bridge busy)";
      if (res.status === 503) return "service unavailable (desktop offline?)";
      parts.push("HTTP " + res.status);
    } else if (res.status) {
      parts.push("[HTTP " + res.status + "]");
    }
    return parts.join(" ");
  }

  function clearTimers() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function destroyRfb() {
    if (rfb) {
      try {
        rfb.removeEventListener("disconnect", onRfbDisconnect);
      } catch (e0) {
        /* ignore */
      }
      try {
        rfb.disconnect();
      } catch (e) {
        /* ignore */
      }
      rfb = null;
    }
    var screen = $("screen");
    if (screen) {
      var kids = Array.prototype.slice.call(screen.children);
      kids.forEach(function (ch) {
        if (ch.id !== "placeholder") screen.removeChild(ch);
      });
    }
  }

  function updateMeta(sess) {
    lastMeta = sess || null;
    var chipState = $("chipState");
    var chipLan = $("chipLan");
    var chipTh = $("chipThrottle");
    var chipVnc = $("chipVnc");
    var idleLine = $("idleLine");
    var meta = $("metaRow");
    if (meta && sess) meta.hidden = false;
    if (!sess) {
      if (chipState) chipState.textContent = "—";
      if (chipLan) {
        chipLan.hidden = true;
        chipLan.textContent = "";
      }
      if (chipTh) chipTh.hidden = true;
      if (chipVnc) {
        chipVnc.hidden = true;
        chipVnc.textContent = "";
      }
      if (idleLine) idleLine.textContent = "";
      return;
    }
    if (chipState) chipState.textContent = sess.state || "—";
    if (chipLan) {
      if (sess.lan_ip) {
        chipLan.hidden = false;
        chipLan.textContent = "LAN " + sess.lan_ip;
      } else {
        chipLan.hidden = true;
      }
    }
    if (chipTh) {
      chipTh.hidden = !(sess.throttled || sess.state === "throttled");
    }
    if (chipVnc) {
      if (sess.vnc_port !== undefined && sess.vnc_port !== null) {
        chipVnc.hidden = false;
        chipVnc.textContent =
          sess.vnc_port > 0 ? "VNC :" + sess.vnc_port : "VNC n/a";
        if (!(sess.vnc_port > 0)) chipVnc.classList.add("warn");
        else chipVnc.classList.remove("warn");
      }
    }
    if (idleLine && sess.idle_timeout_s) {
      idleLine.textContent =
        "idle timeout " + Math.round(sess.idle_timeout_s / 60) + " min";
    }
    if (sess.id) {
      var sidEl = $("chipSid");
      if (sidEl) {
        sidEl.hidden = false;
        sidEl.textContent = "id " + String(sess.id).slice(0, 8) + "…";
        sidEl.title = sess.id;
      }
    }
  }

  function pollSession() {
    if (!sessionId) return;
    api("/api/v1/cpe/desktop/sessions/" + encodeURIComponent(sessionId)).then(
      function (res) {
        if (!res.ok || !res.json || !res.json.session) {
          if (res.status === 404) {
            disconnect("Session ended on server");
          }
          return;
        }
        var s = res.json.session;
        updateMeta(s);
        if (s.state === "error" || s.state === "draining") {
          setStatus(
            (s.state || "error") + (s.error ? " — " + s.error : ""),
            false
          );
        } else if (s.throttled || s.state === "throttled") {
          setStatus("Connected · rate limited (throttled)", true);
        } else if (connected) {
          setStatus("Display connected · " + (s.router_id || ""), true);
        }
      }
    );
  }

  function onRfbDisconnect(ev) {
    var clean = ev && ev.detail && ev.detail.clean;
    log("warn", "RFB disconnect", { clean: clean, sessionId: sessionId });
    if (sessionId) {
      disconnect(
        clean
          ? "Display closed"
          : "Display disconnected (check Debug log / VNC helper)"
      );
    }
  }

  function disconnect(msg) {
    if (tearingDown) return;
    tearingDown = true;
    log("info", "disconnect", msg || "");
    clearTimers();
    destroyRfb();
    var sid = sessionId;
    sessionId = null;
    setConnected(false);
    updateMeta(null);
    if (sid) {
      api("/api/v1/cpe/desktop/sessions/" + encodeURIComponent(sid), {
        method: "DELETE"
      }).catch(function () {
        /* ignore */
      });
    }
    if (msg) {
      setStatus(msg, false);
      setErrorBanner(msg);
      setPlaceholder(msg);
    } else {
      setStatus("Disconnected", false);
      setErrorBanner("");
      setPlaceholder("Connect to open the remote desktop");
    }
    tearingDown = false;
  }

  function loadRfb() {
    if (RFB) return Promise.resolve(RFB);
    log("info", "loading noVNC RFB", NOVNC_CDN);
    return import(/* webpackIgnore: true */ NOVNC_CDN)
      .then(function (m) {
        RFB = m.default || m.RFB || m;
        if (typeof RFB !== "function") {
          throw new Error("RFB export missing from CDN module");
        }
        log("info", "noVNC RFB loaded from CDN");
        return RFB;
      })
      .catch(function (e1) {
        log("warn", "CDN noVNC failed, trying local vendor", String(e1));
        return import(/* webpackIgnore: true */ NOVNC_LOCAL).then(function (m) {
          RFB = m.default || m.RFB || m;
          if (typeof RFB !== "function") {
            throw new Error("RFB export missing from local novnc");
          }
          log("info", "noVNC RFB loaded from local vendor");
          return RFB;
        });
      });
  }

  function startRfb(wsPath, sess) {
    var url = vncWsUrl(wsPath);
    var screen = $("screen");
    if (!screen || !url) {
      setStatus("Missing VNC path", false);
      setErrorBanner("Missing VNC WebSocket path in session response");
      return;
    }
    if (sess && !(sess.vnc_port > 0)) {
      var noPort =
        "Session " +
        (sess.state || "running") +
        " but vnc_port=0 — no display backend. " +
        "Start edgehost-rtdeskd and set plugins.cpe_desktop.helper_socket " +
        "(inprocess_lab only allocates no VNC port). See Debug log.";
      log("error", noPort, sess);
      setStatus("No VNC port (helper required for display)", false);
      setErrorBanner(noPort);
      setPlaceholder("Session exists but no VNC port");
      setConnected(false);
      /* Keep sessionId so Disconnect cleans up */
      var meta = $("metaRow");
      if (meta) meta.hidden = false;
      updateMeta(sess);
      return;
    }

    setBusy(true);
    setStatus("Loading noVNC…");
    setPlaceholder("Loading noVNC…");
    loadRfb()
      .then(function (RfbCtor) {
        destroyRfb();
        setStatus("Opening display…");
        setPlaceholder("Connecting display…");
        log("info", "RFB connect", url);
        try {
          rfb = new RfbCtor(screen, url, { shared: true });
        } catch (e) {
          log("error", "RFB constructor failed", String(e));
          setStatus("noVNC failed: " + e, false);
          setErrorBanner("noVNC init failed: " + e);
          setBusy(false);
          return;
        }

        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.focusOnClick = true;
        rfb.showDotCursor = true;
        try {
          rfb.qualityLevel = 6;
          rfb.compressionLevel = 2;
        } catch (e2) {
          /* ignore */
        }

        rfb.addEventListener("clipboard", function () {
          /* disabled v1 */
        });

        rfb.addEventListener("connect", function () {
          log("info", "RFB connected");
          setConnected(true);
          setBusy(false);
          setErrorBanner("");
          setStatus("Display connected", true);
          setPlaceholder("");
          pollTimer = setInterval(pollSession, 5000);
          pollSession();
        });

        rfb.addEventListener("disconnect", onRfbDisconnect);

        rfb.addEventListener("securityfailure", function (ev) {
          var reason =
            ev && ev.detail && ev.detail.status
              ? "security " + ev.detail.status
              : "security failure";
          log("error", "RFB securityfailure", reason);
          setStatus(reason, false);
          setErrorBanner(reason);
        });

        rfb.addEventListener("credentialsrequired", function () {
          log("info", "RFB credentialsrequired — sending empty password");
          try {
            rfb.sendCredentials({ password: "" });
          } catch (e3) {
            log("warn", "sendCredentials failed", String(e3));
          }
        });
      })
      .catch(function (e) {
        log("error", "noVNC load failed", String(e));
        setBusy(false);
        setStatus("noVNC failed to load", false);
        setErrorBanner(
          "Could not load noVNC (" +
            String(e) +
            "). Check network/CDN or vendor under public/desktop/novnc/. " +
            "Session may still exist — click Disconnect to clean up."
        );
        setPlaceholder("noVNC library failed to load");
      });
  }

  function connect() {
    var rid = routerId();
    if (!rid) {
      setStatus("Enter a router_id (e.g. cpe-lab)", false);
      setErrorBanner("Router id is required");
      return;
    }
    if (window.EdgeContext && typeof EdgeContext.setRouter === "function") {
      EdgeContext.setRouter(rid, { source: "desktop" });
    }
    disconnect();
    tearingDown = false;
    setErrorBanner("");
    setBusy(true);
    setStatus("Starting session for " + rid + "…");
    setPlaceholder("Starting session…");
    log("info", "connect start", { router_id: rid, ticket: ticketId() || null });

    var body = { router_id: rid };
    var tid = ticketId();
    if (tid) body.ticket_id = tid;

    api("/api/v1/cpe/desktop/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        setBusy(false);
        if (!res.ok || !res.json || !res.json.session) {
          var err = formatApiError(res);
          setStatus("Start failed: " + err, false);
          setErrorBanner("Start failed: " + err);
          setPlaceholder("Start failed — see error above / Debug log");
          return;
        }
        var sess = res.json.session;
        sessionId = sess.id;
        updateMeta(sess);
        log("info", "session created", {
          id: sess.id,
          state: sess.state,
          vnc_port: sess.vnc_port,
          vnc_ws_path: sess.vnc_ws_path
        });
        setStatus("Session " + (sess.state || "starting") + "…", true);
        setErrorBanner("");
        var path = sess.vnc_ws_path;
        if (!path && sessionId) {
          path = "/api/v1/cpe/desktop/vnc/" + encodeURIComponent(sessionId);
        }
        if (!path) {
          setStatus("No vnc_ws_path in response", false);
          setErrorBanner("Server did not return vnc_ws_path");
          return;
        }
        startRfb(path, sess);
      })
      .catch(function (e) {
        setBusy(false);
        setStatus("Request failed: " + e, false);
        setErrorBanner("Request failed: " + e);
        setPlaceholder("Request failed");
      });
  }

  function probeDesktop() {
    api("/api/v1/cpe/desktop")
      .then(function (res) {
        if (res.status === 401) {
          setStatus("Not logged in — open Home and sign in first", false);
          setErrorBanner(
            "Not authenticated. Go to / and log in, then return here."
          );
          return;
        }
        if (res.status === 503) {
          setStatus("Desktop offline on this host", false);
          setErrorBanner(formatApiError(res));
          return;
        }
        if (res.ok && res.json) {
          if (res.json.enabled === false) {
            setStatus("Desktop plugin disabled", false);
            setErrorBanner(
              "plugins.cpe_desktop.enabled is false on this edgehost"
            );
          } else {
            log("info", "desktop status ok", res.json);
            setStatus(
              "Ready — active " +
                (res.json.active || 0) +
                "/" +
                (res.json.max_sessions || "?"),
              true
            );
          }
        }
      })
      .catch(function (e) {
        setStatus("Cannot reach desktop API", false);
        setErrorBanner("Probe failed: " + e);
      });
  }

  function boot() {
    log("info", "boot", {
      href: location.href,
      debug: debugForce
    });

    var panel = $("debugPanel");
    if (panel && debugForce) {
      panel.open = true;
    }

    var inp = $("filterRouter");
    if (inp && window.EdgeContext && typeof EdgeContext.getRouter === "function") {
      var rid = EdgeContext.getRouter();
      if (rid) inp.value = rid;
    }
    if (inp && !inp.value) {
      inp.value = "cpe-lab";
    }

    var bc = $("btnConnect");
    var bd = $("btnDisconnect");
    if (!bc) {
      log("error", "btnConnect missing from DOM — page markup broken?");
      return;
    }
    bc.addEventListener("click", function () {
      log("info", "Connect clicked");
      connect();
    });
    if (bd) {
      bd.addEventListener("click", function () {
        log("info", "Disconnect clicked");
        disconnect("Disconnected");
      });
    }
    if (inp) {
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") connect();
      });
    }

    var copyBtn = $("btnCopyLog");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var text = logLines.join("\n");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () {
              setStatus("Debug log copied", true);
            },
            function () {
              setStatus("Copy failed", false);
            }
          );
        } else {
          setStatus("Clipboard API unavailable", false);
        }
      });
    }

    window.addEventListener("beforeunload", function () {
      if (sessionId) {
        try {
          fetch(
            "/api/v1/cpe/desktop/sessions/" + encodeURIComponent(sessionId),
            { method: "DELETE", credentials: "same-origin", keepalive: true }
          );
        } catch (e) {
          /* ignore */
        }
      }
    });

    try {
      var q = new URLSearchParams(location.search || "");
      var qr = q.get("router_id");
      var qt = q.get("ticket_id");
      if (qr && inp) inp.value = qr;
      if (qt && $("ticketId")) $("ticketId").value = qt;
      probeDesktop();
      if (qr && q.get("auto") === "1") {
        log("info", "auto=1 connect");
        connect();
      }
    } catch (e2) {
      log("warn", "query parse", String(e2));
      probeDesktop();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
