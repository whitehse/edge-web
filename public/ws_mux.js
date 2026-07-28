/**
 * Shared multiplexed WebSocket client for edgehost SPAs.
 *
 * One connection per page (or app). PDUs:
 *   { v:1, ch, op, id, body }
 * Legacy STATE_CHANGED frames (no v/ch) are re-dispatched as ch="state".
 *
 * Usage:
 *   EdgeMux.connect();
 *   EdgeMux.on("flows", function(msg) { ... });
 *   EdgeMux.send("flows", "list", { router_id: "router", hours: 24 });
 *   EdgeMux.watch("flows", "list", { router_id: "router" });
 */
(function (global) {
  var ws = null;
  var handlers = {}; /* ch -> [fn] */
  var pending = {}; /* id -> {resolve,reject,timer} */
  var rid = 1;
  var reconnectTimer = null;
  var wantOpen = false;
  var statusListeners = [];

  function nextId(prefix) {
    return (prefix || "c") + "-" + rid++ + "-" + Date.now().toString(36);
  }

  function notifyStatus(st) {
    for (var i = 0; i < statusListeners.length; i++) {
      try {
        statusListeners[i](st);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function url() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/api/v1/stream?topics=mux,state";
  }

  function dispatch(msg) {
    if (!msg || typeof msg !== "object") return;
    var ch = msg.ch;
    if (!ch && msg.type === "STATE_CHANGED") {
      ch = "state";
      msg = {
        v: 1,
        ch: "state",
        op: "STATE_CHANGED",
        id: msg.request_id || "",
        body: msg
      };
    }
    if (!ch) return;

    /* Resolve request/response */
    if (msg.id && pending[msg.id]) {
      var p = pending[msg.id];
      clearTimeout(p.timer);
      delete pending[msg.id];
      if (msg.op === "error" || (msg.body && msg.body.ok === false)) {
        p.reject(msg);
      } else {
        p.resolve(msg);
      }
    }

    var list = handlers[ch] || [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](msg);
      } catch (e) {
        console.error("EdgeMux handler", ch, e);
      }
    }
    var any = handlers["*"] || [];
    for (i = 0; i < any.length; i++) {
      try {
        any[i](msg);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function connect() {
    wantOpen = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    notifyStatus("connecting");
    try {
      ws = new WebSocket(url());
    } catch (e) {
      notifyStatus("error");
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      notifyStatus("open");
      EdgeMux.send("sys", "hello", {});
    };
    ws.onclose = function () {
      ws = null;
      notifyStatus("closed");
      if (wantOpen) scheduleReconnect();
    };
    ws.onerror = function () {
      notifyStatus("error");
    };
    ws.onmessage = function (ev) {
      var raw = ev.data;
      var msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }
      dispatch(msg);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (wantOpen) connect();
    }, 2000);
  }

  function close() {
    wantOpen = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
      ws = null;
    }
    notifyStatus("closed");
  }

  function send(ch, op, body, id) {
    if (!id) id = nextId(ch);
    var frame = {
      v: 1,
      ch: ch,
      op: op,
      id: id,
      body: body || {}
    };
    if (!ws || ws.readyState !== 1) {
      connect();
      /* queue briefly */
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (ws && ws.readyState === 1) {
          clearInterval(t);
          ws.send(JSON.stringify(frame));
        } else if (tries > 50) {
          clearInterval(t);
        }
      }, 50);
      return id;
    }
    ws.send(JSON.stringify(frame));
    return id;
  }

  function request(ch, op, body, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextId(ch);
      var ms = timeoutMs || 15000;
      pending[id] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          reject({ op: "error", body: { error: "timeout" }, id: id });
        }, ms)
      };
      send(ch, op, body, id);
    });
  }

  var EdgeMux = {
    connect: connect,
    close: close,
    send: send,
    request: request,
    on: function (ch, fn) {
      if (!handlers[ch]) handlers[ch] = [];
      handlers[ch].push(fn);
    },
    off: function (ch, fn) {
      var list = handlers[ch] || [];
      handlers[ch] = list.filter(function (f) {
        return f !== fn;
      });
    },
    onStatus: function (fn) {
      statusListeners.push(fn);
    },
    readyState: function () {
      return ws ? ws.readyState : 3;
    },
    /** Convenience: watch channel mode (list/series/both). */
    watch: function (ch, mode, body) {
      var b = Object.assign({}, body || {}, { mode: mode || "list" });
      return send(ch, "watch", b);
    },
    unwatch: function (ch, mode) {
      return send(ch, "unwatch", { mode: mode || "both" });
    }
  };

  global.EdgeMux = EdgeMux;
})(window);
