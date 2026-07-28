/* CPE host + Wi‑Fi live graphs (multiplexed WebSocket channel "host").
 * Scroll-stable updates, per-core CPU, clear axes / max capacity, problem highlights.
 */
(function () {
  var CORE_COLORS = [
    "#6b8cff",
    "#5ad67d",
    "#f0a040",
    "#e070f0",
    "#e0c040",
    "#4ecf9a",
    "#c4788a",
    "#8ec8ff"
  ];

  var state = {
    hostPts: [],
    wifiPts: [],
    wifiStations: [],
    /* MAC → { s, miss } — keep until hostapd leave (missed polls) or leave event. */
    wifiStationMap: {},
    wifiEv: [],
    arpEv: [],
    procs: [],
    procSeries: {},
    clientSeries: {}, /* mac → { points: [...] } coverage history */
    expanded: {},
    expandedClients: {}, /* mac → true when client detail open */
    sortKey: "cpu_pct",
    sortDir: "desc",
    wsStatus: "init",
    minutes: 10,
    nCpus: 0,
    drawPending: false,
    /* Continuous scroll: wall-clock window + one-tick-lag live tips. */
    animRaf: 0,
    liveTips: {}, /* chartId -> key -> { y, from, target, t0, dur } */
    metaDirty: true,
    lastMetaMs: 0,
    dataAgeMs: 0,
    dataStale: false,
    lastSampleMs: 0,
    lastHostPushMs: 0,
    lastWifiPushMs: 0,
    lastStationsMs: 0,
    stationsPollTimer: 0,
    clientSeriesPollTimer: 0,
    feedAgeMs: 0,
    lanClients: [], /* fallback from flows when wifi stations empty */
    lastLanMs: 0
  };

  /* Drop from Connected clients after this many successful polls without the MAC
   * (~3s at 1s agent / 2s UI poll). Matches hostapd disassociate. */
  var STA_MISS_DROP = 3;

  /* Shared live-strip constants (public/live_feed.js). Fallbacks if script missing. */
  var LF = window.LiveFeed || {};
  var LIVE_MORPH_MS = LF.LIVE_MORPH_MS || 1600;
  var LIVE_LEAD_MS = LF.LIVE_LEAD_MS || 2500;
  var PUSH_STALE_MS = LF.FEED_STALE_MS || 15000;
  var HOST_SERIES_LIMIT = LF.HOST_SERIES_LIMIT || 120;

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

  function parseTs(ts) {
    if (ts == null || ts === "") return NaN;
    if (typeof ts === "number") {
      return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
    }
    var s = String(ts).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      var n = Number(s);
      return n > 0 && n < 1e12 ? n * 1000 : n;
    }
    var t = Date.parse(s);
    if (!isNaN(t)) return t;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
      t = Date.parse(s.replace(" ", "T") + "Z");
    }
    return isNaN(t) ? NaN : t;
  }

  /**
   * Accumulate host/wifi series (shared LiveFeed.mergeByTimestamp).
   * Fixes WS tip-only frames wiping a full REST-seeded history.
   */
  function mergeSeriesPts(prev, next) {
    var lookback =
      typeof LF.lookbackFromMinutes === "function"
        ? LF.lookbackFromMinutes(state.minutes)
        : Math.max(60000, (state.minutes || 10) * 60000);
    if (typeof LF.mergeByTimestamp === "function") {
      return LF.mergeByTimestamp(prev, next, lookback, {
        parseTs: parseTs,
        limit: HOST_SERIES_LIMIT * 3
      });
    }
    /* Fallback: prefer longer buffer (legacy) */
    if (!next || !next.length) return prev || [];
    if (!prev || !prev.length) return next.slice();
    return next.length >= prev.length ? next.slice() : prev;
  }

  function fmtLocalTs(ts, style) {
    var ms = typeof ts === "number" && isFinite(ts) ? ts : parseTs(ts);
    if (isNaN(ms)) return ts == null || ts === "" ? "—" : String(ts);
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
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  function fmtRate(bps) {
    bps = Number(bps) || 0;
    if (bps < 1000) return bps.toFixed(0) + " bps";
    if (bps < 1e6) return (bps / 1000).toFixed(1) + " kbps";
    if (bps < 1e9) return (bps / 1e6).toFixed(2) + " Mbps";
    return (bps / 1e9).toFixed(2) + " Gbps";
  }

  function fmtMemKb(kb) {
    kb = Number(kb) || 0;
    if (kb < 1024) return kb.toFixed(0) + " KiB";
    if (kb < 1048576) return (kb / 1024).toFixed(1) + " MiB";
    return (kb / 1048576).toFixed(2) + " GiB";
  }

  function fmtLinkRate(kbps) {
    kbps = Number(kbps) || 0;
    if (kbps <= 0) return "—";
    if (kbps < 1000) return kbps.toFixed(0) + " kbps";
    var mbps = kbps / 1000;
    if (mbps < 10) return mbps.toFixed(1) + " Mbps";
    return mbps.toFixed(0) + " Mbps";
  }

  /** Rough HT 20 MHz 1-SS MCS → Mbps (used when radio omits bitrate). */
  function mcsEstimateMbps(mcs) {
    var table = [6.5, 13, 19.5, 26, 39, 52, 58.5, 65, 78, 104, 117, 130];
    mcs = Number(mcs);
    if (!isFinite(mcs) || mcs < 0 || mcs === 255) return 0;
    if (mcs < table.length) return table[mcs];
    /* VHT-ish: scale from MCS 7 */
    return table[7] * (1 + (mcs - 7) * 0.15);
  }

  function bandFromFreq(mhz) {
    mhz = Number(mhz) || 0;
    if (mhz >= 5925) return { label: "6 GHz", cls: "band-6" };
    if (mhz >= 4900) return { label: "5 GHz", cls: "band-5" };
    if (mhz >= 2400) return { label: "2.4 GHz", cls: "band-24" };
    return { label: mhz ? mhz + " MHz" : "—", cls: "" };
  }

  /*
   * Absolute cap after agent capability sanitization (HE 160 4SS ≈ 4.8 Gbps).
   * Pre-fix samples may still be 10× inflated — treat > max as zero in UI.
   */
  var LINK_RATE_KBPS_MAX = 5000000; /* 5 Gbps */

  function sanitizeLinkKbps(kbps) {
    kbps = Number(kbps) || 0;
    if (kbps <= 0 || kbps > LINK_RATE_KBPS_MAX) return 0;
    return kbps;
  }

  function stationLinkTx(s) {
    var kbps = sanitizeLinkKbps(s && s.tx_bitrate_kbps);
    if (kbps > 0) return { text: fmtLinkRate(kbps), est: false };
    return { text: "—", est: false };
  }

  function stationLinkRx(s) {
    var kbps = sanitizeLinkKbps(s && s.rx_bitrate_kbps);
    if (kbps > 0) return { text: fmtLinkRate(kbps), est: false };
    return { text: "—", est: false };
  }

  /** Actual throughput from byte-counter deltas (most reliable bandwidth). */
  function fmtThroughput(bps) {
    bps = Number(bps) || 0;
    if (bps <= 0) return "—";
    if (bps < 1000) return bps.toFixed(0) + " bps";
    if (bps < 1000000) return (bps / 1000).toFixed(bps < 10000 ? 1 : 0) + " kbps";
    var mbps = bps / 1000000;
    if (mbps < 10) return mbps.toFixed(1) + " Mbps";
    return mbps.toFixed(0) + " Mbps";
  }

  function stationThroughput(s) {
    var tx = Number(s && s.tx_throughput_bps) || 0;
    var rx = Number(s && s.rx_throughput_bps) || 0;
    if (tx <= 0 && rx <= 0) return { text: "—", title: "" };
    var parts = [];
    if (tx > 0) parts.push("↓" + fmtThroughput(tx)); /* AP→STA is TX from AP */
    if (rx > 0) parts.push("↑" + fmtThroughput(rx));
    return {
      text: parts.join(" "),
      title:
        "Actual throughput from hostapd byte counters (not PHY rate). " +
        "TX=" +
        fmtThroughput(tx) +
        " AP→client, RX=" +
        fmtThroughput(rx) +
        " client→AP"
    };
  }

  function macKey(mac) {
    return String(mac || "")
      .toLowerCase()
      .replace(/[^0-9a-f:]/g, "");
  }

  /**
   * Format chain_rssi for the table. Accepts JSON array string "[71,66]",
   * real array, or comma-separated. Shows as "c0/c1/c2…" with dBm hint.
   */
  function fmtChainRssi(s) {
    var raw = s && (s.chain_rssi != null ? s.chain_rssi : null);
    var arr = [];
    var i;
    if (Array.isArray(raw)) {
      arr = raw.map(function (v) {
        return Number(v);
      });
    } else if (typeof raw === "string" && raw.length) {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          arr = parsed.map(function (v) {
            return Number(v);
          });
        }
      } catch (e) {
        arr = raw
          .replace(/[\[\]]/g, "")
          .split(",")
          .map(function (x) {
            return parseInt(x.trim(), 10);
          })
          .filter(function (x) {
            return isFinite(x);
          });
      }
    }
    arr = arr.filter(function (x) {
      return isFinite(x);
    });
    if (!arr.length) return { text: "—", title: "" };
    var parts = arr.map(function (v) {
      return String(v);
    });
    return {
      text: parts.join(" / "),
      title:
        "Per-chain signal (driver raw): [" +
        parts.join(", ") +
        "] — not H/V angle; positive values may mean magnitude (−dBm)"
    };
  }

  /**
   * Merge server station rows into the live association map.
   * Clients stay listed until missing from STA_MISS_DROP consecutive successful
   * polls (hostapd disassociate) or an explicit leave event.
   */
  function mergeWifiStations(list, opts) {
    var seen = {};
    var i;
    var mac;
    var ent;
    var arr;
    opts = opts || {};
    if (!state.wifiStationMap) state.wifiStationMap = {};
    if (Array.isArray(list)) {
      for (i = 0; i < list.length; i++) {
        var s = list[i];
        mac = String((s && s.client_mac) || "")
          .toLowerCase()
          .trim();
        if (!mac) continue;
        seen[mac] = 1;
        ent = state.wifiStationMap[mac];
        if (!ent) {
          state.wifiStationMap[mac] = { s: s, miss: 0 };
        } else {
          /* Keep last known non-zero hostapd rates if a sample omits them. */
          var prev = ent.s || {};
          var merged = Object.assign({}, prev, s);
          if (!(Number(s.tx_bitrate_kbps) > 0) && Number(prev.tx_bitrate_kbps) > 0) {
            merged.tx_bitrate_kbps = prev.tx_bitrate_kbps;
          }
          if (!(Number(s.rx_bitrate_kbps) > 0) && Number(prev.rx_bitrate_kbps) > 0) {
            merged.rx_bitrate_kbps = prev.rx_bitrate_kbps;
          }
          ent.s = merged;
          ent.miss = 0;
        }
      }
    }
    if (opts.trackMiss !== false) {
      Object.keys(state.wifiStationMap).forEach(function (m) {
        if (seen[m]) return;
        state.wifiStationMap[m].miss =
          (state.wifiStationMap[m].miss || 0) + 1;
        if (state.wifiStationMap[m].miss >= STA_MISS_DROP) {
          delete state.wifiStationMap[m];
        }
      });
    }
    arr = Object.keys(state.wifiStationMap).map(function (m) {
      return state.wifiStationMap[m].s;
    });
    state.wifiStations = arr;
    return arr;
  }

  function removeWifiStationMac(mac) {
    mac = String(mac || "")
      .toLowerCase()
      .trim();
    if (!mac || !state.wifiStationMap) return;
    if (state.wifiStationMap[mac]) {
      delete state.wifiStationMap[mac];
      state.wifiStations = Object.keys(state.wifiStationMap).map(function (m) {
        return state.wifiStationMap[m].s;
      });
    }
  }

  function fmtRangeLabel(minutes) {
    minutes = Number(minutes) || 10;
    if (minutes < 60) return minutes + "m";
    if (minutes % 60 === 0) return minutes / 60 + "h";
    return minutes + "m";
  }

  function status(msg) {
    var el = $("statusLine");
    if (el) el.textContent = msg;
  }

  function selectedMinutes() {
    var el = $("filterRange");
    var m = el ? parseInt(el.value, 10) : 10;
    if (!isFinite(m) || m <= 0) m = 10;
    if (m > 48 * 60) m = 48 * 60;
    return m;
  }

  function seriesOpts() {
    var minutes = selectedMinutes();
    state.minutes = minutes;
    /* Keep under WS frame (~96 KiB). Host points are ~500–560 B each after
     * per-core fields; 120 * 560 ≈ 67 KiB body. Server also caps at 120. */
    return {
      router_id: ($("filterRouter").value || "").trim(),
      minutes: minutes,
      hours: Math.max(1, Math.ceil(minutes / 60)),
      limit: HOST_SERIES_LIMIT
    };
  }

  function levelFromPct(pct, warn, bad) {
    pct = Number(pct) || 0;
    if (pct >= bad) return "bad";
    if (pct >= warn) return "warn";
    return "ok";
  }

  function detectNCpus(pts) {
    var n = 0;
    var i, c, k;
    if (!pts || !pts.length) return state.nCpus || 0;
    for (i = pts.length - 1; i >= 0; i--) {
      c = Number(pts[i].n_cpus) || 0;
      if (c > n) n = c;
    }
    if (n > 0) return Math.min(8, n);
    /* Infer from non-zero core columns when n_cpus not yet populated. */
    for (k = 0; k < 8; k++) {
      for (i = 0; i < pts.length; i++) {
        if ((Number(pts[i]["cpu" + k + "_pct"]) || 0) > 0.01) {
          n = k + 1;
          break;
        }
      }
    }
    return n;
  }

  function busiestCore(pt) {
    if (!pt) return { idx: -1, pct: Number(pt && pt.cpu_pct) || 0 };
    var n = Number(pt.n_cpus) || state.nCpus || 0;
    var best = Number(pt.cpu_pct) || 0;
    var bi = -1;
    var k, v;
    for (k = 0; k < Math.max(n, 8); k++) {
      v = Number(pt["cpu" + k + "_pct"]);
      if (!isFinite(v)) continue;
      if (v > best || bi < 0) {
        best = v;
        bi = k;
      }
    }
    return { idx: bi, pct: best };
  }

  /* ---- Canvas series plotter (live scroll + morph) --------------------- */

  function dataTimeExtent(pts) {
    var tmin = Infinity;
    var tmax = -Infinity;
    var i, t;
    for (i = 0; i < pts.length; i++) {
      t = parseTs(pts[i].ts);
      if (isNaN(t)) continue;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    if (!isFinite(tmin) || !isFinite(tmax)) return null;
    return { tmin: tmin, tmax: tmax };
  }

  function setupCanvas(canvas, cssH) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 900;
    var h = cssH || Number(canvas.getAttribute("data-h")) || 240;
    if (
      canvas._ehW === cssW &&
      canvas._ehH === h &&
      canvas._ehDpr === dpr &&
      canvas.getContext
    ) {
      var c0 = canvas.getContext("2d");
      c0.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx: c0, w: cssW, h: h };
    }
    canvas._ehW = cssW;
    canvas._ehH = h;
    canvas._ehDpr = dpr;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = "100%";
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: h };
  }

  /**
   * Smooth one-tick-lag head: displayed Y eases toward the latest sample
   * over LIVE_MORPH_MS so the right-edge dot slides rather than jumps.
   */
  function liveTipY(chartId, key, target, nowMs) {
    if (!state.liveTips[chartId]) state.liveTips[chartId] = {};
    var tips = state.liveTips[chartId];
    var tip = tips[key];
    if (!tip) {
      tip = tips[key] = {
        y: target,
        from: target,
        target: target,
        t0: nowMs,
        dur: LIVE_MORPH_MS
      };
      return target;
    }
    if (isFinite(target) && Math.abs(tip.target - target) > 1e-6) {
      tip.from = tip.y;
      tip.target = target;
      tip.t0 = nowMs;
    }
    var u = (nowMs - tip.t0) / tip.dur;
    if (u < 0) u = 0;
    if (u > 1) u = 1;
    /* ease-out cubic — quick start, soft settle */
    var e = 1 - Math.pow(1 - u, 3);
    tip.y = tip.from + (tip.target - tip.from) * e;
    return tip.y;
  }

  /**
   * opts:
   *  chartId (required for live tips), ymin/ymax, fixedY, fmtY, windowMinutes
   *  yLabel, maxLine, maxLabel, refLines, dual
   *  live: true (default) = wall-clock scroll + one-tick morph on right edge
   *  height: canvas css height
   */
  function plotSeries(canvas, pts, series, opts) {
    if (!canvas) return;
    opts = opts || {};
    var g = setupCanvas(canvas, opts.height || 240);
    var ctx = g.ctx;
    var W = g.w;
    var H = g.h;
    var padL = 68;
    var padR = opts.dual ? 58 : 18;
    var padT = 22;
    var padB = 36;
    var i, s, v, minY, maxY, t0, t1;
    var nowMs = Date.now();
    var winMs = (opts.windowMinutes || state.minutes || 10) * 60 * 1000;
    var ext = dataTimeExtent(pts);
    var live = opts.live !== false;
    var chartId = opts.chartId || canvas.id || "chart";
    var committedN = 0;

    ctx.clearRect(0, 0, W, H);
    /* Slightly lifted surface so lines pop */
    ctx.fillStyle = "#121820";
    ctx.fillRect(0, 0, W, H);

    if (!pts || !pts.length) {
      ctx.fillStyle = "#b8b2a8";
      ctx.font = "600 14px Outfit, system-ui, sans-serif";
      ctx.fillText("No samples yet — waiting for live data…", 20, 36);
      return;
    }

    /*
     * Live scroll window:
     *  - Prefer wall-clock [now-range, now] so the series drifts left at a
     *    constant rate while the WS feed is alive.
     *  - Right edge may only lead the latest sample by LIVE_LEAD_MS.
     *  - "Stalled" is based on last WS push time (not sample ts age — those
     *    lag by design due to server-side bucketing).
     */
    var dataEnd = ext ? ext.tmax : nowMs;
    var dataAge = nowMs - dataEnd;
    /* Freshness = time since last successful WS series body (host or wifi). */
    var lastPush = Math.max(
      state.lastHostPushMs || 0,
      state.lastWifiPushMs || 0
    );
    var feedAge = lastPush > 0 ? nowMs - lastPush : 0;
    /* No banner until we've had at least one push (avoid flash on boot). */
    var stale = lastPush > 0 && feedAge > PUSH_STALE_MS;
    t1 = nowMs;
    t0 = nowMs - winMs;
    if (opts.t0 != null && isFinite(opts.t0)) t0 = opts.t0;
    if (opts.t1 != null && isFinite(opts.t1)) t1 = opts.t1;

    if (live && ext) {
      if (typeof LF.liveWindow === "function") {
        var lw = LF.liveWindow({
          nowMs: nowMs,
          durationMs: winMs,
          dataEndMs: dataEnd,
          lastPushMs: lastPush,
          leadMs: LIVE_LEAD_MS,
          staleMs: PUSH_STALE_MS
        });
        t0 = lw.t0;
        t1 = lw.t1;
        stale = lw.stale;
        feedAge = lw.feedAgeMs;
      } else if (stale) {
        /* WS feed stalled — pin to last sample so the chart doesn't empty. */
        t1 = dataEnd + LIVE_LEAD_MS;
        t0 = t1 - winMs;
      } else {
        /* Fresh feed: scroll with wall clock, cap lead past last sample. */
        var leadCap = dataEnd + LIVE_LEAD_MS;
        if (t1 > leadCap) t1 = leadCap;
        t0 = t1 - winMs;
      }
      var inWin = 0;
      for (i = 0; i < pts.length; i++) {
        v = parseTs(pts[i].ts);
        if (!isNaN(v) && v >= t0 - 5000 && v <= t1 + 5000) inWin++;
      }
      if (inWin === 0) {
        /* Clock skew / all points outside window: show data span (no banner). */
        live = false;
        t0 = ext.tmin;
        t1 = ext.tmax;
        if (t1 <= t0) {
          t0 = ext.tmax - winMs;
          t1 = ext.tmax;
        }
        if (t1 - t0 < 2000) {
          var mid = (t0 + t1) / 2;
          t0 = mid - Math.max(winMs, 60000) / 2;
          t1 = mid + Math.max(winMs, 60000) / 2;
        }
      }
    } else if (!ext) {
      t0 = 0;
      t1 = Math.max(1, pts.length - 1);
    }
    if (t1 <= t0) t1 = t0 + 1;
    /* Expose feed health for meta (shared). */
    if (opts.chartId === "cpu" || opts.chartId === "mem") {
      state.dataAgeMs = dataAge;
      state.dataStale = stale;
      state.lastSampleMs = dataEnd;
      state.feedAgeMs = feedAge;
    }

    /*
     * One tick behind: commit all but the newest sample into the polyline.
     * The newest sample is the live tip *target*; the head slides toward it.
     */
    committedN = live && pts.length >= 2 ? pts.length - 1 : pts.length;

    minY = Infinity;
    maxY = -Infinity;
    for (s = 0; s < series.length; s++) {
      for (i = 0; i < pts.length; i++) {
        v = Number(pts[i][series[s].key]);
        if (!isFinite(v)) continue;
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
    }
    if (!isFinite(minY) || !isFinite(maxY)) {
      minY = 0;
      maxY = 1;
    }
    if (opts.ymin != null) minY = opts.ymin;
    if (opts.ymax != null) maxY = opts.ymax;
    if (opts.fixedY) {
      minY = opts.ymin != null ? opts.ymin : 0;
      maxY = opts.ymax != null ? opts.ymax : 100;
    }
    if (maxY <= minY) maxY = minY + 1;
    if (opts.ymin == null) minY = minY - (maxY - minY) * 0.05;
    if (opts.ymax == null && !opts.fixedY) {
      maxY = maxY + (maxY - minY) * 0.12;
    }
    if (opts.maxLine != null && isFinite(opts.maxLine)) {
      if (opts.maxLine > maxY) maxY = opts.maxLine * 1.05;
      if (opts.maxLine < minY) minY = opts.maxLine;
    }
    if (opts.refLines) {
      for (i = 0; i < opts.refLines.length; i++) {
        v = opts.refLines[i].value;
        if (!isFinite(v)) continue;
        if (v > maxY) maxY = v * 1.05;
        if (v < minY && opts.ymin == null) minY = v;
      }
    }

    function xAtTime(t) {
      if (isNaN(t) || t1 === t0) return padL;
      var x = padL + ((W - padL - padR) * (t - t0)) / (t1 - t0);
      if (x < padL) return padL;
      if (x > W - padR) return W - padR;
      return x;
    }
    function xAtIdx(idx) {
      var t = parseTs(pts[idx].ts);
      if (isNaN(t)) {
        return padL + ((W - padL - padR) * idx) / Math.max(1, pts.length - 1);
      }
      return xAtTime(t);
    }
    function yAt(val) {
      return padT + (H - padT - padB) * (1 - (val - minY) / (maxY - minY));
    }

    /* plot background band */
    ctx.fillStyle = "rgba(8,12,18,0.55)";
    ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);

    /* grid + Y labels — high contrast */
    ctx.lineWidth = 1;
    for (i = 0; i <= 4; i++) {
      var gy = padT + ((H - padT - padB) * i) / 4;
      ctx.strokeStyle = i === 4 || i === 0 ? "#3a4558" : "#283040";
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(W - padR, gy);
      ctx.stroke();
      var gv = maxY - ((maxY - minY) * i) / 4;
      ctx.fillStyle = "#d4cfc6";
      ctx.font = "600 12px IBM Plex Mono, ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.fillText(opts.fmtY ? opts.fmtY(gv) : gv.toFixed(1), padL - 8, gy + 4);
    }
    ctx.textAlign = "left";

    if (opts.yLabel) {
      ctx.save();
      ctx.fillStyle = "#e8e2d8";
      ctx.font = "600 12px Outfit, system-ui, sans-serif";
      ctx.translate(14, padT + (H - padT - padB) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(opts.yLabel, 0, 0);
      ctx.restore();
    }

    function drawHLine(val, color, dash, label) {
      if (!isFinite(val) || val < minY || val > maxY) return;
      var y = yAt(val);
      ctx.save();
      ctx.strokeStyle = color || "#e87a82";
      ctx.lineWidth = 1.5;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.fillStyle = color || "#e87a82";
        ctx.font = "600 11px Outfit, system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(label, W - padR - 4, y - 4);
        ctx.textAlign = "left";
      }
      ctx.restore();
    }

    if (opts.maxLine != null) {
      drawHLine(
        opts.maxLine,
        "#e87a82",
        [6, 5],
        opts.maxLabel ||
          "max " + (opts.fmtY ? opts.fmtY(opts.maxLine) : opts.maxLine)
      );
    }
    if (opts.refLines) {
      for (i = 0; i < opts.refLines.length; i++) {
        var rl = opts.refLines[i];
        drawHLine(rl.value, rl.color, rl.dash || [5, 4], rl.label);
      }
    }

    /* Right-edge live X: at the (possibly lead-capped) window end. */
    var liveX = xAtTime(t1);

    /* Only when WS really stopped (not bucket lag). */
    if (stale) {
      ctx.fillStyle = "rgba(232, 122, 130, 0.12)";
      ctx.fillRect(padL, padT, W - padL - padR, 22);
      ctx.fillStyle = "#e87a82";
      ctx.font = "600 12px Outfit, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(
        "Live feed stalled · no chart update for " +
          Math.round(feedAge / 1000) +
          "s (showing last samples)",
        padL + 8,
        padT + 15
      );
    }

    for (s = 0; s < series.length; s++) {
      var ser = series[s];
      var color = ser.color || "#6b8cff";
      var lineW = ser.width != null ? ser.width : 2.4;
      var alpha = ser.alpha != null ? ser.alpha : 1;
      var lastCommitX = null;
      var lastCommitY = null;
      var lastCommitV = null;
      var targetV = null;
      var started = false;

      /* area fill under primary series (optional) */
      if (ser.fill) {
        ctx.beginPath();
        started = false;
        for (i = 0; i < committedN; i++) {
          v = Number(pts[i][ser.key]);
          if (!isFinite(v)) continue;
          var fx = xAtIdx(i);
          var fy = yAt(v);
          if (!started) {
            ctx.moveTo(fx, yAt(minY < 0 ? 0 : minY));
            ctx.lineTo(fx, fy);
            started = true;
          } else {
            ctx.lineTo(fx, fy);
          }
          lastCommitX = fx;
          lastCommitY = fy;
          lastCommitV = v;
        }
        if (started) {
          var tipFill = live
            ? liveTipY(chartId, ser.key, Number(pts[pts.length - 1][ser.key]), nowMs)
            : lastCommitV;
          if (live && isFinite(tipFill)) {
            ctx.lineTo(liveX, yAt(tipFill));
            ctx.lineTo(liveX, yAt(minY < 0 ? 0 : minY));
          } else {
            ctx.lineTo(lastCommitX, yAt(minY < 0 ? 0 : minY));
          }
          ctx.closePath();
          ctx.fillStyle = ser.fill;
          ctx.globalAlpha = 1;
          ctx.fill();
        }
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      started = false;
      lastCommitX = null;
      lastCommitY = null;
      lastCommitV = null;
      for (i = 0; i < committedN; i++) {
        v = Number(pts[i][ser.key]);
        if (!isFinite(v)) continue;
        var x = xAtIdx(i);
        var y = yAt(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastCommitX = x;
        lastCommitY = y;
        lastCommitV = v;
      }

      /* Morphing head: one sample behind, easing toward newest value */
      if (live && pts.length) {
        targetV = Number(pts[pts.length - 1][ser.key]);
        if (isFinite(targetV)) {
          var headV = liveTipY(chartId, ser.key, targetV, nowMs);
          var headY = yAt(headV);
          if (started && lastCommitX != null) {
            ctx.lineTo(liveX, headY);
          } else {
            ctx.moveTo(liveX, headY);
            started = true;
          }
          lastCommitX = liveX;
          lastCommitY = headY;
          lastCommitV = headV;
        }
      }
      if (started) ctx.stroke();
      ctx.globalAlpha = 1;

      /* Live edge dot — larger, with halo for readability */
      if (lastCommitX != null && lastCommitY != null) {
        ctx.beginPath();
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.arc(lastCommitX, lastCommitY, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(lastCommitX, lastCommitY, 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = "#fff";
        ctx.arc(lastCommitX, lastCommitY, 1.6, 0, Math.PI * 2);
        ctx.fill();
        /* value callout on right */
        if (ser.showTip !== false && lastCommitV != null && isFinite(lastCommitV)) {
          var tipTxt = opts.fmtY ? opts.fmtY(lastCommitV) : lastCommitV.toFixed(1);
          ctx.font = "600 12px IBM Plex Mono, ui-monospace, monospace";
          ctx.fillStyle = color;
          ctx.textAlign = "left";
          var ty = lastCommitY - 8;
          if (ty < padT + 10) ty = lastCommitY + 14;
          ctx.fillText(tipTxt, Math.min(lastCommitX + 8, W - padR - 4), ty);
        }
      }
    }

    /* Dual axis (e.g. noise dBm) */
    if (opts.dual && opts.dual.key) {
      var dmin = Infinity;
      var dmax = -Infinity;
      for (i = 0; i < pts.length; i++) {
        v = Number(pts[i][opts.dual.key]);
        if (!isFinite(v)) continue;
        if (v < dmin) dmin = v;
        if (v > dmax) dmax = v;
      }
      if (isFinite(dmin) && isFinite(dmax)) {
        if (opts.dual.ymin != null) dmin = opts.dual.ymin;
        if (opts.dual.ymax != null) dmax = opts.dual.ymax;
        if (dmax <= dmin) dmax = dmin + 1;
        function yDual(val) {
          return padT + (H - padT - padB) * (1 - (val - dmin) / (dmax - dmin));
        }
        var dColor = opts.dual.color || "#e0c040";
        var dKey = opts.dual.key;
        var dCommitted = live && pts.length >= 2 ? pts.length - 1 : pts.length;
        ctx.strokeStyle = dColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        started = false;
        var dLastX = null;
        var dLastY = null;
        for (i = 0; i < dCommitted; i++) {
          v = Number(pts[i][dKey]);
          if (!isFinite(v)) continue;
          if (!started) {
            ctx.moveTo(xAtIdx(i), yDual(v));
            started = true;
          } else {
            ctx.lineTo(xAtIdx(i), yDual(v));
          }
          dLastX = xAtIdx(i);
          dLastY = yDual(v);
        }
        if (live && pts.length) {
          var dTarget = Number(pts[pts.length - 1][dKey]);
          if (isFinite(dTarget)) {
            var dHead = liveTipY(chartId, "dual:" + dKey, dTarget, nowMs);
            var dHY = yDual(dHead);
            if (started) ctx.lineTo(liveX, dHY);
            else ctx.moveTo(liveX, dHY);
            dLastX = liveX;
            dLastY = dHY;
          }
        }
        if (started || dLastX != null) ctx.stroke();
        if (dLastX != null) {
          ctx.beginPath();
          ctx.fillStyle = dColor;
          ctx.arc(dLastX, dLastY, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#d4cfc6";
        ctx.font = "600 11px IBM Plex Mono, ui-monospace, monospace";
        ctx.textAlign = "left";
        for (i = 0; i <= 2; i++) {
          var dv = dmax - ((dmax - dmin) * i) / 2;
          var dy = padT + ((H - padT - padB) * i) / 2;
          ctx.fillText(
            opts.dual.fmtY ? opts.dual.fmtY(dv) : dv.toFixed(0),
            W - padR + 6,
            dy + 4
          );
        }
      }
    }

    /* time labels — wall-clock window edges */
    ctx.fillStyle = "#e8e2d8";
    ctx.font = "600 12px IBM Plex Mono, ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(fmtLocalTs(t0, "time"), padL, H - 10);
    ctx.textAlign = "right";
    ctx.fillText(
      fmtLocalTs(t1, "time") +
        (stale ? " · held" : live ? " · live" : ""),
      W - padR,
      H - 10
    );
    ctx.textAlign = "center";
    ctx.fillStyle = "#b8b2a8";
    ctx.font = "600 11px Outfit, system-ui, sans-serif";
    ctx.fillText(
      stale ? "time → (pinned — waiting for samples)" : "time → (scrolling)",
      padL + (W - padL - padR) / 2,
      H - 10
    );
    ctx.textAlign = "left";
  }

  function ensureAnimLoop() {
    if (state.animRaf) return;
    var lastDraw = 0;
    function frame(ts) {
      state.animRaf = requestAnimationFrame(frame);
      /* ~12 fps is enough for smooth scroll; 60 fps was starving the WS
       * onmessage handler and made the feed look stalled after ~30–60s. */
      if (document.hidden) return;
      if (ts - lastDraw < 80) return;
      lastDraw = ts;
      drawAllCharts();
      var now = Date.now();
      if (state.metaDirty || now - state.lastMetaMs > 400) {
        state.metaDirty = false;
        state.lastMetaMs = now;
        updateChartMeta();
      }
      /* REST safety net if WS host series stops (frame too large / drop). */
      if (
        now - (state.lastRestPollMs || 0) > 5000 &&
        (state.lastHostPushMs === 0 || now - state.lastHostPushMs > 8000)
      ) {
        state.lastRestPollMs = now;
        restPollHost();
      }
    }
    state.animRaf = requestAnimationFrame(frame);
  }

  function scheduleCharts() {
    state.metaDirty = true;
    ensureAnimLoop();
  }

  /** Bootstrap / fallback when multiplexed host pushes fail. */
  function restPollHost() {
    var opts = seriesOpts();
    var q =
      "/api/v1/cpe/host?minutes=" +
      encodeURIComponent(opts.minutes) +
      "&limit=" +
      encodeURIComponent(opts.limit);
    if (opts.router_id) {
      q += "&router_id=" + encodeURIComponent(opts.router_id);
    }
    fetch(q, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok === false || !Array.isArray(d.points)) return;
        if (!d.points.length) return; /* never wipe last-good */
        state.hostPts = mergeSeriesPts(state.hostPts, d.points);
        state.lastHostPushMs = Date.now();
        var lt = parseTs(
          state.hostPts.length
            ? state.hostPts[state.hostPts.length - 1].ts
            : d.points[d.points.length - 1].ts
        );
        if (!isNaN(lt)) state.lastSampleMs = lt;
        state.metaDirty = true;
        status(
          "host " +
            state.hostPts.length +
            " pts · REST merge · last sample " +
            Math.round((Date.now() - state.lastSampleMs) / 1000) +
            "s ago"
        );
      })
      .catch(function () {
        /* ignore */
      });
    var wq =
      "/api/v1/cpe/wifi?minutes=" +
      encodeURIComponent(opts.minutes) +
      "&limit=" +
      encodeURIComponent(opts.limit);
    if (opts.router_id) {
      wq += "&router_id=" + encodeURIComponent(opts.router_id);
    }
    fetch(wq, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok === false || !Array.isArray(d.points) || !d.points.length)
          return;
        state.wifiPts = mergeSeriesPts(state.wifiPts, d.points);
        state.lastWifiPushMs = Date.now();
        state.metaDirty = true;
      })
      .catch(function () {
        /* ignore */
      });
    restPollStations();
  }

  /**
   * Aggregate live flow list into per-LAN-IP clients when the radio dump is empty.
   * Not a substitute for RSSI, but shows which hosts are actually talking.
   */
  function restPollLanClients() {
    var opts = seriesOpts();
    var q =
      "/api/v1/flows?hours=1&limit=120" +
      (opts.router_id
        ? "&router_id=" + encodeURIComponent(opts.router_id)
        : "");
    fetch(q, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var flows = (d && (d.flows || d.points || d.items)) || [];
        if (!Array.isArray(flows)) flows = [];
        var byIp = {};
        var i, f, ip, rate, g;
        for (i = 0; i < flows.length; i++) {
          f = flows[i] || {};
          ip = String(f.lan_ip || "").trim() || "unknown";
          rate =
            (Number(f.rate_down_bps) || 0) + (Number(f.rate_up_bps) || 0);
          if (!byIp[ip]) {
            byIp[ip] = {
              lan_ip: ip,
              streams: 0,
              rate: 0,
              bytes: 0,
              last_ts: f.ts || ""
            };
          }
          g = byIp[ip];
          g.streams++;
          g.rate += rate;
          g.bytes +=
            (Number(f.bytes_down) || 0) + (Number(f.bytes_up) || 0);
          if (f.ts && (!g.last_ts || String(f.ts) > String(g.last_ts))) {
            g.last_ts = f.ts;
          }
        }
        state.lanClients = Object.keys(byIp)
          .map(function (k) {
            return byIp[k];
          })
          .sort(function (a, b) {
            return b.rate - a.rate;
          });
        state.lastLanMs = Date.now();
        renderWifiClients();
      })
      .catch(function () {
        /* ignore */
      });
  }

  /** Bootstrap + periodic REST for associated clients (also pushed on WS). */
  function restPollStations() {
    var opts = seriesOpts();
    /* minutes=0 → server live window (~120s); SPA drops on leave / miss polls. */
    var sq =
      "/api/v1/cpe/wifi/stations?minutes=0&limit=64" +
      (opts.router_id
        ? "&router_id=" + encodeURIComponent(opts.router_id)
        : "");
    fetch(sq, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok === false || !Array.isArray(d.stations)) return;
        mergeWifiStations(d.stations, { trackMiss: true });
        state.lastStationsMs = Date.now();
        if (!state.wifiStations.length) {
          restPollLanClients();
        }
        renderWifiClients();
      })
      .catch(function () {
        /* Network glitch: do not age-out associations (no miss increment). */
      });
  }

  function clientSeenAge(s) {
    var ms = parseTs(s && s.last_ts);
    if (isNaN(ms)) return { text: "—", stale: false };
    var age = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (age < 5) return { text: "now", stale: false };
    if (age < 60) return { text: age + "s ago", stale: age > 15 };
    return { text: Math.round(age / 60) + "m ago", stale: true };
  }

  function latestWifiAgentError() {
    var i;
    var best = null;
    var bestMs = 0;
    for (i = 0; i < state.wifiEv.length; i++) {
      var e = state.wifiEv[i];
      if (!e || String(e.event || "").toLowerCase() !== "error") continue;
      var ms = parseTs(e.ts);
      if (isNaN(ms)) ms = 0;
      if (!best || ms >= bestMs) {
        best = e;
        bestMs = ms;
      }
    }
    /* Prefer errors from the last 15 minutes. */
    if (best && bestMs && Date.now() - bestMs > 15 * 60 * 1000) {
      return null;
    }
    return best;
  }

  function renderWifiAgentBanner() {
    var el = $("wifiAgentBanner");
    if (!el) return;
    var err = latestWifiAgentError();
    var hasSamples = state.wifiPts && state.wifiPts.length > 0;
    var nSta = state.wifiStations ? state.wifiStations.length : 0;

    if (err) {
      var msg = String(err.client_mac || err.message || "wifi collection error");
      var codeHint = msg.indexOf("[no_stations]") >= 0 ||
        msg.indexOf("0 associated") >= 0;
      el.classList.remove("hidden");
      el.setAttribute("data-level", codeHint ? "warn" : "bad");
      el.innerHTML =
        "<strong>CPE agent</strong> · " +
        esc(fmtLocalTs(err.ts, "time")) +
        (err.ifname ? " · <code>" + esc(err.ifname) + "</code>" : "") +
        " · " +
        esc(msg);
      return;
    }

    if (hasSamples && nSta === 0) {
      var nLan = state.lanClients ? state.lanClients.length : 0;
      el.classList.remove("hidden");
      el.setAttribute("data-level", "warn");
      el.innerHTML =
        "<strong>No Wi‑Fi associations</strong> from hostapd wifi0/wifi1 " +
        "<code>all_sta</code> (iface samples show <code>stations=0</code>). " +
        (nLan
          ? "Showing <strong>" +
            nLan +
            " LAN host" +
            (nLan === 1 ? "" : "s") +
            "</strong> from flow accounting below — these may be Ethernet " +
            "or Wi‑Fi clients without a station dump."
          : "Redeploy <code>cpe_agent</code> and confirm <code>hostapd_cli -i wifi0 all_sta</code>.") +
        " Sample ifaces: " +
        esc(
          (state.wifiPts[state.wifiPts.length - 1] &&
            state.wifiPts[state.wifiPts.length - 1].ifname) ||
            "wifi0/wifi1"
        ) +
        ".";
      return;
    }

    el.classList.add("hidden");
    el.textContent = "";
  }

  function requestClientSeries(mac) {
    mac = macKey(mac);
    if (!mac) return;
    var opts = seriesOpts();
    var mins = opts.minutes || selectedMinutes() || 10;
    var lim = mins <= 15 ? mins * 60 + 30 : 600;
    var q =
      "/api/v1/cpe/wifi/stations/series?client_mac=" +
      encodeURIComponent(mac) +
      "&minutes=" +
      mins +
      "&limit=" +
      lim +
      (opts.router_id
        ? "&router_id=" + encodeURIComponent(opts.router_id)
        : "");
    fetch(q, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok === false || !Array.isArray(d.points)) return;
        state.clientSeries[mac] = { points: d.points };
        renderClientDetailCharts(mac);
      })
      .catch(function () {
        /* ignore */
      });
  }

  function toggleClientRow(mac) {
    mac = macKey(mac);
    if (!mac) return;
    if (state.expandedClients[mac]) {
      delete state.expandedClients[mac];
      delete state.clientSeries[mac];
    } else {
      state.expandedClients[mac] = true;
      requestClientSeries(mac);
    }
    renderWifiClients();
  }

  function pollExpandedClientSeries() {
    var macs = Object.keys(state.expandedClients || {});
    var i;
    for (i = 0; i < macs.length; i++) {
      if (state.expandedClients[macs[i]]) {
        requestClientSeries(macs[i]);
      }
    }
  }

  function renderClientDetailCharts(mac) {
    mac = macKey(mac);
    var safe = mac.replace(/:/g, "");
    var rssiCanvas = $("clientRssiChart_" + safe);
    var rateCanvas = $("clientRateChart_" + safe);
    var thrCanvas = $("clientThrChart_" + safe);
    var pts =
      (state.clientSeries[mac] && state.clientSeries[mac].points) || [];
    /* Convert link rates kbps → Mbps for readable Y axis. */
    var ratePts = pts.map(function (p) {
      return {
        ts: p.ts,
        tx_mbps: (Number(p.tx_bitrate_kbps) || 0) / 1000,
        rx_mbps: (Number(p.rx_bitrate_kbps) || 0) / 1000
      };
    });
    var thrPts = pts.map(function (p) {
      return {
        ts: p.ts,
        tx_mbps: (Number(p.tx_throughput_bps) || 0) / 1e6,
        rx_mbps: (Number(p.rx_throughput_bps) || 0) / 1e6
      };
    });
    var win = {
      windowMinutes: state.minutes || selectedMinutes(),
      live: true,
      height: 150
    };
    plotSeries(
      rssiCanvas,
      pts,
      [
        {
          key: "rssi",
          color: "#5ad67d",
          width: 2.4,
          fill: "rgba(90,214,125,0.10)",
          showTip: true
        },
        { key: "rssi_avg", color: "#5aa8ff", width: 1.6, showTip: false }
      ],
      Object.assign(
        {
          chartId: "clientRssi_" + safe,
          yLabel: "dBm",
          fmtY: function (v) {
            return (Number(v) || 0).toFixed(0) + " dBm";
          }
        },
        win
      )
    );
    plotSeries(
      rateCanvas,
      ratePts,
      [
        {
          key: "tx_mbps",
          color: "#6b8cff",
          width: 2.2,
          showTip: true
        },
        { key: "rx_mbps", color: "#f0a040", width: 2.0, showTip: true }
      ],
      Object.assign(
        {
          chartId: "clientRate_" + safe,
          ymin: 0,
          yLabel: "Mbps",
          fmtY: function (v) {
            return (Number(v) || 0).toFixed(v < 10 ? 1 : 0) + " Mbps";
          }
        },
        win
      )
    );
    plotSeries(
      thrCanvas,
      thrPts,
      [
        {
          key: "tx_mbps",
          color: "#e070f0",
          width: 2.2,
          fill: "rgba(224,112,240,0.08)",
          showTip: true
        },
        { key: "rx_mbps", color: "#4ecf9a", width: 2.0, showTip: true }
      ],
      Object.assign(
        {
          chartId: "clientThr_" + safe,
          ymin: 0,
          yLabel: "Mbps",
          fmtY: function (v) {
            return (Number(v) || 0).toFixed(v < 10 ? 2 : 1) + " Mbps";
          }
        },
        win
      )
    );
  }

  function renderWifiClients() {
    var tb = $("clientsTable") && $("clientsTable").querySelector("tbody");
    if (!tb) return;
    renderWifiAgentBanner();
    preserveScroll($("clientsScroll"), function () {
      /* Association map is leave-aware; do not TTL-drop by last_ts alone. */
      var rows = state.wifiStations.slice();
      /* Strongest signal first within each iface order from server. */
      rows.sort(function (a, b) {
        var ia = String(a.ifname || "");
        var ib = String(b.ifname || "");
        if (ia < ib) return -1;
        if (ia > ib) return 1;
        return (Number(b.rssi) || -999) - (Number(a.rssi) || -999);
      });
      if ($("clientsMeta")) {
        $("clientsMeta").textContent = rows.length
          ? rows.length +
            " Wi‑Fi client" +
            (rows.length === 1 ? "" : "s") +
            " · 1 Hz samples · click for coverage history"
          : state.lanClients && state.lanClients.length
            ? "0 Wi‑Fi · " +
              state.lanClients.length +
              " LAN host" +
              (state.lanClients.length === 1 ? "" : "s") +
              " from flows"
            : "0 clients · scanning associations";
      }
      if (!rows.length) {
        /* Fallback: active LAN hosts from flow accounting. */
        if (state.lanClients && state.lanClients.length) {
          var lhtml = "";
          var li;
          for (li = 0; li < state.lanClients.length; li++) {
            var c = state.lanClients[li];
            var seen = clientSeenAge({ last_ts: c.last_ts });
            lhtml +=
              '<tr class="client-row client-lan">' +
              '<td class="mac-cell">' +
              esc(c.lan_ip === "unknown" ? "unknown" : c.lan_ip) +
              "</td>" +
              "<td>flow/LAN</td>" +
              "<td>—</td>" +
              "<td>—</td>" +
              "<td>—</td>" +
              "<td>—</td>" +
              "<td colspan=\"3\">" +
              esc(fmtRate(c.rate)) +
              " · " +
              c.streams +
              " stream" +
              (c.streams === 1 ? "" : "s") +
              "</td>" +
              "<td>" +
              esc(seen.text) +
              "</td></tr>";
          }
          tb.innerHTML =
            '<tr class="hint"><td colspan="10">' +
            "No <code>subtype=station</code> rows from the radio dump. " +
            "Listing LAN IPs currently carrying traffic (from <code>cpe_flows</code>). " +
            "RSSI/band require hostapd all_sta + nl80211/iw enrich on the CPE." +
            "</td></tr>" +
            lhtml;
          return;
        }
        var agentErr = latestWifiAgentError();
        var emptyHint =
          "No associated Wi‑Fi clients and no recent flow LAN hosts. " +
          "If devices are online: redeploy cpe_agent, confirm CAP_NET_ADMIN / " +
          "hostapd ctrl, and check stderr for dump notes.";
        if (agentErr) {
          emptyHint +=
            " Agent: " +
            String(agentErr.client_mac || agentErr.message || "error reported");
        } else if (state.wifiPts && state.wifiPts.length) {
          emptyHint +=
            " Samples are flowing (stations=0 on all ifaces) — dump empty or " +
            "no associations.";
        }
        tb.innerHTML =
          '<tr><td colspan="10" class="hint">' + esc(emptyHint) + "</td></tr>";
        return;
      }
      var html = "";
      var i;
      for (i = 0; i < rows.length; i++) {
        var s = rows[i];
        var mac = String(s.client_mac || "");
        var mk = macKey(mac);
        var exp = !!state.expandedClients[mk];
        var rssi = Number(s.rssi) || 0;
        var snr = Number(s.snr) || 0;
        var band = bandFromFreq(s.freq_mhz);
        var tx = stationLinkTx(s);
        var rx = stationLinkRx(s);
        var thr = stationThroughput(s);
        var chains = fmtChainRssi(s);
        var seen = clientSeenAge(s);
        var cls = "client-row";
        if (exp) cls += " expanded";
        if (rssi <= -75) cls += " client-weak";
        else if (rssi >= -60) cls += " client-ok";
        if (seen.stale) cls += " client-stale";
        html +=
          '<tr class="' +
          cls +
          '" data-mac="' +
          esc(mk) +
          '">' +
          '<td class="mac-cell">' +
          esc(mac || "—") +
          (exp ? " ▾" : " ▸") +
          "</td>" +
          "<td>" +
          esc(s.ifname || "—") +
          "</td>" +
          "<td>" +
          (band.cls
            ? '<span class="band-tag ' + band.cls + '">' + esc(band.label) + "</span>"
            : esc(band.label)) +
          "</td>" +
          "<td>" +
          (rssi ? rssi + " dBm" : "—") +
          "</td>" +
          '<td class="chain-rssi-cell" title="' +
          esc(chains.title || "Per RF chain signal") +
          '">' +
          esc(chains.text) +
          "</td>" +
          "<td>" +
          (snr ? snr + " dB" : "—") +
          "</td>" +
          '<td class="rate-cell" title="PHY TX link rate (AP→client, sanitized)">' +
          esc(tx.text) +
          "</td>" +
          '<td class="rate-cell" title="PHY RX link rate (client→AP, sanitized)">' +
          esc(rx.text) +
          "</td>" +
          '<td class="rate-cell" title="' +
          esc(thr.title || "Actual throughput") +
          '">' +
          esc(thr.text) +
          "</td>" +
          '<td title="' +
          esc(fmtLocalTs(s.last_ts || s.ts, "datetime")) +
          '">' +
          esc(seen.text) +
          "</td></tr>";
        if (exp) {
          var safe = mk.replace(/:/g, "");
          html +=
            '<tr class="client-detail" data-mac="' +
            esc(mk) +
            '"><td colspan="10">' +
            '<div class="client-detail-head">' +
            "<div><strong>Coverage walk</strong> · <code>" +
            esc(mac) +
            "</code></div>" +
            "<div>" +
            esc(s.ifname || "") +
            " · " +
            esc(band.label) +
            " · live " +
            (state.minutes || selectedMinutes()) +
            " min window</div>" +
            "</div>" +
            '<div class="client-detail-grid">' +
            '<div><div class="client-detail-title">RSSI (coverage) — walk rooms and watch signal drop</div>' +
            '<canvas id="clientRssiChart_' +
            esc(safe) +
            '" width="360" height="140"></canvas>' +
            '<p class="client-detail-hint">Green = instant, blue = average. Ideal −30…−65 dBm; weak &lt; −75.</p></div>' +
            '<div><div class="client-detail-title">Link rate (PHY) — TX blue / RX orange</div>' +
            '<canvas id="clientRateChart_' +
            esc(safe) +
            '" width="360" height="140"></canvas>' +
            '<p class="client-detail-hint">Negotiated MCS rate after QCA 10× correction. Falls with distance/noise.</p></div>' +
            '<div><div class="client-detail-title">Throughput (actual) — from byte counters</div>' +
            '<canvas id="clientThrChart_' +
            esc(safe) +
            '" width="360" height="140"></canvas>' +
            '<p class="client-detail-hint">Real data rate. Near zero when idle; run iperf/speedtest for a load test.</p></div>' +
            "</div></td></tr>";
        }
      }
      tb.innerHTML = html;

      var trs = tb.querySelectorAll("tr.client-row[data-mac]");
      for (i = 0; i < trs.length; i++) {
        trs[i].addEventListener("click", function (ev) {
          var row = ev.currentTarget;
          var id = row.getAttribute("data-mac");
          if (id) toggleClientRow(id);
        });
      }
      for (i = 0; i < rows.length; i++) {
        var m2 = macKey(rows[i].client_mac);
        if (state.expandedClients[m2]) {
          renderClientDetailCharts(m2);
        }
      }
    });
  }

  function renderHealth() {
    var last = state.hostPts.length
      ? state.hostPts[state.hostPts.length - 1]
      : null;
    var wlast = state.wifiPts.length
      ? state.wifiPts[state.wifiPts.length - 1]
      : null;
    var alerts = [];
    var busy = busiestCore(last);
    var ncpu = state.nCpus || (last && Number(last.n_cpus)) || 0;
    var mem = last ? Number(last.mem_used_pct) || 0 : 0;
    var load1 = last ? Number(last.load1) || 0 : 0;
    var util = wlast ? Number(wlast.chan_util_pct) || 0 : 0;
    var noise = wlast ? Number(wlast.noise_dbm) || 0 : 0;
    var cpuLvl = levelFromPct(busy.pct, 70, 90);
    var memLvl = levelFromPct(mem, 80, 92);
    var loadPct = ncpu > 0 ? (load1 / ncpu) * 100 : load1 * 50;
    var loadLvl = levelFromPct(loadPct, 75, 100);
    var wifiLvl = levelFromPct(util, 55, 75);
    if (noise && noise > -80) {
      wifiLvl = wifiLvl === "bad" ? "bad" : "warn";
    }

    function setCard(id, level, val, barPct, cap) {
      var card = $(id);
      if (card) card.setAttribute("data-level", level || "ok");
      if ($(val.id)) $(val.id).textContent = val.text;
      if ($(barPct.id)) {
        $(barPct.id).style.width = Math.max(0, Math.min(100, barPct.pct)) + "%";
      }
      if (cap && $(cap.id)) $(cap.id).textContent = cap.text;
    }

    setCard(
      "healthCpu",
      cpuLvl,
      {
        id: "hhCpuVal",
        text: last
          ? busy.pct.toFixed(1) +
            "%" +
            (busy.idx >= 0 ? " · core " + busy.idx : "")
          : "—"
      },
      { id: "hhCpuBar", pct: busy.pct },
      {
        id: "hhCpuCap",
        text:
          "max 100% busy per core" +
          (ncpu ? " · " + ncpu + " cores" : "") +
          (last ? " · total " + (Number(last.cpu_pct) || 0).toFixed(1) + "%" : "")
      }
    );
    setCard(
      "healthMem",
      memLvl,
      {
        id: "hhMemVal",
        text: last ? mem.toFixed(1) + "% used" : "—"
      },
      { id: "hhMemBar", pct: mem },
      {
        id: "hhMemCap",
        text: last
          ? "of " +
            fmtMemKb(last.mem_total_kb) +
            " total · " +
            fmtMemKb(last.mem_avail_kb) +
            " free"
          : "of total RAM"
      }
    );
    setCard(
      "healthLoad",
      loadLvl,
      {
        id: "hhLoadVal",
        text: last
          ? load1.toFixed(2) + (ncpu ? " / " + ncpu + " cores" : "")
          : "—"
      },
      { id: "hhLoadBar", pct: Math.min(100, loadPct) },
      {
        id: "hhLoadCap",
        text: ncpu
          ? "capacity " + ncpu + ".0 = all cores busy"
          : "1.0 ≈ one fully busy core"
      }
    );
    setCard(
      "healthWifi",
      wlast ? wifiLvl : "ok",
      {
        id: "hhWifiVal",
        text: wlast
          ? util.toFixed(0) +
            "% util · " +
            (Number(wlast.stations) || 0) +
            " sta"
          : "—"
      },
      { id: "hhWifiBar", pct: util },
      {
        id: "hhWifiCap",
        text: wlast
          ? "noise " +
            (noise || "—") +
            " dBm · 100% = full airtime"
          : "util · interference risk"
      }
    );

    if (last) {
      if (busy.pct >= 90) {
        alerts.push({
          sev: "bad",
          t: "CPU core" + (busy.idx >= 0 ? " " + busy.idx : "") + " near exhaustion (" + busy.pct.toFixed(0) + "%)"
        });
      } else if (busy.pct >= 70) {
        alerts.push({
          sev: "warn",
          t: "High CPU on core" + (busy.idx >= 0 ? " " + busy.idx : "") + " (" + busy.pct.toFixed(0) + "%)"
        });
      }
      if ((Number(last.cpu_iowait_pct) || 0) >= 20) {
        alerts.push({
          sev: "warn",
          t: "I/O wait " + (Number(last.cpu_iowait_pct) || 0).toFixed(0) + "% — storage/path bottleneck"
        });
      }
      if (mem >= 92) {
        alerts.push({ sev: "bad", t: "Memory nearly full (" + mem.toFixed(0) + "%)" });
      } else if (mem >= 80) {
        alerts.push({ sev: "warn", t: "Memory high (" + mem.toFixed(0) + "%)" });
      }
      if (ncpu && load1 >= ncpu) {
        alerts.push({
          sev: "bad",
          t: "Load " + load1.toFixed(2) + " ≥ " + ncpu + " cores (run queue backlog)"
        });
      } else if (ncpu && load1 >= ncpu * 0.75) {
        alerts.push({
          sev: "warn",
          t: "Load elevated vs core count (" + load1.toFixed(2) + " / " + ncpu + ")"
        });
      }
    }
    if (wlast) {
      if (util >= 75) {
        alerts.push({
          sev: "bad",
          t: "Wi‑Fi channel saturated (" + util.toFixed(0) + "% airtime)"
        });
      } else if (util >= 55) {
        alerts.push({
          sev: "warn",
          t: "Wi‑Fi channel busy (" + util.toFixed(0) + "% util) — interference risk"
        });
      }
      if (noise && noise > -75) {
        alerts.push({
          sev: "bad",
          t: "Noisy RF environment (" + noise + " dBm noise floor)"
        });
      } else if (noise && noise > -85) {
        alerts.push({
          sev: "warn",
          t: "Elevated Wi‑Fi noise (" + noise + " dBm)"
        });
      }
    }
    var hotProcs = state.procs
      .slice()
      .sort(function (a, b) {
        return (Number(b.cpu_pct) || 0) - (Number(a.cpu_pct) || 0);
      })
      .slice(0, 3);
    var hi;
    for (hi = 0; hi < hotProcs.length; hi++) {
      if ((Number(hotProcs[hi].cpu_pct) || 0) >= 40) {
        alerts.push({
          sev: Number(hotProcs[hi].cpu_pct) >= 80 ? "bad" : "warn",
          t:
            "Process " +
            (hotProcs[hi].name || "?") +
            " using " +
            (Number(hotProcs[hi].cpu_pct) || 0).toFixed(0) +
            "% CPU"
        });
      }
    }
    if (!alerts.length) {
      alerts.push({ sev: "ok", t: "No resource warnings in this window" });
    }
    var ul = $("hhAlertList");
    if (ul) {
      ul.innerHTML = alerts
        .slice(0, 6)
        .map(function (a) {
          return '<li class="sev-' + a.sev + '">' + esc(a.t) + "</li>";
        })
        .join("");
    }
  }

  function buildCpuSeries() {
    var n = state.nCpus;
    var series = [];
    var i;
    if (n > 0) {
      for (i = 0; i < n && i < 8; i++) {
        series.push({
          key: "cpu" + i + "_pct",
          color: CORE_COLORS[i % CORE_COLORS.length],
          width: 2.5,
          /* Only busiest core gets a tip label to avoid clutter */
          showTip: false
        });
      }
      /* Tip on aggregate line */
    }
    series.push({
      key: "cpu_pct",
      color: "rgba(240,235,227,0.85)",
      width: 2.2,
      showTip: true
    });
    series.push({
      key: "cpu_iowait_pct",
      color: "#f0a040",
      width: 2,
      alpha: 0.95,
      showTip: false
    });
    return series;
  }

  function renderCpuLegend(last) {
    var el = $("cpuLegend");
    if (!el) return;
    var n = state.nCpus;
    var html = "";
    var i, v;
    if (n > 0) {
      for (i = 0; i < n && i < 8; i++) {
        v = last ? Number(last["cpu" + i + "_pct"]) || 0 : 0;
        html +=
          '<span class="leg leg-core' +
          i +
          '">core ' +
          i +
          " · " +
          v.toFixed(1) +
          "%</span>";
      }
    }
    html +=
      '<span class="leg leg-total">all cores avg · ' +
      (last ? (Number(last.cpu_pct) || 0).toFixed(1) : "—") +
      "%</span>";
    html +=
      '<span class="leg leg-iowait">iowait · ' +
      (last ? (Number(last.cpu_iowait_pct) || 0).toFixed(1) : "—") +
      "%</span>";
    html += '<span class="leg leg-max">100% = that core fully busy</span>';
    if (last) {
      html +=
        '<span class="hint">user ' +
        (Number(last.cpu_user_pct) || 0).toFixed(1) +
        "% · sys " +
        (Number(last.cpu_sys_pct) || 0).toFixed(1) +
        "%</span>";
    }
    el.innerHTML = html;
  }

  function updateChartMeta() {
    var winMin = state.minutes || selectedMinutes();
    var last = state.hostPts.length
      ? state.hostPts[state.hostPts.length - 1]
      : null;
    state.nCpus = detectNCpus(state.hostPts);
    var ncpu = state.nCpus;
    var wlast = state.wifiPts.length
      ? state.wifiPts[state.wifiPts.length - 1]
      : null;

    var pushS =
      state.lastHostPushMs > 0
        ? Math.max(0, Math.round((Date.now() - state.lastHostPushMs) / 1000))
        : null;
    var sampleS =
      state.lastSampleMs && isFinite(state.lastSampleMs)
        ? Math.max(0, Math.round((Date.now() - state.lastSampleMs) / 1000))
        : last
          ? Math.max(0, Math.round((Date.now() - parseTs(last.ts)) / 1000))
          : null;
    var feedNote =
      pushS == null
        ? ""
        : state.dataStale
          ? " · FEED STALE " + pushS + "s"
          : " · live";
    if ($("cpuMeta")) {
      $("cpuMeta").textContent = last
        ? (Number(last.cpu_pct) || 0).toFixed(1) +
          "% avg · " +
          (ncpu ? ncpu + " cores · " : "") +
          state.hostPts.length +
          " pts · " +
          fmtRangeLabel(winMin) +
          feedNote +
          (sampleS != null ? " · sample ~" + sampleS + "s" : "")
        : "—";
      $("cpuMeta").style.color = state.dataStale ? "var(--bad, #e87a82)" : "";
    }
    if ($("memMeta")) {
      $("memMeta").textContent = last
        ? (Number(last.mem_used_pct) || 0).toFixed(1) +
          "% of " +
          fmtMemKb(last.mem_total_kb)
        : "—";
    }
    if ($("netMeta")) {
      $("netMeta").textContent = last
        ? "↓ " + fmtRate(last.net_rx_bps) + "  ↑ " + fmtRate(last.net_tx_bps)
        : "—";
    }
    if ($("loadMeta")) {
      $("loadMeta").textContent = last
        ? (Number(last.load1) || 0).toFixed(2) +
          " / " +
          (Number(last.load5) || 0).toFixed(2) +
          " / " +
          (Number(last.load15) || 0).toFixed(2) +
          (ncpu ? " · capacity " + ncpu : "")
        : "—";
    }
    if ($("wifiMeta")) {
      $("wifiMeta").textContent = wlast
        ? (Number(wlast.stations) || 0).toFixed(0) +
          " stations · util " +
          (Number(wlast.chan_util_pct) || 0).toFixed(1) +
          "% · noise " +
          (wlast.noise_dbm != null ? wlast.noise_dbm + " dBm" : "—")
        : "—";
    }
    renderCpuLegend(last);
    renderHealth();
  }

  function drawAllCharts() {
    var win = { windowMinutes: state.minutes || selectedMinutes(), live: true };
    state.nCpus = detectNCpus(state.hostPts);
    var ncpu = state.nCpus;
    var i;

    plotSeries(
      $("cpuChart"),
      state.hostPts,
      buildCpuSeries(),
      Object.assign(
        {
          chartId: "cpu",
          height: 248,
          ymin: 0,
          ymax: 100,
          fixedY: true,
          yLabel: "% busy / core",
          maxLine: 100,
          maxLabel: "100% max",
          fmtY: function (v) {
            return v.toFixed(0) + "%";
          }
        },
        win
      )
    );

    plotSeries(
      $("memChart"),
      state.hostPts,
      [
        {
          key: "mem_used_pct",
          color: "#5ad67d",
          width: 2.6,
          fill: "rgba(90, 214, 125, 0.14)",
          showTip: true
        }
      ],
      Object.assign(
        {
          chartId: "mem",
          height: 248,
          ymin: 0,
          ymax: 100,
          fixedY: true,
          yLabel: "% of RAM",
          maxLine: 100,
          maxLabel: "100% full",
          refLines: [
            { value: 90, color: "#e87a82", dash: [4, 4], label: "90% warn" }
          ],
          fmtY: function (v) {
            return v.toFixed(0) + "%";
          }
        },
        win
      )
    );

    var peakNet = 0;
    for (i = 0; i < state.hostPts.length; i++) {
      peakNet = Math.max(
        peakNet,
        Number(state.hostPts[i].net_rx_bps) || 0,
        Number(state.hostPts[i].net_tx_bps) || 0
      );
    }
    plotSeries(
      $("netChart"),
      state.hostPts,
      [
        {
          key: "net_rx_bps",
          color: "#5aa8ff",
          width: 2.5,
          fill: "rgba(90, 168, 255, 0.12)",
          showTip: true
        },
        { key: "net_tx_bps", color: "#f0a040", width: 2.5, showTip: true }
      ],
      Object.assign(
        {
          chartId: "net",
          height: 248,
          ymin: 0,
          yLabel: "bits/s",
          maxLine: peakNet > 0 ? peakNet : null,
          maxLabel: peakNet > 0 ? "peak " + fmtRate(peakNet) : null,
          fmtY: function (v) {
            return fmtRate(v);
          }
        },
        win
      )
    );

    var peakLoad = 0;
    for (i = 0; i < state.hostPts.length; i++) {
      peakLoad = Math.max(
        peakLoad,
        Number(state.hostPts[i].load1) || 0,
        Number(state.hostPts[i].load5) || 0,
        Number(state.hostPts[i].load15) || 0
      );
    }
    var loadMax = Math.max(peakLoad * 1.15, ncpu || 1, 1);
    plotSeries(
      $("loadChart"),
      state.hostPts,
      [
        { key: "load1", color: "#5aa8ff", width: 2.6, showTip: true },
        { key: "load5", color: "#5ad67d", width: 2, showTip: false },
        { key: "load15", color: "#a8b0bc", width: 1.8, showTip: false }
      ],
      Object.assign(
        {
          chartId: "load",
          height: 220,
          ymin: 0,
          ymax: loadMax,
          yLabel: "load avg",
          refLines: ncpu
            ? [
                {
                  value: ncpu,
                  color: "#e0c040",
                  dash: [5, 4],
                  label: ncpu + " cores (capacity)"
                }
              ]
            : [],
          fmtY: function (v) {
            return v.toFixed(2);
          }
        },
        win
      )
    );

    plotSeries(
      $("wifiChart"),
      state.wifiPts,
      [
        { key: "stations", color: "#5ad67d", width: 2.4, showTip: true },
        {
          key: "chan_util_pct",
          color: "#e070f0",
          width: 2.5,
          fill: "rgba(224, 112, 240, 0.10)",
          showTip: true
        }
      ],
      Object.assign(
        {
          chartId: "wifi",
          height: 248,
          ymin: 0,
          yLabel: "stations / util %",
          refLines: [
            {
              value: 70,
              color: "#e87a82",
              dash: [5, 4],
              label: "70% util interference"
            }
          ],
          dual: {
            key: "noise_dbm",
            color: "#e0c040",
            fmtY: function (v) {
              return v.toFixed(0) + " dBm";
            }
          },
          fmtY: function (v) {
            return v.toFixed(0);
          }
        },
        win
      )
    );

    /* Expanded process sparklines also scroll/morph with the same loop */
    var pid;
    for (pid in state.expanded) {
      if (state.expanded[pid] && state.procSeries[pid]) {
        renderProcDetailCharts(pid);
      }
    }
  }

  function renderCharts() {
    updateChartMeta();
    drawAllCharts();
  }

  function preserveScroll(el, fn) {
    if (!el) {
      fn();
      return;
    }
    var top = el.scrollTop;
    fn();
    el.scrollTop = top;
  }

  function renderEvents() {
    preserveScroll($("wifiEvScroll"), function () {
      var tb = $("wifiEvTable").querySelector("tbody");
      var html = "";
      var i;
      var errN = 0;
      for (i = 0; i < state.wifiEv.length; i++) {
        var e = state.wifiEv[i];
        var ev = String(e.event || "");
        var rowCls = ev === "error" ? " class=\"ev-row-error\"" : "";
        if (ev === "error") errN++;
        html +=
          "<tr" +
          rowCls +
          "><td>" +
          esc(fmtLocalTs(e.ts)) +
          '</td><td class="ev-' +
          esc(ev) +
          '">' +
          esc(ev) +
          "</td><td>" +
          esc(e.ifname) +
          "</td><td>" +
          (ev === "error"
            ? '<span class="ev-error-msg">' + esc(e.client_mac) + "</span>"
            : esc(e.client_mac)) +
          "</td></tr>";
      }
      tb.innerHTML = html || '<tr><td colspan="4" class="hint">No events</td></tr>';
      if ($("wifiEvMeta")) {
        $("wifiEvMeta").textContent = errN
          ? errN + " agent error" + (errN === 1 ? "" : "s") + " · forensic"
          : "forensic";
      }
    });
    renderWifiAgentBanner();

    preserveScroll($("arpEvScroll"), function () {
      var tb = $("arpEvTable").querySelector("tbody");
      var html = "";
      var i, e;
      for (i = 0; i < state.arpEv.length; i++) {
        e = state.arpEv[i];
        html +=
          "<tr><td>" +
          esc(fmtLocalTs(e.ts)) +
          '</td><td class="ev-' +
          esc(e.event) +
          '">' +
          esc(e.event) +
          "</td><td>" +
          esc(e.ip) +
          "</td><td>" +
          esc(e.mac) +
          "</td><td>" +
          esc(e.dev) +
          "</td></tr>";
      }
      tb.innerHTML = html || '<tr><td colspan="5" class="hint">No events</td></tr>';
    });
  }

  function fmtCpuTime(ms) {
    ms = Number(ms) || 0;
    var sec = ms / 1000;
    if (sec < 60) return sec.toFixed(1) + "s";
    if (sec < 3600) {
      return Math.floor(sec / 60) + "m " + Math.floor(sec % 60) + "s";
    }
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    return h + "h " + m + "m";
  }

  function fmtStartAge(startUnix) {
    startUnix = Number(startUnix) || 0;
    if (startUnix <= 0) return "—";
    var startMs = startUnix * 1000;
    var ageSec = Math.max(0, (Date.now() - startMs) / 1000);
    var age;
    if (ageSec < 60) age = Math.floor(ageSec) + "s";
    else if (ageSec < 3600) age = Math.floor(ageSec / 60) + "m";
    else if (ageSec < 86400) {
      age =
        Math.floor(ageSec / 3600) +
        "h " +
        Math.floor((ageSec % 3600) / 60) +
        "m";
    } else age = Math.floor(ageSec / 86400) + "d";
    return fmtLocalTs(startMs) + " · " + age;
  }

  function sortedProcs() {
    var rows = state.procs.slice();
    var key = state.sortKey || "cpu_pct";
    var dir = state.sortDir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      var va = a[key];
      var vb = b[key];
      if (key === "name") {
        va = String(va || "").toLowerCase();
        vb = String(vb || "").toLowerCase();
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return (Number(a.pid) || 0) - (Number(b.pid) || 0);
      }
      va = Number(va) || 0;
      vb = Number(vb) || 0;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return (Number(a.pid) || 0) - (Number(b.pid) || 0);
    });
    return rows;
  }

  function updateSortHeaders() {
    var ths = document.querySelectorAll("#procTable thead th[data-sort]");
    var i;
    for (i = 0; i < ths.length; i++) {
      var k = ths[i].getAttribute("data-sort");
      ths[i].classList.remove("sort-asc", "sort-desc");
      if (k === state.sortKey) {
        ths[i].classList.add(state.sortDir === "asc" ? "sort-asc" : "sort-desc");
      }
    }
  }

  function requestProcSeries(pid) {
    if (!window.EdgeMux || !pid) return;
    var opts = seriesOpts();
    EdgeMux.send("host", "proc_series", {
      router_id: opts.router_id,
      minutes: opts.minutes,
      limit: 120,
      pid: Number(pid)
    });
    EdgeMux.watch("host", "proc_series", {
      router_id: opts.router_id,
      minutes: opts.minutes,
      limit: 120,
      pid: Number(pid)
    });
  }

  function unwatchProcSeries(pid) {
    if (!window.EdgeMux || !pid) return;
    EdgeMux.send("host", "unwatch", {
      mode: "proc_series",
      pid: Number(pid)
    });
  }

  function toggleProcRow(pid) {
    pid = String(pid);
    if (state.expanded[pid]) {
      delete state.expanded[pid];
      delete state.procSeries[pid];
      unwatchProcSeries(pid);
    } else {
      state.expanded[pid] = true;
      requestProcSeries(pid);
    }
    renderProcs();
  }

  function renderProcDetailCharts(pid) {
    var memCanvas = $("procMemChart_" + pid);
    var cpuCanvas = $("procCpuChart_" + pid);
    var pts =
      (state.procSeries[pid] && state.procSeries[pid].points) || [];
    var win = {
      windowMinutes: state.minutes || selectedMinutes(),
      live: true,
      height: 160
    };
    plotSeries(
      memCanvas,
      pts,
      [
        {
          key: "rss_kb",
          color: "#5ad67d",
          width: 2.2,
          fill: "rgba(90,214,125,0.12)",
          showTip: true
        },
        { key: "vsize_kb", color: "#5aa8ff", width: 1.8, showTip: false }
      ],
      Object.assign(
        {
          chartId: "procMem_" + pid,
          ymin: 0,
          yLabel: "memory",
          fmtY: function (v) {
            return fmtMemKb(v);
          }
        },
        win
      )
    );
    var peakCpu = 0;
    var i;
    for (i = 0; i < pts.length; i++) {
      peakCpu = Math.max(peakCpu, Number(pts[i].cpu_pct) || 0);
    }
    plotSeries(
      cpuCanvas,
      pts,
      [{ key: "cpu_pct", color: "#f0a040", width: 2.4, showTip: true }],
      Object.assign(
        {
          chartId: "procCpu_" + pid,
          ymin: 0,
          yLabel: "% CPU",
          maxLine: peakCpu > 0 ? peakCpu : null,
          maxLabel: peakCpu > 0 ? "peak " + peakCpu.toFixed(1) + "%" : null,
          fmtY: function (v) {
            return v.toFixed(1) + "%";
          }
        },
        win
      )
    );
  }

  function renderProcs() {
    var wrap = $("procScroll");
    var tb = $("procTable") && $("procTable").querySelector("tbody");
    if (!tb) return;
    preserveScroll(wrap, function () {
      var rows = sortedProcs();
      var html = "";
      var i;
      updateSortHeaders();
      $("procMeta").textContent = rows.length
        ? rows.length +
          " procs · sort " +
          state.sortKey +
          " " +
          state.sortDir +
          " · live (scroll preserved)"
        : "no samples yet";
      for (i = 0; i < rows.length; i++) {
        var p = rows[i];
        var pid = String(p.pid);
        var exp = !!state.expanded[pid];
        var cpu = Number(p.cpu_pct) || 0;
        var cls = "proc-row";
        if (exp) cls += " expanded";
        if (cpu >= 40) cls += " hot-cpu";
        if ((Number(p.rss_kb) || 0) > 200 * 1024) cls += " hot-mem";
        html +=
          '<tr class="' +
          cls +
          '" data-pid="' +
          esc(pid) +
          '">' +
          "<td>" +
          esc(p.name || "—") +
          "</td>" +
          "<td>" +
          esc(pid) +
          "</td>" +
          "<td>" +
          esc(fmtMemKb(p.vsize_kb)) +
          "</td>" +
          "<td>" +
          esc(fmtMemKb(p.rss_kb)) +
          "</td>" +
          "<td>" +
          esc(cpu.toFixed(1)) +
          "</td>" +
          "<td>" +
          esc(fmtCpuTime(p.cpu_time_ms)) +
          "</td>" +
          "<td>" +
          esc(fmtStartAge(p.start_unix)) +
          "</td></tr>";
        if (exp) {
          html +=
            '<tr class="proc-detail" data-pid="' +
            esc(pid) +
            '"><td colspan="7">' +
            '<div class="proc-detail-grid">' +
            '<div><div class="proc-detail-title">Memory (rss / vsize) — absolute KiB over time</div>' +
            '<canvas id="procMemChart_' +
            esc(pid) +
            '" width="440" height="140"></canvas></div>' +
            '<div><div class="proc-detail-title">CPU % — % of one core (can exceed 100% multi-thread)</div>' +
            '<canvas id="procCpuChart_' +
            esc(pid) +
            '" width="440" height="140"></canvas></div>' +
            "</div></td></tr>";
        }
      }
      tb.innerHTML =
        html ||
        '<tr><td colspan="7" class="hint">No process samples (waiting for cpe_proc)…</td></tr>';

      var trs = tb.querySelectorAll("tr.proc-row");
      for (i = 0; i < trs.length; i++) {
        trs[i].addEventListener("click", function (ev) {
          var row = ev.currentTarget;
          var id = row.getAttribute("data-pid");
          if (id) toggleProcRow(id);
        });
      }
      for (i = 0; i < rows.length; i++) {
        if (state.expanded[String(rows[i].pid)]) {
          renderProcDetailCharts(String(rows[i].pid));
        }
      }
    });
    renderHealth();
  }

  function onMux(msg) {
    if (!msg || msg.ch !== "host") return;
    var body = msg.body || {};
    if (msg.op === "host" || msg.op === "series") {
      if (body.ok === false) {
        status(
          "host error: " +
            (body.error || "query failed") +
            " · keeping last samples · " +
            state.wsStatus
        );
        /* Trigger REST fill if we have nothing yet. */
        if (!state.hostPts.length) restPollHost();
        return;
      }
      if (!Array.isArray(body.points)) return;
      /* Never replace a good series with an empty push. */
      if (!body.points.length) {
        if (!state.hostPts.length) restPollHost();
        return;
      }
      /* Merge tip-only WS frames into history (LiveFeed.mergeByTimestamp). */
      state.hostPts = mergeSeriesPts(state.hostPts, body.points);
      state.lastHostPushMs = Date.now();
      var lt = parseTs(
        state.hostPts.length
          ? state.hostPts[state.hostPts.length - 1].ts
          : body.points[body.points.length - 1].ts
      );
      if (!isNaN(lt)) state.lastSampleMs = lt;
      scheduleCharts();
      var lag =
        state.lastSampleMs > 0
          ? Math.round((Date.now() - state.lastSampleMs) / 1000)
          : "?";
      status(
        "host " +
          state.hostPts.length +
          " pts · last sample " +
          lag +
          "s ago · " +
          state.wsStatus
      );
    } else if (msg.op === "wifi") {
      if (body.ok === false || !Array.isArray(body.points)) return;
      if (!body.points.length) return;
      state.wifiPts = mergeSeriesPts(state.wifiPts, body.points);
      state.lastWifiPushMs = Date.now();
      scheduleCharts();
    } else if (msg.op === "wifi_stations") {
      if (body.ok === false || !Array.isArray(body.stations)) return;
      /* WS push is a snapshot — merge without miss aging (REST owns leave). */
      mergeWifiStations(body.stations, { trackMiss: false });
      state.lastStationsMs = Date.now();
      renderWifiClients();
    } else if (msg.op === "wifi_events") {
      if (body.ok === false || !Array.isArray(body.events)) return;
      state.wifiEv = body.events;
      /* Explicit hostapd leave → drop from Connected clients immediately. */
      var ei;
      for (ei = 0; ei < body.events.length; ei++) {
        var we = body.events[ei];
        if (we && String(we.event || "").toLowerCase() === "leave") {
          removeWifiStationMac(we.client_mac);
        }
      }
      renderEvents();
      renderWifiClients();
    } else if (msg.op === "arp_events") {
      if (body.ok === false || !Array.isArray(body.events)) return;
      state.arpEv = body.events;
      renderEvents();
    } else if (msg.op === "procs") {
      if (body.ok === false || !Array.isArray(body.processes)) return;
      state.procs = body.processes;
      renderProcs();
      status(
        "procs " +
          state.procs.length +
          " · host " +
          state.hostPts.length +
          " pts · " +
          state.wsStatus
      );
    } else if (msg.op === "proc_series") {
      if (body.ok === false || !Array.isArray(body.points)) return;
      var pid = body.pid != null ? String(body.pid) : null;
      if (!pid) return;
      state.procSeries[pid] = { points: body.points };
      if (state.expanded[pid]) {
        renderProcDetailCharts(pid);
      }
    } else if (msg.op === "error") {
      status(
        "error: " +
          (body.error || body.http_status || "unknown") +
          " · keeping last samples"
      );
      if (
        String(body.error || "").indexOf("too large") >= 0 ||
        !state.hostPts.length
      ) {
        restPollHost();
      }
    }
  }

  function subscribe() {
    if (!window.EdgeMux) {
      status("ws_mux.js missing");
      restPollHost();
      return;
    }
    var opts = seriesOpts();
    /* Without CPE, skip unfiltered watch (mixed multi-router series). */
    if (!opts.router_id) {
      status("no CPE — pick a location in the top bar");
      return;
    }
    EdgeMux.watch("host", "all", opts);
    /* REST bootstrap every subscribe / reconnect (seed merge buffer). */
    restPollHost();
    var p;
    for (p in state.expanded) {
      if (state.expanded[p]) requestProcSeries(p);
    }
    status(
      "watching " +
        (opts.router_id || "(all)") +
        " · " +
        fmtRangeLabel(opts.minutes) +
        " · lim " +
        opts.limit +
        " · " +
        state.wsStatus
    );
    /* Immediate REST bootstrap so graphs are not blank while WS catches up
     * or if host series exceeds the WS frame. */
    restPollHost();
    /* Poll stations every 2s so join/leave stays live even if a WS slot is busy. */
    if (state.stationsPollTimer) {
      clearInterval(state.stationsPollTimer);
    }
    state.stationsPollTimer = setInterval(restPollStations, 2000);
    /* Refresh open coverage charts (~1 s samples; poll every 2 s). */
    if (state.clientSeriesPollTimer) {
      clearInterval(state.clientSeriesPollTimer);
    }
    state.clientSeriesPollTimer = setInterval(pollExpandedClientSeries, 2000);
  }

  function ensureContextBanner() {
    var existing = $("contextEmpty");
    if (existing) return existing;
    var host = document.getElementById("edge-shell-content") || document.body;
    var el = document.createElement("div");
    el.id = "contextEmpty";
    el.className = "context-empty-banner";
    el.innerHTML =
      "Select a <strong>location</strong> in the top bar (or open " +
      '<a href="/devices/">Locations &amp; devices</a>) so host series know which CPE to watch.';
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
    if (ban) {
      if (rid) ban.classList.remove("is-visible");
      else ban.classList.add("is-visible");
    }
    var gl = $("graphsWorkspaceLink");
    if (gl && window.EdgeContext && EdgeContext.hrefWithContext) {
      gl.href = EdgeContext.hrefWithContext("/graphs/");
    }
  }

  function bootLive() {
    applyContextToFilter();
    if ($("filterRange")) {
      $("filterRange").addEventListener("change", function () {
        state.minutes = selectedMinutes();
        subscribe();
      });
    }
    if ($("filterRouter")) {
      $("filterRouter").addEventListener("change", function () {
        if (window.EdgeContext && EdgeContext.setRouter) {
          EdgeContext.setRouter($("filterRouter").value, { source: "user" });
        }
        subscribe();
      });
    }
    if (window.EdgeContext && EdgeContext.onChange) {
      EdgeContext.onChange(function (c) {
        applyContextToFilter(c);
        subscribe();
      });
    }
    var ths = document.querySelectorAll("#procTable thead th[data-sort]");
    var i;
    for (i = 0; i < ths.length; i++) {
      ths[i].addEventListener("click", function (ev) {
        var k = ev.currentTarget.getAttribute("data-sort");
        if (!k) return;
        if (state.sortKey === k) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = k;
          state.sortDir =
            k === "name" || k === "pid" || k === "start_unix" ? "asc" : "desc";
        }
        renderProcs();
      });
    }
    if (window.EdgeMux) {
      EdgeMux.on("host", onMux);
      EdgeMux.onStatus(function (st) {
        state.wsStatus = st;
        status("ws " + st);
        if (st === "open") subscribe();
      });
      EdgeMux.connect();
    }
    state.minutes = selectedMinutes();
    ensureAnimLoop();
    /* Auto-subscribe as soon as the page is open (and again on WS open). */
    subscribe();
  }

  function boot() {
    if (window.EdgeShell && EdgeShell.requireAuth) {
      EdgeShell.requireAuth().then(function (ok) {
        if (ok) bootLive();
      });
    } else {
      fetch("/auth/me", { credentials: "same-origin" })
        .then(function (r) {
          if (r.ok) bootLive();
          else location.replace("/?next=" + encodeURIComponent("/host/"));
        })
        .catch(function () {
          location.replace("/?next=" + encodeURIComponent("/host/"));
        });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
