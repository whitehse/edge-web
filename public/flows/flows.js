/* CPE flow visualizer — top talkers + defects, scroll-stable live updates. */
(function () {
  var state = {
    flows: [],
    selectedKey: null,
    series: null,
    labelFilter: "",
    sortMode: "rate",
    hoverIdx: -1,
    wsStatus: "init",
    drawPending: false,
    collapsedClients: {}, /* client key -> true if collapsed */
    overlay: {}, /* flowKey -> { flow, points, color } */
    overlayOrder: [],
    overlayHidden: {}, /* key -> true to dim */
    scrubFrac: 1, /* 0..1, 1 = live (window end) */
    scrubMs: null, /* absolute ms when scrubbing; null = live */
    t0: null,
    t1: null,
    clientFilter: "", /* filter list by lan_ip when pill clicked */
    overlayTimer: null,
    overlayBusy: false,
    prevRates: {}, /* flowKey -> combined rate for flash-on-change */
    ageTicker: null
  };

  var OVERLAY_COLORS = [
    "#6b8cff",
    "#c4788a",
    "#4ecf9a",
    "#e6b84d",
    "#9b7bff",
    "#5ec8d6",
    "#e88a5a",
    "#a0a8b8"
  ];

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || "").trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " MiB";
    return (n / 1073741824).toFixed(2) + " GiB";
  }

  function fmtRate(bps) {
    bps = Number(bps) || 0;
    if (bps < 1000) return bps.toFixed(0) + " bps";
    if (bps < 1e6) return (bps / 1000).toFixed(1) + " kbps";
    if (bps < 1e9) return (bps / 1e6).toFixed(2) + " Mbps";
    return (bps / 1e9).toFixed(2) + " Gbps";
  }

  function fmtWin(w) {
    w = Number(w) || 0;
    if (w <= 0) return "—";
    if (w < 1024) return w + " B";
    return (w / 1024).toFixed(1) + " KiB";
  }

  /** Relative age for live UI (e.g. "live", "3s", "2m"). */
  function fmtAge(ts, nowMs) {
    var t = parseTs(ts);
    if (isNaN(t)) return "—";
    var sec = Math.max(0, ((nowMs || Date.now()) - t) / 1000);
    if (sec < 3) return "live";
    if (sec < 60) return Math.floor(sec) + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
  }

  function ratePct(bps, maxBps) {
    maxBps = maxBps || 1;
    bps = Number(bps) || 0;
    if (maxBps <= 0) return 0;
    return Math.min(100, (bps / maxBps) * 100);
  }

  function protoName(p) {
    p = Number(p);
    if (p === 6) return "TCP";
    if (p === 17) return "UDP";
    if (p === 1) return "ICMP";
    return String(p || "—");
  }

  function flowKey(f) {
    return (f.router_id || "") + "\t" + (f.flow_id || "");
  }

  function totalRate(f) {
    return (Number(f.rate_down_bps) || 0) + (Number(f.rate_up_bps) || 0);
  }

  function totalBytes(f) {
    return (Number(f.bytes_down) || 0) + (Number(f.bytes_up) || 0);
  }

  function labelClass(cls) {
    cls = (cls || "other").toLowerCase();
    if (cls === "ott" || cls === "cdn" || cls === "dns" || cls === "cloud") {
      return "class-" + cls;
    }
    return "";
  }

  /**
   * Defect heuristics from flow fields + soft-joined cpe_tcp_stats (per remote IP):
   *  - retrans: syn_retrans / loss_hint from NFLOG TCP control plane
   *  - rst: elevated resets toward that remote
   *  - throttle: TCP window collapsed while still carrying rate
   *  - closed: destroy / closed event
   *  - hot: among top bandwidth users
   *  - asymm: one direction dominates while windows are tiny
   */
  function analyzeFlow(f, maxRate) {
    var tags = [];
    var sev = 0; /* 0 ok, 1 warn, 2 bad */
    var rate = totalRate(f);
    var wu = Number(f.win_up) || 0;
    var wd = Number(f.win_down) || 0;
    var minWin = 0;
    var ev = String(f.event || "").toLowerCase();
    var isTcp = Number(f.proto) === 6;
    var retrans = Number(f.syn_retrans) || 0;
    var rst = Number(f.rst) || 0;
    var loss = Number(f.loss_hint) || 0;
    var tcpPkts = Number(f.tcp_pkts) || 0;
    var score = 0; /* for defects sort */

    if (wu > 0 && wd > 0) minWin = Math.min(wu, wd);
    else minWin = wu || wd;

    if (retrans >= 5 || loss >= 0.15) {
      tags.push({
        cls: "tag-retrans",
        text:
          retrans > 0
            ? "retrans " + retrans
            : "loss " + (loss * 100).toFixed(0) + "%"
      });
      sev = Math.max(sev, retrans >= 20 || loss >= 0.3 ? 2 : 1);
      score += 40 + Math.min(40, retrans) + Math.min(20, loss * 100);
    } else if (retrans > 0 || loss >= 0.05) {
      tags.push({
        cls: "tag-retrans",
        text:
          "retrans " +
          retrans +
          (loss > 0 ? " · loss " + (loss * 100).toFixed(0) + "%" : "")
      });
      sev = Math.max(sev, 1);
      score += 15 + retrans;
    }

    if (rst >= 10) {
      tags.push({ cls: "tag-rst", text: "rst " + rst });
      sev = Math.max(sev, rst >= 50 ? 2 : 1);
      score += 20 + Math.min(30, rst / 2);
    } else if (rst >= 3) {
      tags.push({ cls: "tag-rst", text: "rst " + rst });
      sev = Math.max(sev, 1);
      score += 8;
    }

    if (ev === "destroy" || ev === "closed" || ev === "close") {
      tags.push({ cls: "tag-closed", text: "closed" });
      sev = Math.max(sev, 1);
      score += 5;
    }

    if (isTcp && minWin > 0 && minWin < 4096 && rate > 50000) {
      tags.push({ cls: "tag-throttle", text: "throttle / tiny window" });
      sev = Math.max(sev, minWin < 1024 ? 2 : 1);
      score += minWin < 1024 ? 30 : 18;
    } else if (isTcp && minWin > 0 && minWin < 16384 && rate > 5e5) {
      tags.push({ cls: "tag-throttle", text: "window pressure" });
      sev = Math.max(sev, 1);
      score += 10;
    }

    if (maxRate > 0 && rate >= maxRate * 0.6 && rate > 1e5) {
      tags.push({ cls: "tag-hot", text: "top talker" });
      score += 3;
    }

    var rd = Number(f.rate_down_bps) || 0;
    var ru = Number(f.rate_up_bps) || 0;
    if (
      rd > 1e6 &&
      ru > 0 &&
      ru < rd * 0.02 &&
      isTcp &&
      minWin > 0 &&
      minWin < 8192
    ) {
      tags.push({ cls: "tag-asymm", text: "asymm + window" });
      sev = Math.max(sev, 1);
      score += 8;
    }

    return {
      tags: tags,
      sev: sev,
      rate: rate,
      bytes: totalBytes(f),
      retrans: retrans,
      rst: rst,
      loss: loss,
      tcpPkts: tcpPkts,
      score: score
    };
  }

  function parseTs(ts) {
    if (ts == null || ts === "") return NaN;
    if (typeof ts === "number") return ts;
    var s = String(ts).trim().replace(" ", "T");
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
    var ms = Date.parse(s);
    return isNaN(ms) ? NaN : ms;
  }

  function fmtLocalTs(ts, style) {
    var ms = parseTs(ts);
    if (isNaN(ms)) {
      return ts == null || ts === "" ? "—" : String(ts);
    }
    var d = new Date(ms);
    style = style || "datetime";
    try {
      if (style === "time") {
        return d.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        });
      }
      if (style === "date") {
        return d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        });
      }
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });
    } catch (e) {
      return d.toString();
    }
  }

  function buildAxis(pts) {
    var n = pts.length;
    var times = new Array(n);
    var i, valid = 0, tmin = Infinity, tmax = -Infinity;
    for (i = 0; i < n; i++) {
      var t = parseTs(pts[i].ts);
      times[i] = t;
      if (!isNaN(t)) {
        valid++;
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
      }
    }
    if (valid < 2 || !(tmax > tmin)) {
      for (i = 0; i < n; i++) times[i] = i;
      return { times: times, t0: 0, t1: Math.max(n - 1, 1), mode: "index" };
    }
    for (i = 0; i < n; i++) {
      if (isNaN(times[i])) times[i] = i === 0 ? tmin : times[i - 1];
    }
    return { times: times, t0: tmin, t1: tmax, mode: "time" };
  }

  function robustMax(values) {
    var xs = values.filter(function (v) {
      return v > 0 && isFinite(v);
    });
    if (!xs.length) return 1;
    xs.sort(function (a, b) {
      return a - b;
    });
    var p95 = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
    var mx = xs[xs.length - 1];
    if (p95 > 0 && mx > p95 * 5) return p95 * 1.25;
    return mx;
  }

  function filterBody() {
    var ridEl = $("filterRouter");
    var hoursEl = $("filterHours");
    var limitEl = $("filterLimit");
    var qEl = $("filterQ");
    var rid = (ridEl && ridEl.value ? ridEl.value : "").trim();
    var hours = parseInt(hoursEl && hoursEl.value, 10) || 24;
    var limit = parseInt(limitEl && limitEl.value, 10) || 40;
    var q = (qEl && qEl.value ? qEl.value : "").trim();
    var body = { hours: hours, limit: limit };
    if (rid) body.router_id = rid;
    if (state.labelFilter) body.label = state.labelFilter;
    if (q) body.q = q;
    if (state.clientFilter) {
      body.q = state.clientFilter + (q ? " " + q : "");
    }
    return body;
  }

  function setStatus(s) {
    if ($("statusLine")) $("statusLine").textContent = s;
  }

  function maxRateAmong(flows) {
    var m = 0;
    var i;
    for (i = 0; i < flows.length; i++) {
      m = Math.max(m, totalRate(flows[i]));
    }
    return m;
  }

  function sortedFlows(flows) {
    var maxR = maxRateAmong(flows);
    var mode = state.sortMode || "rate";
    var rows = flows.slice();
    rows.sort(function (a, b) {
      var aa = analyzeFlow(a, maxR);
      var bb = analyzeFlow(b, maxR);
      if (mode === "defects") {
        if (bb.sev !== aa.sev) return bb.sev - aa.sev;
        if (bb.score !== aa.score) return bb.score - aa.score;
        if (bb.retrans !== aa.retrans) return bb.retrans - aa.retrans;
        return bb.rate - aa.rate;
      }
      if (mode === "bytes") return bb.bytes - aa.bytes;
      if (mode === "recent") {
        var ta = parseTs(a.ts) || 0;
        var tb = parseTs(b.ts) || 0;
        return tb - ta;
      }
      /* rate default */
      return bb.rate - aa.rate;
    });
    return rows;
  }

  function renderSummary(flows) {
    var maxR = maxRateAmong(flows);
    var sumR = 0;
    var defects = 0;
    var sumRetrans = 0;
    var sumRst = 0;
    var top = null;
    var topR = -1;
    var worstLoss = null;
    var alerts = [];
    var i, a, f, name;

    for (i = 0; i < flows.length; i++) {
      f = flows[i];
      a = analyzeFlow(f, maxR);
      sumR += a.rate;
      sumRetrans += a.retrans;
      sumRst += a.rst;
      if (a.sev > 0) defects++;
      if (a.rate > topR) {
        topR = a.rate;
        top = f;
      }
      if (
        a.loss > 0 &&
        (!worstLoss || a.loss > worstLoss.loss || a.retrans > worstLoss.retrans)
      ) {
        worstLoss = { f: f, loss: a.loss, retrans: a.retrans };
      }
      name =
        f.remote_label && f.remote_label !== "unknown"
          ? f.remote_label
          : f.remote_ip || "flow";
      if (a.sev >= 2) {
        alerts.push({
          sev: "bad",
          t:
            name +
            ": " +
            a.tags
              .map(function (t) {
                return t.text;
              })
              .join(", ")
        });
      } else if (a.sev === 1 && alerts.length < 8) {
        alerts.push({
          sev: "warn",
          t:
            name +
            ": " +
            a.tags
              .map(function (t) {
                return t.text;
              })
              .join(", ")
        });
      }
    }

    if (top) {
      $("fsTopVal").textContent =
        (top.remote_label && top.remote_label !== "unknown"
          ? top.remote_label
          : top.remote_ip || "—") +
        " · " +
        fmtRate(topR);
      $("fsTopSub").textContent =
        (top.remote_ip || "") +
        (top.remote_port ? ":" + top.remote_port : "") +
        " · " +
        fmtBytes(totalBytes(top)) +
        " total";
    } else {
      $("fsTopVal").textContent = "—";
      $("fsTopSub").textContent = "highest combined rate";
    }

    $("fsBwVal").textContent = fmtRate(sumR);
    $("fsBwSub").textContent =
      flows.length + " streams · ↓+↑ live rates summed";

    var defEl = $("fsDefects");
    $("fsDefVal").textContent = defects + " / " + flows.length;
    $("fsDefSub").textContent =
      defects === 0
        ? "no retrans / throttle / window flags"
        : "retrans " +
          sumRetrans +
          " · rst " +
          sumRst +
          " · (TCP stats joined by remote IP)";
    if (defEl) {
      defEl.setAttribute(
        "data-level",
        defects === 0 ? "ok" : defects > flows.length * 0.25 ? "bad" : "warn"
      );
    }

    if (!alerts.length) {
      alerts.push({
        sev: "ok",
        t: "No retrans, RST, throttle, or window defects on listed streams"
      });
    }
    if (worstLoss && (worstLoss.retrans > 0 || worstLoss.loss >= 0.05)) {
      alerts.unshift({
        sev: worstLoss.retrans >= 20 || worstLoss.loss >= 0.3 ? "bad" : "warn",
        t:
          "Highest loss/retrans: " +
          (worstLoss.f.remote_label && worstLoss.f.remote_label !== "unknown"
            ? worstLoss.f.remote_label
            : worstLoss.f.remote_ip) +
          " · retrans " +
          worstLoss.retrans +
          (worstLoss.loss > 0
            ? " · loss hint " + (worstLoss.loss * 100).toFixed(1) + "%"
            : "")
      });
    }
    if (top && topR > 0) {
      alerts.unshift({
        sev: "ok",
        t:
          "Heaviest: " +
          fmtRate(topR) +
          " on " +
          (top.remote_label || top.remote_ip)
      });
    }
    $("fsAlertList").innerHTML = alerts
      .slice(0, 6)
      .map(function (x) {
        return '<li class="sev-' + x.sev + '">' + esc(x.t) + "</li>";
      })
      .join("");
  }

  function clientKey(f) {
    var ip = (f && f.lan_ip ? String(f.lan_ip) : "").trim();
    return ip || "unknown";
  }

  function groupFlowsByClient(flows) {
    var map = {};
    var keys = [];
    var i, k, f, g, info, maxR;
    maxR = maxRateAmong(flows) || 1;
    for (i = 0; i < flows.length; i++) {
      f = flows[i];
      k = clientKey(f);
      if (!map[k]) {
        map[k] = {
          key: k,
          flows: [],
          rate: 0,
          bytes: 0,
          defects: 0,
          score: 0
        };
        keys.push(k);
      }
      g = map[k];
      g.flows.push(f);
      info = analyzeFlow(f, maxR);
      g.rate += info.rate;
      g.bytes += info.bytes;
      if (info.sev > 0) g.defects++;
      g.score += info.score;
    }
    keys.sort(function (a, b) {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      var ga = map[a];
      var gb = map[b];
      var mode = state.sortMode || "rate";
      if (mode === "bytes") return gb.bytes - ga.bytes;
      if (mode === "defects") {
        if (gb.defects !== ga.defects) return gb.defects - ga.defects;
        return gb.score - ga.score;
      }
      if (mode === "recent") {
        var ta = 0;
        var tb = 0;
        var j;
        for (j = 0; j < ga.flows.length; j++) {
          ta = Math.max(ta, parseTs(ga.flows[j].ts) || 0);
        }
        for (j = 0; j < gb.flows.length; j++) {
          tb = Math.max(tb, parseTs(gb.flows[j].ts) || 0);
        }
        return tb - ta;
      }
      return gb.rate - ga.rate;
    });
    return { map: map, keys: keys };
  }

  function isGroupCollapsed(client) {
    if (!state.collapsedClients) state.collapsedClients = {};
    /* Default: expanded. Collapsed only if explicitly true. */
    return state.collapsedClients[client] === true;
  }

  function toggleGroup(client) {
    if (!state.collapsedClients) state.collapsedClients = {};
    state.collapsedClients[client] = !isGroupCollapsed(client);
    renderList(state.flows);
  }

  function renderList(flows) {
    var root = $("streamList");
    if (!root) return;
    var scrollTop = root.scrollTop;
    var nowMs = Date.now();
    if (!flows || !flows.length) {
      root.innerHTML =
        '<div class="fl-empty">No streams yet — waiting for live data…</div>';
      renderClientStrip([]);
      return;
    }
    var ordered = sortedFlows(flows);
    var maxR = maxRateAmong(ordered) || 1;
    var maxDown = 1;
    var maxUp = 1;
    var mi;
    for (mi = 0; mi < ordered.length; mi++) {
      maxDown = Math.max(maxDown, Number(ordered[mi].rate_down_bps) || 0);
      maxUp = Math.max(maxUp, Number(ordered[mi].rate_up_bps) || 0);
    }
    var groups = groupFlowsByClient(ordered);
    var html = "";
    var gi, i;
    var nextRates = {};
    for (gi = 0; gi < groups.keys.length; gi++) {
      var ck = groups.keys[gi];
      var g = groups.map[ck];
      var collapsed = isGroupCollapsed(ck);
      var gFlows = sortedFlows(g.flows);
      var gSev = 0;
      for (i = 0; i < gFlows.length; i++) {
        gSev = Math.max(gSev, analyzeFlow(gFlows[i], maxR).sev);
      }
      var title = ck === "unknown" ? "Unknown client" : ck;
      var sub =
        gFlows.length +
        " stream" +
        (gFlows.length === 1 ? "" : "s") +
        " · " +
        fmtRate(g.rate) +
        (g.defects
          ? " · " + g.defects + " issue" + (g.defects === 1 ? "" : "s")
          : "");
      html +=
        '<section class="fl-group' +
        (ck === "unknown" ? " is-unknown" : "") +
        (g.defects ? " has-defect" : "") +
        (gSev >= 2 ? " sev-bad" : "") +
        (collapsed ? " is-collapsed" : "") +
        '" data-client="' +
        esc(ck) +
        '">' +
        '<button type="button" class="fl-group-hd" data-client="' +
        esc(ck) +
        '" aria-expanded="' +
        (collapsed ? "false" : "true") +
        '">' +
        '<div class="fl-group-hd-row">' +
        '<span class="fl-group-chev" aria-hidden="true">' +
        (collapsed ? "▸" : "▾") +
        "</span>" +
        '<span class="fl-group-ip">' +
        esc(title) +
        "</span>" +
        "</div>" +
        '<div class="fl-group-sub">' +
        esc(sub) +
        "</div>" +
        "</button>" +
        '<div class="fl-group-body"' +
        (collapsed ? " hidden" : "") +
        ">";
      for (i = 0; i < gFlows.length; i++) {
        var f = gFlows[i];
        var key = flowKey(f);
        var sel = key === state.selectedKey ? " is-selected" : "";
        var lab = f.remote_label || "unknown";
        var info = analyzeFlow(f, maxR);
        var defectCls =
          info.sev > 0
            ? " has-defect" + (info.sev >= 2 ? " sev-bad" : "")
            : "";
        var age = fmtAge(f.ts, nowMs);
        var isLive = age === "live";
        var comb = totalRate(f);
        nextRates[key] = comb;
        var fresh =
          state.prevRates[key] != null &&
          Math.abs(state.prevRates[key] - comb) > 1
            ? " is-fresh"
            : "";
        var downPct = ratePct(f.rate_down_bps, maxDown);
        var upPct = ratePct(f.rate_up_bps, maxUp);
        var remote =
          (f.remote_ip || "?") + (f.remote_port ? ":" + f.remote_port : "");
        var tagsHtml = "";
        var ti;
        for (ti = 0; ti < Math.min(3, info.tags.length); ti++) {
          var tg = info.tags[ti];
          tagsHtml +=
            '<span class="fl-tag ' +
            esc(tg.cls || "") +
            '">' +
            esc(tg.text) +
            "</span>";
        }
        html +=
          '<button type="button" class="fl-card' +
          sel +
          defectCls +
          fresh +
          '" data-key="' +
          esc(key) +
          '" data-ts="' +
          esc(f.ts || "") +
          '">' +
          '<div class="fl-card-head">' +
          '<div class="fl-card-head-top">' +
          '<span class="fl-card-name">' +
          esc(lab) +
          "</span>" +
          '<span class="fl-pill">' +
          esc(protoName(f.proto)) +
          "</span>" +
          (isLive
            ? '<span class="fl-pill is-live" data-live-pill>' +
              '<span class="fl-pill-dot" aria-hidden="true"></span>' +
              '<span data-age>live</span></span>'
            : '<span class="fl-pill" data-live-pill><span data-age>' +
              esc(age) +
              "</span></span>") +
          "</div>" +
          '<div class="fl-card-ip">' +
          esc(remote) +
          "</div>" +
          "</div>" +
          '<div class="fl-card-rates">' +
          '<div class="fl-rate">' +
          '<div class="fl-rate-row">' +
          '<span class="fl-rate-dir">Down</span>' +
          '<span class="fl-rate-num">' +
          esc(fmtRate(f.rate_down_bps)) +
          "</span></div>" +
          '<div class="fl-bar is-down"><i style="width:' +
          downPct.toFixed(1) +
          '%"></i></div>' +
          "</div>" +
          '<div class="fl-rate">' +
          '<div class="fl-rate-row">' +
          '<span class="fl-rate-dir">Up</span>' +
          '<span class="fl-rate-num">' +
          esc(fmtRate(f.rate_up_bps)) +
          "</span></div>" +
          '<div class="fl-bar is-up"><i style="width:' +
          upPct.toFixed(1) +
          '%"></i></div>' +
          "</div>" +
          "</div>" +
          (tagsHtml
            ? '<div class="fl-card-tags">' + tagsHtml + "</div>"
            : "") +
          "</button>";
      }
      html += "</div></section>";
    }
    root.innerHTML = html;
    root.scrollTop = scrollTop;
    state.prevRates = nextRates;
    root.querySelectorAll(".fl-group-hd").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        toggleGroup(btn.getAttribute("data-client"));
      });
    });
    root.querySelectorAll(".fl-card").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectKey(btn.getAttribute("data-key"));
      });
    });
    if ($("listMeta")) {
      var newest = newestFlowMs(ordered);
      var ageSec = newest ? Math.max(0, (nowMs - newest) / 1000) : 0;
      $("listMeta").innerHTML =
        (ageSec < 3
          ? '<span class="status-live">live</span> · '
          : "") +
        groups.keys.length +
        " client" +
        (groups.keys.length === 1 ? "" : "s") +
        " · " +
        ordered.length +
        " streams · j/k";
    }
    renderSummary(ordered);
    renderClientStrip(ordered);
    scheduleOverlayRefresh();
    ensureAgeTicker();
  }

  function tickStreamAges() {
    var root = $("streamList");
    if (!root) return;
    var nowMs = Date.now();
    root.querySelectorAll(".fl-card[data-ts]").forEach(function (el) {
      var ageEl = el.querySelector("[data-age]");
      var pill = el.querySelector("[data-live-pill]");
      if (!ageEl || !pill) return;
      var age = fmtAge(el.getAttribute("data-ts"), nowMs);
      var isLive = age === "live";
      ageEl.textContent = age;
      pill.classList.toggle("is-live", isLive);
      var dot = pill.querySelector(".fl-pill-dot");
      if (isLive && !dot) {
        var d = document.createElement("span");
        d.className = "fl-pill-dot";
        d.setAttribute("aria-hidden", "true");
        pill.insertBefore(d, ageEl);
      } else if (!isLive && dot) {
        dot.remove();
      }
    });
  }

  function ensureAgeTicker() {
    if (state.ageTicker) return;
    state.ageTicker = setInterval(tickStreamAges, 1000);
  }

  function renderClientStrip(flows) {
    var root = $("clientStrip");
    var meta = $("clientsMeta");
    if (!root) return;
    if (!flows || !flows.length) {
      root.innerHTML =
        '<span class="flow-client-empty">No active clients in this window.</span>';
      if (meta) meta.textContent = "0 clients";
      return;
    }
    var groups = groupFlowsByClient(flows);
    var maxR = 1;
    var i;
    for (i = 0; i < groups.keys.length; i++) {
      maxR = Math.max(maxR, groups.map[groups.keys[i]].rate);
    }
    var html = "";
    var shown = 0;
    for (i = 0; i < groups.keys.length; i++) {
      var ck = groups.keys[i];
      if (ck === "unknown") continue;
      var g = groups.map[ck];
      var sev = 0;
      var j;
      for (j = 0; j < g.flows.length; j++) {
        sev = Math.max(sev, analyzeFlow(g.flows[j], maxR).sev);
      }
      var act = state.clientFilter === ck ? " active" : "";
      html +=
        '<button type="button" class="flow-client-pill' +
        act +
        '" data-client="' +
        esc(ck) +
        '" data-sev="' +
        sev +
        '" role="listitem" title="Filter streams for this client">' +
        '<span class="cq-dot" aria-hidden="true"></span>' +
        '<span class="cq-name">' +
        esc(ck) +
        "</span>" +
        '<span class="cq-meta">' +
        g.flows.length +
        " · " +
        esc(fmtRate(g.rate)) +
        (sev ? (sev >= 2 ? " · problem" : " · watch") : " · ok") +
        "</span></button>";
      shown++;
    }
    if (!html) {
      html =
        '<span class="flow-client-empty">Clients appear when LAN IPs are present on streams.</span>';
    }
    root.innerHTML = html;
    if (meta) {
      meta.textContent =
        shown +
        " client" +
        (shown === 1 ? "" : "s") +
        (state.clientFilter ? " · filtered " + state.clientFilter : "");
    }
    root.querySelectorAll(".flow-client-pill").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var c = btn.getAttribute("data-client") || "";
        state.clientFilter = state.clientFilter === c ? "" : c;
        renderList(state.flows);
      });
    });
  }

  function scheduleOverlayRefresh() {
    if (state.overlayTimer) clearTimeout(state.overlayTimer);
    state.overlayTimer = setTimeout(function () {
      state.overlayTimer = null;
      refreshOverlaySeries();
    }, 400);
  }

  async function refreshOverlaySeries() {
    if (state.overlayBusy) return;
    var ordered = sortedFlows(state.flows);
    if (!ordered.length) {
      state.overlay = {};
      state.overlayOrder = [];
      drawOverlay();
      return;
    }
    state.overlayBusy = true;
    var hours = parseInt($("filterHours") && $("filterHours").value, 10) || 24;
    var top = ordered.slice(0, 8);
    var next = {};
    var order = [];
    var i;
    try {
      for (i = 0; i < top.length; i++) {
        var f = top[i];
        var key = flowKey(f);
        var url =
          "/api/v1/flows/series?router_id=" +
          encodeURIComponent(f.router_id || "") +
          "&flow_id=" +
          encodeURIComponent(f.flow_id || "") +
          "&hours=" +
          hours +
          "&limit=200";
        try {
          var r = await fetch(url, { credentials: "same-origin" });
          var j = await r.json();
          if (r.ok && j && Array.isArray(j.points)) {
            next[key] = {
              flow: f,
              points: j.points,
              color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
              artifacts: j.artifacts || {}
            };
            order.push(key);
          }
        } catch (e) {
          /* skip this flow */
        }
      }
      state.overlay = next;
      state.overlayOrder = order;
      updateTimeBounds();
      drawOverlay();
      if ($("overlayMeta")) {
        $("overlayMeta").textContent =
          order.length + " streams overlaid · scrub to step back in time";
      }
    } finally {
      state.overlayBusy = false;
    }
  }

  function updateTimeBounds() {
    var t0 = Infinity;
    var t1 = -Infinity;
    var i, k, pts, j, t;
    for (i = 0; i < state.overlayOrder.length; i++) {
      k = state.overlayOrder[i];
      pts = (state.overlay[k] && state.overlay[k].points) || [];
      for (j = 0; j < pts.length; j++) {
        t = parseTs(pts[j].ts);
        if (isNaN(t)) continue;
        if (t < t0) t0 = t;
        if (t > t1) t1 = t;
      }
    }
    if (!(t1 > t0)) {
      state.t0 = Date.now() - 3600e3;
      state.t1 = Date.now();
    } else {
      state.t0 = t0;
      state.t1 = t1;
    }
    applyScrubFromFrac();
  }

  function applyScrubFromFrac() {
    var frac = state.scrubFrac;
    if (frac == null || frac >= 0.995) {
      state.scrubMs = null;
      if ($("scrubLabel")) $("scrubLabel").textContent = "now (live)";
      return;
    }
    var t0 = state.t0 || Date.now() - 3600e3;
    var t1 = state.t1 || Date.now();
    state.scrubMs = t0 + (t1 - t0) * frac;
    if ($("scrubLabel")) {
      $("scrubLabel").textContent = fmtLocalTs(state.scrubMs, "datetime");
    }
  }

  function drawOverlay() {
    drawOverlayRates();
    drawDefectTimeline();
    drawOverlayLegend();
  }

  function drawOverlayRates() {
    var canvas = $("overlayChart");
    if (!canvas) return;
    /* Prefer chart_view when embed module loaded (top streams as series). */
    if (
      window.EdgeChartEmbed &&
      typeof EdgeChartEmbed.plot === "function" &&
      state.overlayOrder &&
      state.overlayOrder.length
    ) {
      var ptsMap = {};
      var seriesDefs = [];
      var i, k, entry, j, t, rate, pt;
      var t0 = state.t0 || Date.now() - 3600e3;
      var t1 = state.t1 || Date.now();
      var maxStreams = 8;
      for (i = 0; i < state.overlayOrder.length && seriesDefs.length < maxStreams; i++) {
        k = state.overlayOrder[i];
        if (state.overlayHidden[k]) continue;
        entry = state.overlay[k];
        if (!entry || !entry.points || !entry.points.length) continue;
        var key = "s" + seriesDefs.length;
        seriesDefs.push({
          key: key,
          label: (entry.label || k).slice(0, 28),
          color: entry.color || OVERLAY_COLORS[seriesDefs.length % OVERLAY_COLORS.length]
        });
        for (j = 0; j < entry.points.length; j++) {
          t = parseTs(entry.points[j].ts);
          if (isNaN(t)) continue;
          rate =
            (Number(entry.points[j].rate_down_bps) || 0) +
            (Number(entry.points[j].rate_up_bps) || 0);
          pt = ptsMap[t] || { ts: t };
          pt[key] = rate;
          ptsMap[t] = pt;
        }
      }
      var pts = Object.keys(ptsMap)
        .map(function (x) {
          return ptsMap[x];
        })
        .sort(function (a, b) {
          return a.ts - b.ts;
        });
      if (pts.length && seriesDefs.length) {
        EdgeChartEmbed.plot(canvas, pts, seriesDefs, {
          height: 200,
          t0: t0,
          t1: t1,
          live: true,
          windowMinutes: Math.max(1, (t1 - t0) / 60000),
          emptyMsg: "Waiting for stream series…"
        });
        return;
      }
    }
    var g = setupCanvas(canvas, 200);
    var ctx = g.ctx;
    var cssW = g.w;
    var cssH = g.h;
    var pad = { l: 52, r: 12, t: 12, b: 26 };
    var plotW = cssW - pad.l - pad.r;
    var plotH = cssH - pad.t - pad.b;
    ctx.fillStyle = cssVar("--chart-plot", "rgba(15,18,24,0.25)");
    ctx.fillRect(pad.l, pad.t, plotW, plotH);

    var t0 = state.t0 || Date.now() - 3600e3;
    var t1 = state.t1 || Date.now();
    if (!(t1 > t0)) t1 = t0 + 1;

    function xAt(ms) {
      return pad.l + ((ms - t0) / (t1 - t0)) * plotW;
    }
    function yAt(r, axisMax) {
      return pad.t + plotH - (Math.min(r, axisMax) / axisMax) * plotH;
    }

    var allRates = [];
    var i, k, entry, pts, j, rate;
    for (i = 0; i < state.overlayOrder.length; i++) {
      k = state.overlayOrder[i];
      if (state.overlayHidden[k]) continue;
      entry = state.overlay[k];
      if (!entry) continue;
      pts = entry.points || [];
      for (j = 0; j < pts.length; j++) {
        rate =
          (Number(pts[j].rate_down_bps) || 0) +
          (Number(pts[j].rate_up_bps) || 0);
        if (rate > 0) allRates.push(rate);
      }
    }
    var axisMax = Math.max(robustMax(allRates), 1) * 1.05;

    /* grid */
    ctx.strokeStyle = cssVar("--chart-grid", "rgba(46,54,72,0.55)");
    ctx.lineWidth = 1;
    ctx.fillStyle = cssVar("--chart-label", "#7a756c");
    ctx.font = "10px IBM Plex Mono, monospace";
    for (i = 0; i <= 3; i++) {
      var gy = pad.t + (plotH * i) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(pad.l + plotW, gy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(fmtRate(axisMax * (1 - i / 3)), pad.l - 4, gy + 3);
    }
    ctx.textAlign = "left";

    if (!state.overlayOrder.length) {
      ctx.fillStyle = cssVar("--chart-label", "#7a756c");
      ctx.font = "12px Outfit, system-ui, sans-serif";
      ctx.fillText(
        "Waiting for stream series to build the overlay…",
        pad.l + 8,
        pad.t + 22
      );
      return;
    }

    /* draw each flow as thin line */
    for (i = 0; i < state.overlayOrder.length; i++) {
      k = state.overlayOrder[i];
      if (state.overlayHidden[k]) continue;
      entry = state.overlay[k];
      if (!entry || !entry.points || !entry.points.length) continue;
      pts = entry.points;
      ctx.beginPath();
      var started = false;
      for (j = 0; j < pts.length; j++) {
        var t = parseTs(pts[j].ts);
        if (isNaN(t)) continue;
        rate =
          (Number(pts[j].rate_down_bps) || 0) +
          (Number(pts[j].rate_up_bps) || 0);
        var x = xAt(t);
        var y = yAt(rate, axisMax);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = entry.color || OVERLAY_COLORS[0];
      ctx.globalAlpha = k === state.selectedKey ? 1 : 0.72;
      ctx.lineWidth = k === state.selectedKey ? 2 : 1.25;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* scrub cursor */
    var scrub = state.scrubMs != null ? state.scrubMs : t1;
    var sx = xAt(scrub);
    ctx.strokeStyle = cssVar("--text-soft", "#d4cfc6");
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sx, pad.t);
    ctx.lineTo(sx, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* x labels */
    ctx.fillStyle = cssVar("--chart-label", "#7a756c");
    ctx.font = "10px Outfit, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(fmtLocalTs(t0, "time"), pad.l, cssH - 6);
    ctx.textAlign = "right";
    ctx.fillText(fmtLocalTs(t1, "time"), pad.l + plotW, cssH - 6);
    ctx.textAlign = "left";
  }

  function drawDefectTimeline() {
    var canvas = $("defectTimeline");
    if (!canvas) return;
    var g = setupCanvas(canvas, 44);
    var ctx = g.ctx;
    var cssW = g.w;
    var cssH = g.h;
    var pad = { l: 52, r: 12, t: 6, b: 6 };
    var plotW = cssW - pad.l - pad.r;
    var plotH = cssH - pad.t - pad.b;
    ctx.fillStyle = cssVar("--chart-plot", "rgba(15,18,24,0.2)");
    ctx.fillRect(pad.l, pad.t, plotW, plotH);

    var t0 = state.t0 || Date.now() - 3600e3;
    var t1 = state.t1 || Date.now();
    if (!(t1 > t0)) t1 = t0 + 1;

    function xAt(ms) {
      return pad.l + ((ms - t0) / (t1 - t0)) * plotW;
    }

    ctx.fillStyle = cssVar("--chart-label", "#7a756c");
    ctx.font = "10px Outfit, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("defects", pad.l - 4, pad.t + plotH / 2 + 3);
    ctx.textAlign = "left";

    var marks = 0;
    var i, k, entry, pts, j, p, a;
    for (i = 0; i < state.overlayOrder.length; i++) {
      k = state.overlayOrder[i];
      entry = state.overlay[k];
      if (!entry) continue;
      pts = entry.points || [];
      a = entry.artifacts || {};
      /* destroy marker */
      if (a.destroy_ts) {
        var dt = parseTs(a.destroy_ts);
        if (!isNaN(dt)) {
          ctx.fillStyle = cssVar("--chart-defect", "#e87a82");
          ctx.globalAlpha = 0.85;
          ctx.fillRect(xAt(dt) - 1, pad.t, 2, plotH);
          marks++;
        }
      }
      for (j = 0; j < pts.length; j++) {
        p = pts[j];
        var retrans = Number(p.syn_retrans) || 0;
        var loss = Number(p.loss_hint) || 0;
        var win =
          Math.min(
            Number(p.win_down) || 1e12,
            Number(p.win_up) || 1e12
          );
        var rate =
          (Number(p.rate_down_bps) || 0) + (Number(p.rate_up_bps) || 0);
        var bad =
          retrans >= 3 ||
          loss >= 0.1 ||
          (win > 0 && win < 4096 && rate > 5e4) ||
          p.event === "destroy";
        if (!bad) continue;
        var t = parseTs(p.ts);
        if (isNaN(t)) continue;
        ctx.fillStyle = cssVar("--chart-defect", "#e87a82");
        ctx.globalAlpha = 0.55;
        ctx.fillRect(xAt(t) - 1.5, pad.t + 4, 3, plotH - 8);
        marks++;
      }
    }
    ctx.globalAlpha = 1;

    /* scrub */
    var scrub = state.scrubMs != null ? state.scrubMs : t1;
    ctx.strokeStyle = cssVar("--text-soft", "#d4cfc6");
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(xAt(scrub), pad.t);
    ctx.lineTo(xAt(scrub), pad.t + plotH);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (!marks) {
      ctx.fillStyle = cssVar("--chart-label", "#7a756c");
      ctx.font = "11px Outfit, sans-serif";
      ctx.fillText(
        "No defect markers in window (retrans / loss / tiny window / destroy)",
        pad.l + 6,
        pad.t + plotH / 2 + 4
      );
    }
  }

  function drawOverlayLegend() {
    var el = $("overlayLegend");
    if (!el) return;
    if (!state.overlayOrder.length) {
      el.innerHTML = "";
      return;
    }
    var html = "";
    var i;
    for (i = 0; i < state.overlayOrder.length; i++) {
      var k = state.overlayOrder[i];
      var entry = state.overlay[k];
      if (!entry) continue;
      var f = entry.flow || {};
      var name =
        f.remote_label && f.remote_label !== "unknown"
          ? f.remote_label
          : f.remote_ip || "flow";
      var dim = state.overlayHidden[k] ? " dim" : "";
      html +=
        '<span class="ol-item' +
        dim +
        '" data-key="' +
        esc(k) +
        '">' +
        '<span class="ol-swatch" style="background:' +
        esc(entry.color) +
        '"></span>' +
        esc(name) +
        (f.lan_ip ? " · " + esc(f.lan_ip) : "") +
        "</span>";
    }
    el.innerHTML = html;
    el.querySelectorAll(".ol-item").forEach(function (node) {
      node.addEventListener("click", function () {
        var key = node.getAttribute("data-key");
        if (!key) return;
        if (state.overlayHidden[key]) delete state.overlayHidden[key];
        else state.overlayHidden[key] = true;
        drawOverlay();
      });
      node.addEventListener("dblclick", function () {
        var key = node.getAttribute("data-key");
        if (key) selectKey(key);
      });
    });
  }

  function findFlowByKey(key) {
    var i;
    for (i = 0; i < state.flows.length; i++) {
      if (flowKey(state.flows[i]) === key) return state.flows[i];
    }
    return null;
  }

  function selectKey(key) {
    var f = findFlowByKey(key);
    if (!f) return;
    state.selectedKey = key;
    renderList(state.flows);
    watchSeries(f);
  }

  function selectIdx(idx) {
    var ordered = sortedFlows(state.flows);
    var f = ordered[idx];
    if (!f) return;
    selectKey(flowKey(f));
  }

  function selectByDelta(delta) {
    if (!state.flows.length) return;
    var ordered = sortedFlows(state.flows);
    var idx = 0;
    var i;
    for (i = 0; i < ordered.length; i++) {
      if (flowKey(ordered[i]) === state.selectedKey) {
        idx = i;
        break;
      }
    }
    idx = (idx + delta + ordered.length) % ordered.length;
    selectKey(flowKey(ordered[idx]));
  }

  function newestFlowMs(flows) {
    var newest = 0;
    var i;
    for (i = 0; i < (flows || []).length; i++) {
      var t = parseTs(flows[i].ts) || 0;
      if (t > newest) newest = t;
    }
    return newest;
  }

  function setRouterHint(html, visible) {
    var el = $("flowRouterHint");
    if (!el) return;
    if (!visible) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = html;
  }

  /** REST list — works even if WS mux is slow/blocked; also used for recovery. */
  function bootstrapListFromRest() {
    var body = filterBody();
    var q =
      "/api/v1/flows?hours=" +
      encodeURIComponent(body.hours || 24) +
      "&limit=" +
      encodeURIComponent(body.limit || 40);
    if (body.router_id) {
      q += "&router_id=" + encodeURIComponent(body.router_id);
    }
    if (body.label) {
      q += "&label=" + encodeURIComponent(body.label);
    }
    if (body.q) {
      q += "&q=" + encodeURIComponent(body.q);
    }
    return fetch(q, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) {
          return null;
        }
        onFlowsMsg({ op: "list", body: j });
        return j;
      })
      .catch(function () {
        return null;
      });
  }

  /**
   * If the selected CPE filter has no live streams, discover routers that do
   * (common lab mistake: EdgeContext still on fixture id "router").
   */
  function recoverLiveRouters(currentRid) {
    return fetch("/api/v1/flows?hours=1&limit=80", {
      credentials: "same-origin"
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var flows = (j && j.flows) || [];
        var by = {};
        var i;
        var now = Date.now();
        for (i = 0; i < flows.length; i++) {
          var rid = flows[i].router_id || "";
          if (!rid) continue;
          var t = parseTs(flows[i].ts) || 0;
          if (!by[rid] || t > by[rid]) by[rid] = t;
        }
        var live = Object.keys(by)
          .filter(function (r) {
            return now - by[r] < 120000; /* <2 min */
          })
          .sort(function (a, b) {
            return by[b] - by[a];
          });
        if (!live.length) {
          setRouterHint(
            "No live flow samples in the last 2 minutes for any CPE. " +
              "On the agent enable <code>flow_acct.enabled: true</code> and " +
              "<code>sysctl net.netfilter.nf_conntrack_acct=1</code>.",
            true
          );
          return;
        }
        if (currentRid && live.indexOf(currentRid) >= 0) {
          setRouterHint("", false);
          return;
        }
        var links = live
          .map(function (r) {
            return (
              '<button type="button" class="chip flow-router-pick" data-rid="' +
              esc(r) +
              '">' +
              esc(r) +
              "</button>"
            );
          })
          .join(" ");
        setRouterHint(
          (currentRid
            ? "Filter <code>" +
              esc(currentRid) +
              "</code> has no live streams. "
            : "") +
            "Live CPEs with flows: " +
            links +
            ' · or clear the CPE box for all. Lab call-home id is usually <code>cpe-lab</code>.',
          true
        );
      })
      .catch(function () {
        /* ignore */
      });
  }

  function startWatch() {
    var body = filterBody();
    if ($("filterSort")) {
      state.sortMode = $("filterSort").value || "rate";
    }
    /* Immediate REST fill so the list is not blank while WS connects. */
    bootstrapListFromRest().then(function (j) {
      var flows = (j && j.flows) || [];
      var newest = newestFlowMs(flows);
      var age = newest ? (Date.now() - newest) / 1000 : 1e9;
      if (
        body.router_id &&
        (!flows.length || age > 120)
      ) {
        recoverLiveRouters(body.router_id);
      } else if (!body.router_id && (!flows.length || age > 120)) {
        recoverLiveRouters("");
      } else {
        setRouterHint("", false);
      }
    });
    if (window.EdgeMux) {
      EdgeMux.watch("flows", "list", body);
      setStatus("ws " + state.wsStatus + " · watching list…");
    } else {
      setStatus("REST list (no EdgeMux)");
    }
  }

  function watchSeries(f) {
    $("detailTitle").textContent =
      (f.remote_label && f.remote_label !== "unknown"
        ? f.remote_label + " · "
        : "") + (f.remote_ip || "stream");
    $("detailBadge").textContent = f.remote_class || "—";
    $("detailBadge").className =
      "badge " + (f.remote_label && f.remote_label !== "unknown" ? "ok" : "muted");
    $("detailIdentity").innerHTML =
      '<p class="hint">Loading series over WebSocket…</p>';
    var def = $("detailDefects");
    if (def) {
      var info = analyzeFlow(f, maxRateAmong(state.flows) || 1);
      if (info.tags.length) {
        def.hidden = false;
        def.innerHTML = info.tags
          .map(function (t) {
            return (
              '<span class="flow-tag ' + t.cls + '">' + esc(t.text) + "</span>"
            );
          })
          .join("");
        $("detailBadge").className =
          "badge " + (info.sev >= 2 ? "bad" : info.sev === 1 ? "warn" : "ok");
        $("detailBadge").textContent =
          info.sev >= 2 ? "problem" : info.sev === 1 ? "watch" : f.remote_class || "ok";
      } else {
        def.hidden = true;
        def.innerHTML = "";
      }
    }

    var hours = parseInt($("filterHours").value, 10) || 24;
    EdgeMux.unwatch("flows", "series");
    EdgeMux.watch("flows", "series", {
      router_id: f.router_id,
      flow_id: f.flow_id,
      hours: hours,
      limit: 350
    });
  }

  function onFlowsMsg(msg) {
    if (!msg) return;
    var body = msg.body || {};
    if (msg.op === "list") {
      if (body.ok === false) {
        setStatus("list error: " + (body.error || "?"));
        return;
      }
      state.flows = body.flows || [];
      var newestMs = 0;
      var si;
      for (si = 0; si < state.flows.length; si++) {
        var tms = parseTs(state.flows[si].ts) || 0;
        if (tms > newestMs) newestMs = tms;
      }
      var ageSec = newestMs ? Math.max(0, (Date.now() - newestMs) / 1000) : 0;
      var ageNote = "";
      if (!state.flows.length) {
        ageNote =
          " · no streams (agent needs flow_acct.enabled + nf_conntrack_acct=1)";
      } else if (ageSec > 120) {
        ageNote =
          " · data " +
          (ageSec > 3600
            ? Math.floor(ageSec / 3600) + "h"
            : Math.floor(ageSec / 60) + "m") +
          " old (not live — check CPE flow_acct)";
      }
      if ($("statusLine")) {
        $("statusLine").innerHTML =
          (ageSec < 3
            ? '<span class="status-live">live</span> · '
            : "ws " + state.wsStatus + " · ") +
          state.flows.length +
          " streams · " +
          new Date().toLocaleTimeString() +
          ageNote;
      }
      renderList(state.flows);
      if (state.selectedKey) {
        /* keep selection; series watch continues */
      } else if (state.flows.length) {
        var ordered = sortedFlows(state.flows);
        selectKey(flowKey(ordered[0]));
      }
      return;
    }
    if (msg.op === "series") {
      if (body.ok === false) {
        $("detailIdentity").innerHTML =
          '<p class="hint">Series error: ' + esc(body.error || "?") + "</p>";
        return;
      }
      if (!body.points && body.flows) {
        $("detailIdentity").innerHTML =
          '<p class="hint">Unexpected list body on series op</p>';
        return;
      }
      var f = body.flow || {};
      if (state.selectedKey && flowKey(f) !== state.selectedKey) {
        return;
      }
      state.series = body;
      renderDetail(body);
      scheduleCharts(body);
      return;
    }
    if (msg.op === "error") {
      var err = (body && body.error) || "?";
      if (
        String(err).indexOf("too large") >= 0 ||
        String(err).indexOf("frame") >= 0
      ) {
        setStatus("ws " + state.wsStatus + " · " + err + " (kept last samples)");
      } else {
        setStatus("ws error: " + err);
      }
    }
  }

  function renderDetail(j) {
    var f = j.flow || {};
    var a = j.artifacts || {};
    var pts = j.points || [];
    /* Prefer artifacts TCP fields (series query); fall back to flow object. */
    var merged = Object.assign({}, f, {
      syn_retrans: a.syn_retrans != null ? a.syn_retrans : f.syn_retrans,
      rst: a.rst != null ? a.rst : f.rst,
      syn: a.syn != null ? a.syn : f.syn,
      fin: a.fin != null ? a.fin : f.fin,
      tcp_pkts: a.tcp_pkts != null ? a.tcp_pkts : f.tcp_pkts,
      loss_hint: a.loss_hint != null ? a.loss_hint : f.loss_hint
    });
    var info = analyzeFlow(merged, maxRateAmong(state.flows) || 1);
    var retrans = info.retrans;
    var rst = info.rst;
    var loss = info.loss;
    var tcpPkts = info.tcpPkts;
    var syn = Number(merged.syn) || 0;
    var fin = Number(merged.fin) || 0;

    $("detailIdentity").innerHTML =
      '<div class="kv"><span class="k">CPE</span><span class="v">' +
      esc(f.router_id) +
      '</span></div>' +
      '<div class="kv"><span class="k">Remote</span><span class="v">' +
      esc(f.remote_ip) +
      ":" +
      esc(f.remote_port) +
      '</span></div>' +
      '<div class="kv"><span class="k">Label</span><span class="v">' +
      esc(f.remote_label || "unknown") +
      '</span></div>' +
      '<div class="kv"><span class="k">Samples</span><span class="v">' +
      esc(pts.length) +
      " (live WS)</span></div>" +
      '<div class="kv"><span class="k">LAN</span><span class="v">' +
      esc(f.lan_ip) +
      ":" +
      esc(f.lan_port) +
      '</span></div>' +
      '<div class="kv"><span class="k">TCP window</span><span class="v">' +
      "↓ " +
      esc(fmtWin(f.win_down)) +
      " · ↑ " +
      esc(fmtWin(f.win_up)) +
      "</span></div>" +
      '<div class="kv"><span class="k">TCP defects (remote IP)</span><span class="v">' +
      "retrans " +
      esc(retrans) +
      " · rst " +
      esc(rst) +
      " · loss " +
      (loss > 0 ? (loss * 100).toFixed(1) + "%" : "—") +
      "</span></div>" +
      '<div class="kv"><span class="k">TCP ctrl plane</span><span class="v">' +
      "syn " +
      esc(syn) +
      " · fin " +
      esc(fin) +
      " · pkts " +
      esc(tcpPkts) +
      ' <span class="hint">(scoped to remote IP)</span></span></div>' +
      '<div class="kv"><span class="k">flow_id</span><span class="v">' +
      esc(f.flow_id) +
      "</span></div>";

    var def = $("detailDefects");
    if (def) {
      if (info.tags.length) {
        def.hidden = false;
        def.innerHTML = info.tags
          .map(function (t) {
            return (
              '<span class="flow-tag ' + t.cls + '">' + esc(t.text) + "</span>"
            );
          })
          .join("");
        $("detailBadge").className =
          "badge " + (info.sev >= 2 ? "bad" : info.sev === 1 ? "warn" : "ok");
        $("detailBadge").textContent =
          info.sev >= 2
            ? "problem"
            : info.sev === 1
              ? "watch"
              : f.remote_class || "ok";
      }
    }

    var peakCls = "";
    if (info.sev >= 2) peakCls = " stat-bad";
    else if (info.sev === 1) peakCls = " stat-warn";
    var retransCls =
      retrans >= 20 || loss >= 0.3
        ? " stat-bad"
        : retrans > 0 || loss >= 0.05
          ? " stat-warn"
          : "";
    var rstCls = rst >= 50 ? " stat-bad" : rst >= 3 ? " stat-warn" : "";

    $("detailArtifacts").innerHTML =
      '<span class="stat' +
      peakCls +
      '">Peak ↓ <strong>' +
      esc(fmtRate(a.peak_down_bps)) +
      "</strong></span>" +
      '<span class="stat">Peak ↑ <strong>' +
      esc(fmtRate(a.peak_up_bps)) +
      "</strong></span>" +
      '<span class="stat">Total ↓ <strong>' +
      esc(fmtBytes(a.total_down)) +
      "</strong></span>" +
      '<span class="stat">Chunks <strong>' +
      esc(a.chunk_count) +
      "</strong></span>" +
      '<span class="stat' +
      retransCls +
      '" title="SYN retransmissions toward this remote IP (cpe_tcp_stats)">SYN retrans <strong>' +
      esc(retrans) +
      "</strong></span>" +
      '<span class="stat' +
      retransCls +
      '" title="Agent loss_hint for this remote IP">Loss hint <strong>' +
      (loss > 0 ? (loss * 100).toFixed(1) + "%" : "—") +
      "</strong></span>" +
      '<span class="stat' +
      rstCls +
      '" title="RST count for this remote IP">RST <strong>' +
      esc(rst) +
      "</strong></span>" +
      (a.destroy_ts
        ? '<span class="stat stat-bad">Destroy <strong>' +
          esc(fmtLocalTs(a.destroy_ts, "datetime")) +
          "</strong></span>"
        : "");

    var chunks = j.chunks || [];
    var tb = $("chunkBody");
    if (!chunks.length) {
      tb.innerHTML =
        '<tr><td colspan="6" class="hint">No high-rate chunks.</td></tr>';
    } else {
      var html = "";
      for (var i = 0; i < chunks.length; i++) {
        var c = chunks[i];
        html +=
          "<tr><td>" +
          (i + 1) +
          "</td><td>" +
          esc(fmtLocalTs(c.t0, "datetime")) +
          "</td><td>" +
          esc(fmtLocalTs(c.t1, "datetime")) +
          "</td><td>" +
          esc(fmtRate(c.peak_down_bps)) +
          "</td><td>" +
          esc(fmtBytes(c.bytes_down)) +
          "</td><td>" +
          esc(c.samples) +
          "</td></tr>";
      }
      tb.innerHTML = html;
    }
  }

  function setupCanvas(canvas, cssH) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 900;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  function scheduleCharts(j) {
    if (state.drawPending) {
      state.pendingSeries = j;
      return;
    }
    state.drawPending = true;
    state.pendingSeries = j;
    requestAnimationFrame(function () {
      state.drawPending = false;
      var body = state.pendingSeries;
      state.pendingSeries = null;
      if (body) drawCharts(body);
    });
  }

  function drawCharts(j) {
    drawBandwidth(j);
    drawWindow(j);
  }

  function drawHLine(ctx, pad, plotW, y, color, label) {
    ctx.save();
    ctx.strokeStyle = color || "#e07070";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) {
      ctx.fillStyle = color || "#e07070";
      ctx.font = "10px Outfit, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(label, pad.l + plotW - 2, y - 3);
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  function drawBandwidth(j) {
    var canvas = $("rateChart");
    if (!canvas) return;
    var g = setupCanvas(canvas, 200);
    var ctx = g.ctx;
    var cssW = g.w;
    var cssH = g.h;
    var pad = { l: 52, r: 12, t: 12, b: 26 };
    var plotW = cssW - pad.l - pad.r;
    var plotH = cssH - pad.t - pad.b;
    ctx.fillStyle = cssVar("--chart-plot", "rgba(15,18,24,0.25)");
    ctx.fillRect(pad.l, pad.t, plotW, plotH);

    var pts = (j && j.points) || [];
    if ($("bwPointCount")) {
      $("bwPointCount").textContent = pts.length
        ? "· " + pts.length + " samples"
        : "";
    }
    if (!pts.length) {
      ctx.fillStyle = cssVar("--chart-label", "#6b6660");
      ctx.font = "12px Outfit, system-ui, sans-serif";
      ctx.fillText("No sample points for this flow yet.", pad.l + 8, pad.t + 22);
      return;
    }

    var axis = buildAxis(pts);
    var downs = pts.map(function (p) {
      return Number(p.rate_down_bps) || 0;
    });
    var ups = pts.map(function (p) {
      return Number(p.rate_up_bps) || 0;
    });
    var rawPeak = 0;
    var i;
    for (i = 0; i < downs.length; i++) {
      rawPeak = Math.max(rawPeak, downs[i], ups[i]);
    }
    var maxR = Math.max(robustMax(downs.concat(ups)), 1);
    var axisMax = Math.max(maxR, rawPeak) * 1.08;

    function xAt(idx) {
      return pad.l + ((axis.times[idx] - axis.t0) / (axis.t1 - axis.t0)) * plotW;
    }
    function yAt(r) {
      return pad.t + plotH - (Math.min(r, axisMax) / axisMax) * plotH;
    }

    var chunks = (j && j.chunks) || [];
    for (var ci = 0; ci < chunks.length; ci++) {
      var c0 = parseTs(chunks[ci].t0);
      var c1 = parseTs(chunks[ci].t1);
      if (isNaN(c0) || isNaN(c1) || axis.mode !== "time") continue;
      var x0 = pad.l + ((c0 - axis.t0) / (axis.t1 - axis.t0)) * plotW;
      var x1 = pad.l + ((c1 - axis.t0) / (axis.t1 - axis.t0)) * plotW;
      if (x1 < x0 + 3) x1 = x0 + 3;
      ctx.fillStyle = cssVar("--chart-fill", "rgba(107,140,255,0.08)");
      ctx.fillRect(x0, pad.t, x1 - x0, plotH);
    }

    ctx.strokeStyle = cssVar("--chart-grid", "rgba(46,54,72,0.55)");
    ctx.font = "10px IBM Plex Mono, monospace";
    ctx.fillStyle = cssVar("--chart-label", "#6b6660");
    for (var gi = 0; gi <= 3; gi++) {
      var gy = pad.t + (plotH * gi) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(pad.l + plotW, gy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(fmtRate(axisMax * (1 - gi / 3)), pad.l - 4, gy + 3);
    }
    ctx.textAlign = "left";

    if (rawPeak > 0) {
      drawHLine(
        ctx,
        pad,
        plotW,
        yAt(rawPeak),
        cssVar("--chart-peak", "rgba(232,122,130,0.55)"),
        "peak " + fmtRate(rawPeak)
      );
    }

    ctx.beginPath();
    for (i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(xAt(i), yAt(downs[i]));
      else ctx.lineTo(xAt(i), yAt(downs[i]));
    }
    ctx.lineTo(xAt(pts.length - 1), pad.t + plotH);
    ctx.lineTo(xAt(0), pad.t + plotH);
    ctx.closePath();
    ctx.fillStyle = cssVar("--chart-fill", "rgba(107,140,255,0.08)");
    ctx.fill();

    function strokeRate(vals, color) {
      ctx.beginPath();
      for (var k = 0; k < pts.length; k++) {
        if (k === 0) ctx.moveTo(xAt(k), yAt(vals[k]));
        else ctx.lineTo(xAt(k), yAt(vals[k]));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      /* endpoints only — lighter look */
      if (pts.length) {
        ctx.beginPath();
        ctx.arc(xAt(pts.length - 1), yAt(vals[pts.length - 1]), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    strokeRate(downs, cssVar("--chart-line-a", "#6b8cff"));
    strokeRate(ups, cssVar("--chart-line-b", "#c4788a"));

    for (i = 0; i < pts.length; i++) {
      if (pts[i].event === "destroy") {
        ctx.strokeStyle = cssVar("--chart-defect", "#e87a82");
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xAt(i), pad.t);
        ctx.lineTo(xAt(i), pad.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (state.hoverIdx >= 0 && state.hoverIdx < pts.length) {
      var hi = state.hoverIdx;
      ctx.strokeStyle = cssVar("--text-soft", "rgba(240,235,227,0.35)");
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(xAt(hi), pad.t);
      ctx.lineTo(xAt(hi), pad.t + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = cssVar("--chart-line-a", "#6b8cff");
      ctx.beginPath();
      ctx.arc(xAt(hi), yAt(downs[hi]), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = cssVar("--chart-label", "#6b6660");
    function xlab(idx, align) {
      if (idx < 0 || idx >= pts.length) return;
      var label =
        axis.mode === "time" ? fmtLocalTs(pts[idx].ts, "time") : "#" + idx;
      ctx.textAlign = align || "center";
      ctx.fillText(label, xAt(idx), cssH - 6);
    }
    xlab(0, "left");
    xlab(pts.length - 1, "right");
    ctx.textAlign = "left";
  }

  function drawWindow(j) {
    var canvas = $("winChart");
    if (!canvas) return;
    var g = setupCanvas(canvas, 120);
    var ctx = g.ctx;
    var cssW = g.w;
    var cssH = g.h;
    var pad = { l: 64, r: 16, t: 14, b: 30 };
    var plotW = cssW - pad.l - pad.r;
    var plotH = cssH - pad.t - pad.b;
    ctx.fillStyle = "rgba(15,18,24,0.4)";
    ctx.fillRect(pad.l, pad.t, plotW, plotH);
    var pts = (j && j.points) || [];
    if (!pts.length) {
      ctx.fillStyle = "#6b6660";
      ctx.font = "12px Outfit, system-ui, sans-serif";
      ctx.fillText("No window samples.", pad.l + 10, pad.t + 24);
      return;
    }
    var axis = buildAxis(pts);
    var wu = pts.map(function (p) {
      return Number(p.win_up) || 0;
    });
    var wd = pts.map(function (p) {
      return Number(p.win_down) || 0;
    });
    var peakW = 0;
    var mi;
    for (mi = 0; mi < wu.length; mi++) {
      peakW = Math.max(peakW, wu[mi], wd[mi]);
    }
    var maxW = Math.max(robustMax(wu.concat(wd)), peakW, 1) * 1.08;
    var maxUp = 0;
    var maxDown = 0;
    for (mi = 0; mi < wu.length; mi++) {
      if (wu[mi] > maxUp) maxUp = wu[mi];
      if (wd[mi] > maxDown) maxDown = wd[mi];
    }
    var any = maxUp > 0 || maxDown > 0;
    function xAt(idx) {
      return pad.l + ((axis.times[idx] - axis.t0) / (axis.t1 - axis.t0)) * plotW;
    }
    function yAt(v) {
      return pad.t + plotH - (Math.min(v, maxW) / maxW) * plotH;
    }

    /* throttle zone: below 4 KiB */
    var thr = 4096;
    if (thr < maxW) {
      var yThr = yAt(thr);
      ctx.fillStyle = "rgba(230, 184, 77, 0.12)";
      ctx.fillRect(pad.l, yThr, plotW, pad.t + plotH - yThr);
      ctx.fillStyle = "#e6b84d";
      ctx.font = "10px Outfit, sans-serif";
      ctx.fillText("throttle zone (<4 KiB window)", pad.l + 6, Math.min(yThr + 12, pad.t + plotH - 4));
    }

    ctx.fillStyle = "#6b6660";
    ctx.font = "10px IBM Plex Mono, monospace";
    for (var gi = 0; gi <= 2; gi++) {
      var gy = pad.t + (plotH * gi) / 2;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(46,54,72,0.95)";
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(pad.l + plotW, gy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(fmtWin(maxW * (1 - gi / 2)), pad.l - 6, gy + 3);
    }
    ctx.textAlign = "left";

    ctx.save();
    ctx.fillStyle = "#8b98a5";
    ctx.font = "10px Outfit, sans-serif";
    ctx.translate(12, pad.t + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("window bytes", 0, 0);
    ctx.restore();

    if (peakW > 0) {
      drawHLine(ctx, pad, plotW, yAt(peakW), "#e07070", "peak " + fmtWin(peakW));
    }

    if (!any) {
      ctx.fillStyle = "#6b6660";
      ctx.font = "12px Outfit, system-ui, sans-serif";
      ctx.fillText(
        "No window on this stream’s samples yet.",
        pad.l + 10,
        pad.t + plotH / 2 - 6
      );
      ctx.font = "11px Outfit, system-ui, sans-serif";
      ctx.fillText(
        "Needs NFLOG SYN/FIN/RST (or data) + cpe_agent with window soft-join.",
        pad.l + 10,
        pad.t + plotH / 2 + 14
      );
      return;
    }
    function strokeWin(vals, color) {
      ctx.beginPath();
      var started = false;
      var i;
      for (i = 0; i < pts.length; i++) {
        if (!(vals[i] > 0)) continue;
        if (!started) {
          ctx.moveTo(xAt(i), yAt(vals[i]));
          started = true;
        } else ctx.lineTo(xAt(i), yAt(vals[i]));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      for (i = 0; i < pts.length; i++) {
        if (!(vals[i] > 0)) continue;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(vals[i]), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    strokeWin(wd, "#6b8cff");
    strokeWin(wu, "#c4788a");

    ctx.fillStyle = "#8b98a5";
    ctx.font = "10px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("time →", pad.l + plotW / 2, cssH - 8);
    ctx.textAlign = "left";
  }

  function onChartMove(ev) {
    var j = state.series;
    if (!j || !j.points || !j.points.length) return;
    var canvas = $("rateChart");
    var rect = canvas.getBoundingClientRect();
    var x = ev.clientX - rect.left;
    var padL = 64;
    var plotW = rect.width - padL - 16;
    var frac = (x - padL) / plotW;
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    var idx = Math.round(frac * (j.points.length - 1));
    state.hoverIdx = idx;
    drawCharts(j);
    var p = j.points[idx];
    var tip = $("chartTip");
    tip.hidden = false;
    tip.innerHTML =
      esc(fmtLocalTs(p.ts, "datetime")) +
      "<br>↓ " +
      esc(fmtRate(p.rate_down_bps)) +
      " · Δ " +
      esc(fmtBytes(p.bytes_down_delta)) +
      "<br>↑ " +
      esc(fmtRate(p.rate_up_bps)) +
      " · win↓ " +
      esc(fmtWin(p.win_down)) +
      " win↑ " +
      esc(fmtWin(p.win_up));
    tip.style.left = Math.min(x + 12, rect.width - 180) + "px";
    tip.style.top = ev.clientY - rect.top + 12 + "px";
  }

  function onChartLeave() {
    state.hoverIdx = -1;
    $("chartTip").hidden = true;
    if (state.series) drawCharts(state.series);
  }

  function ensureContextBanner() {
    var existing = $("contextEmpty");
    if (existing) return existing;
    var host = document.getElementById("edge-shell-content") || document.body;
    var el = document.createElement("div");
    el.id = "contextEmpty";
    el.className = "context-empty-banner";
    el.innerHTML =
      "Optional: pick a <strong>location</strong> in the top bar to filter flows to that CPE. " +
      'Browse <a href="/devices/">Locations &amp; devices</a> to set focus.';
    host.insertBefore(el, host.firstChild);
    return el;
  }

  function applyContextToFilter(c) {
    c = c || (window.EdgeContext && EdgeContext.get && EdgeContext.get()) || {};
    var fr = $("filterRouter");
    var rid = c.routerId || "";
    if (fr && fr.value !== rid) {
      fr.value = rid;
    }
    var ban = ensureContextBanner();
    /* Flows allow empty filter (all routers) — soft hint only when empty */
    if (ban) {
      if (rid) ban.classList.remove("is-visible");
      else ban.classList.add("is-visible");
    }
  }

  function bindFilters() {
    function rewatch() {
      startWatch();
    }
    applyContextToFilter();
    /* Migrate lab fixture id "router" → live call-home id "cpe-lab". */
    if (
      $("filterRouter") &&
      $("filterRouter").value === "router" &&
      window.EdgeContext &&
      EdgeContext.setRouter
    ) {
      EdgeContext.setRouter("cpe-lab", { source: "flows-migrate" });
      $("filterRouter").value = "cpe-lab";
    }
    if (window.EdgeContext && EdgeContext.onChange) {
      EdgeContext.onChange(function (c) {
        applyContextToFilter(c);
        rewatch();
      });
    }
    if ($("flowRouterHint")) {
      $("flowRouterHint").addEventListener("click", function (ev) {
        var btn = ev.target.closest(".flow-router-pick");
        if (!btn) return;
        var rid = btn.getAttribute("data-rid") || "";
        if ($("filterRouter")) $("filterRouter").value = rid;
        if (window.EdgeContext && EdgeContext.setRouter) {
          EdgeContext.setRouter(rid, { source: "user" });
        }
        rewatch();
      });
    }
    ["filterRouter", "filterHours", "filterLimit", "filterQ"].forEach(
      function (id) {
        var el = $(id);
        if (!el) return;
        el.addEventListener("change", function () {
          if (id === "filterRouter" && window.EdgeContext && EdgeContext.setRouter) {
            EdgeContext.setRouter(el.value, { source: "user" });
          }
          rewatch();
        });
        if (el.tagName === "INPUT") {
          el.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
              if (id === "filterRouter" && window.EdgeContext && EdgeContext.setRouter) {
                EdgeContext.setRouter(el.value, { source: "user" });
              }
              rewatch();
            }
          });
        }
      }
    );
    if ($("filterSort")) {
      $("filterSort").addEventListener("change", function () {
        state.sortMode = $("filterSort").value || "rate";
        renderList(state.flows);
      });
    }
    if ($("labelChips")) {
      $("labelChips").addEventListener("click", function (ev) {
        var btn = ev.target.closest(".chip");
        if (!btn) return;
        state.labelFilter = btn.getAttribute("data-label") || "";
        $("labelChips").querySelectorAll(".chip").forEach(function (c) {
          c.classList.toggle("active", c === btn);
        });
        startWatch();
      });
    }
    if ($("timeScrub")) {
      $("timeScrub").addEventListener("input", function () {
        var v = parseInt($("timeScrub").value, 10) || 0;
        state.scrubFrac = v / 1000;
        applyScrubFromFrac();
        drawOverlay();
      });
    }
    if ($("btnLive")) {
      $("btnLive").addEventListener("click", function () {
        state.scrubFrac = 1;
        if ($("timeScrub")) $("timeScrub").value = "1000";
        applyScrubFromFrac();
        drawOverlay();
      });
    }
    if ($("rateChart")) {
      $("rateChart").addEventListener("mousemove", onChartMove);
      $("rateChart").addEventListener("mouseleave", onChartLeave);
    }
    window.addEventListener("resize", function () {
      if (state.series) scheduleCharts(state.series);
      drawOverlay();
    });
    document.addEventListener("keydown", function (ev) {
      if (
        ev.target &&
        (ev.target.tagName === "INPUT" ||
          ev.target.tagName === "TEXTAREA" ||
          ev.target.tagName === "SELECT")
      ) {
        return;
      }
      if (ev.key === "j" || ev.key === "ArrowDown") {
        ev.preventDefault();
        selectByDelta(1);
      } else if (ev.key === "k" || ev.key === "ArrowUp") {
        ev.preventDefault();
        selectByDelta(-1);
      }
    });
  }

  function bootLive() {
    /* Re-watch list/series on every WS open — server drops watches (same
     * LiveFeed contract as /host/ and /graphs/). */
    EdgeMux.onStatus(function (st) {
      state.wsStatus = st;
      setStatus("ws " + st);
      if (st === "open") {
        startWatch();
      }
    });
    EdgeMux.on("flows", onFlowsMsg);
    bindFilters();
    drawCharts(null);
    drawOverlay();
    EdgeMux.connect();
    setStatus("connecting…");
  }

  /* Auth is enforced by shell (redirect to /?next=…); start when session ok. */
  if (window.EdgeShell && EdgeShell.requireAuth) {
    EdgeShell.requireAuth().then(function (ok) {
      if (ok) bootLive();
    });
  } else {
    fetch("/auth/me", { credentials: "same-origin" })
      .then(function (r) {
        if (r.ok) bootLive();
        else location.replace("/?next=" + encodeURIComponent("/flows/"));
      })
      .catch(function () {
        location.replace("/?next=" + encodeURIComponent("/flows/"));
      });
  }
})();
