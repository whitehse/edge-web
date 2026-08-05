/**
 * Remote desktop SPA (PR-6): REST session lifecycle + noVNC over path-bound WS.
 *
 * Flow:
 *   POST /api/v1/cpe/desktop/sessions → { session.vnc_ws_path }
 *   RFB → ws(s)://host/api/v1/cpe/desktop/vnc/{id}
 *   DELETE on disconnect
 *
 * Clipboard disabled (design D / v1). Deep link: ?router_id=&ticket_id=&auto=1
 */
import RFB from "https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/lib/rfb.js";

(function () {
  var rfb = null;
  var sessionId = null;
  var pollTimer = 0;
  var idleTimer = 0;
  var connected = false;
  var lastMeta = null;
  var tearingDown = false;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, ok) {
    var el = $("statusLine");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = ok === false ? "var(--danger, #e07070)" : "";
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
    if (meta) meta.hidden = !on;
  }

  function vncWsUrl(path) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    if (!path) return "";
    if (path.indexOf("ws") === 0) return path;
    if (path.charAt(0) !== "/") path = "/" + path;
    return proto + "//" + location.host + path;
  }

  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: "same-origin" }, opts || {})).then(
      function (r) {
        return r.text().then(function (t) {
          var j = null;
          try {
            j = t ? JSON.parse(t) : null;
          } catch (e) {
            j = { error: t || r.statusText };
          }
          return { ok: r.ok, status: r.status, json: j };
        });
      }
    );
  }

  function clearTimers() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = 0;
    }
  }

  function destroyRfb() {
    if (rfb) {
      try {
        rfb.disconnect();
      } catch (e) {
        /* ignore */
      }
      rfb = null;
    }
    var screen = $("screen");
    if (screen) {
      /* Remove noVNC children except placeholder */
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
    var idleLine = $("idleLine");
    if (!sess) {
      if (chipState) chipState.textContent = "—";
      if (chipLan) {
        chipLan.hidden = true;
        chipLan.textContent = "";
      }
      if (chipTh) chipTh.hidden = true;
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
    if (idleLine && sess.idle_timeout_s) {
      idleLine.textContent =
        "idle timeout " + Math.round(sess.idle_timeout_s / 60) + " min";
    }
  }

  function pollSession() {
    if (!sessionId) return;
    api("/api/v1/cpe/desktop/sessions/" + encodeURIComponent(sessionId)).then(
      function (res) {
        if (!res.ok || !res.json || !res.json.session) {
          if (res.status === 404) {
            disconnect("Session ended");
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
        } else {
          setStatus("Connected · " + (s.router_id || ""), true);
        }
      }
    );
  }

  function disconnect(msg) {
    if (tearingDown) return;
    tearingDown = true;
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
    if (msg) setStatus(msg, false);
    else setStatus("Disconnected", false);
    tearingDown = false;
  }

  function startRfb(wsPath) {
    var url = vncWsUrl(wsPath);
    var screen = $("screen");
    if (!screen || !url) {
      setStatus("Missing VNC path", false);
      return;
    }
    destroyRfb();
    setStatus("Opening display…");
    try {
      rfb = new RFB(screen, url, {
        shared: true
      });
    } catch (e) {
      setStatus("noVNC failed: " + e, false);
      disconnect("noVNC init failed");
      return;
    }

    /* View defaults */
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = true;
    rfb.showDotCursor = true;
    /* Quality: moderate default; can lower when throttled */
    try {
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;
    } catch (e2) {
      /* older builds */
    }

    /* Clipboard disabled (v1) — ignore server clip, never send local clip */
    rfb.addEventListener("clipboard", function () {
      /* swallow */
    });

    rfb.addEventListener("connect", function () {
      setConnected(true);
      setStatus("Display connected", true);
      pollTimer = setInterval(pollSession, 5000);
      pollSession();
    });

    rfb.addEventListener("disconnect", function (ev) {
      var clean = ev && ev.detail && ev.detail.clean;
      if (sessionId) {
        /* Backend closed or network; tear down REST session */
        disconnect(clean ? "Display closed" : "Display disconnected");
      }
    });

    rfb.addEventListener("securityfailure", function (ev) {
      var reason =
        ev && ev.detail && ev.detail.status
          ? "security " + ev.detail.status
          : "security failure";
      setStatus(reason, false);
    });

    rfb.addEventListener("credentialsrequired", function () {
      /* Lab image often has no VNC password */
      try {
        rfb.sendCredentials({ password: "" });
      } catch (e3) {
        /* ignore */
      }
    });
  }

  function connect() {
    var rid = routerId();
    if (!rid) {
      setStatus("Enter a router_id (e.g. cpe-lab)", false);
      return;
    }
    if (window.EdgeContext && typeof EdgeContext.setRouter === "function") {
      EdgeContext.setRouter(rid, { source: "desktop" });
    }
    disconnect();
    setStatus("Starting session for " + rid + "…");

    var body = { router_id: rid };
    var tid = ticketId();
    if (tid) body.ticket_id = tid;

    api("/api/v1/cpe/desktop/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok || !res.json || !res.json.session) {
        var err =
          (res.json && (res.json.error || res.json.message)) ||
          "HTTP " + res.status;
        setStatus("Start failed: " + err, false);
        return;
      }
      var sess = res.json.session;
      sessionId = sess.id;
      updateMeta(sess);
      setStatus("Session " + (sess.state || "starting") + "…", true);
      var path = sess.vnc_ws_path;
      if (!path && sessionId) {
        path = "/api/v1/cpe/desktop/vnc/" + encodeURIComponent(sessionId);
      }
      if (!path) {
        setStatus("No vnc_ws_path in response", false);
        disconnect("No VNC path");
        return;
      }
      if (sess.vnc_port === 0 || sess.vnc_port === "0") {
        setStatus(
          "Session running but VNC port unavailable (helper/image?)",
          false
        );
        /* Still attempt path in case port field missing */
      }
      startRfb(path);
    }).catch(function (e) {
      setStatus("Request failed: " + e, false);
    });
  }

  function boot() {
    var inp = $("filterRouter");
    if (inp && window.EdgeContext && typeof EdgeContext.getRouter === "function") {
      var rid = EdgeContext.getRouter();
      if (rid) inp.value = rid;
    }
    if (inp && !inp.value) {
      inp.value = "cpe-lab";
    }

    /* Feature probe (best-effort) */
    api("/api/v1/cpe/desktop").then(function (res) {
      if (res.ok && res.json && res.json.enabled === false) {
        setStatus(
          "Desktop plugin disabled on this host (plugins.cpe_desktop.enabled)",
          false
        );
      }
    }).catch(function () {
      /* ignore */
    });

    $("btnConnect").addEventListener("click", connect);
    $("btnDisconnect").addEventListener("click", function () {
      disconnect("Disconnected");
    });
    if (inp) {
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") connect();
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

    /* Deep link: /desktop/?router_id=cpe-lab&ticket_id=&auto=1 */
    try {
      var q = new URLSearchParams(location.search || "");
      var qr = q.get("router_id");
      var qt = q.get("ticket_id");
      if (qr && inp) inp.value = qr;
      if (qt && $("ticketId")) $("ticketId").value = qt;
      if (qr && q.get("auto") === "1") connect();
    } catch (e2) {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
