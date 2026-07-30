/**
 * Browser shell: xterm.js ↔ edgehost WebSocket /api/v1/cpe/shell?router_id=
 * Binary frames = PTY bytes; text frames = control JSON (resize / status).
 */
(function () {
  var term = null;
  var fitAddon = null;
  var ws = null;
  var connected = false;
  var reconnectTimer = 0;

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

  function wsUrl(rid) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return (
      proto +
      "//" +
      location.host +
      "/api/v1/cpe/shell?router_id=" +
      encodeURIComponent(rid)
    );
  }

  function sendResize() {
    if (!ws || ws.readyState !== 1 || !term) return;
    try {
      ws.send(
        JSON.stringify({
          op: "resize",
          cols: term.cols,
          rows: term.rows
        })
      );
    } catch (e) {
      /* ignore */
    }
  }

  function setConnected(on) {
    connected = !!on;
    var bc = $("btnConnect");
    var bd = $("btnDisconnect");
    if (bc) bc.disabled = on;
    if (bd) bd.disabled = !on;
  }

  function disconnect(msg) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
      ws = null;
    }
    setConnected(false);
    if (msg) setStatus(msg, false);
  }

  function connect() {
    var rid = routerId();
    if (!rid) {
      setStatus("Enter a router_id (e.g. cpe-lab)", false);
      return;
    }
    if (window.EdgeContext && typeof EdgeContext.setRouter === "function") {
      EdgeContext.setRouter(rid, { source: "terminal" });
    }
    disconnect();
    setStatus("Connecting to " + rid + "…");
    if (term) {
      term.reset();
      term.writeln("\x1b[90mConnecting to " + rid + "…\x1b[0m");
    }

    var url = wsUrl(rid);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("WebSocket failed: " + e, false);
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      setConnected(true);
      setStatus("Connected · " + rid, true);
      if (fitAddon) {
        try {
          fitAddon.fit();
        } catch (e2) {
          /* ignore */
        }
      }
      sendResize();
      if (term) term.focus();
    };

    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        try {
          var j = JSON.parse(ev.data);
          if (j && j.op === "status") {
            setStatus(
              (j.state || "") + (j.msg ? " — " + j.msg : ""),
              j.state !== "error"
            );
            if (j.state === "error" && term) {
              term.writeln("\r\n\x1b[31m" + (j.msg || "error") + "\x1b[0m");
            }
          }
        } catch (e3) {
          if (term) term.write(ev.data);
        }
        return;
      }
      if (!term) return;
      var u8 =
        ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data);
      /* xterm accepts string or Uint8Array depending on version */
      try {
        term.write(u8);
      } catch (e4) {
        var s = "";
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        term.write(s);
      }
    };

    ws.onerror = function () {
      setStatus("WebSocket error", false);
    };

    ws.onclose = function () {
      setConnected(false);
      setStatus("Disconnected", false);
      if (term) {
        term.writeln("\r\n\x1b[90m[session closed]\x1b[0m");
      }
      ws = null;
    };
  }

  function initTerm() {
    if (typeof Terminal === "undefined") {
      setStatus("xterm.js failed to load (CDN)", false);
      return;
    }
    term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      theme: {
        background: "#0c0e12",
        foreground: "#e6e8ec",
        cursor: "#6b8cff",
        selectionBackground: "#3a4560"
      },
      allowProposedApi: true
    });
    if (typeof FitAddon !== "undefined") {
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    } else if (window.FitAddon) {
      fitAddon = new window.FitAddon.FitAddon();
      term.loadAddon(fitAddon);
    }
    term.open($("termHost"));
    if (fitAddon) {
      try {
        fitAddon.fit();
      } catch (e) {
        /* ignore */
      }
    }
    term.writeln("\x1b[90mCPE shell — select router and click Connect\x1b[0m");
    term.onData(function (data) {
      if (!ws || ws.readyState !== 1) return;
      /* Send as binary for raw PTY fidelity */
      var buf = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) {
        buf[i] = data.charCodeAt(i) & 0xff;
      }
      try {
        ws.send(buf);
      } catch (e2) {
        /* ignore */
      }
    });
    term.onResize(function () {
      sendResize();
    });
    window.addEventListener("resize", function () {
      if (fitAddon) {
        try {
          fitAddon.fit();
        } catch (e3) {
          /* ignore */
        }
      }
      sendResize();
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
    initTerm();
    $("btnConnect").addEventListener("click", connect);
    $("btnDisconnect").addEventListener("click", function () {
      disconnect("Disconnected");
    });
    if (inp) {
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") connect();
      });
    }
    /* Deep link: /terminal/?router_id=cpe-lab */
    try {
      var q = new URLSearchParams(location.search || "");
      var qr = q.get("router_id");
      if (qr && inp) {
        inp.value = qr;
        if (q.get("auto") === "1") connect();
      }
    } catch (e) {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
