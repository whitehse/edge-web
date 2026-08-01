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
    wifiFwPts: [], /* QDF radio health (xretry/underrun/ppdu) */
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
    lastClientSeriesMs: 0, /* last successful coverage-history REST fill */
    lastWifiFwMs: 0,
    stationsPollTimer: 0,
    clientSeriesPollTimer: 0,
    wifiFwPollTimer: 0,
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
    /*
     * ClickHouse DateTime/DateTime64 text is UTC without a zone:
     * "YYYY-MM-DD HH:mm:ss[.ms]". Prefer …T…Z before bare Date.parse — engines
     * often treat the space form as local, which shifts coverage-walk points
     * hours off the live window.
     */
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s) &&
        !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
      var tCh = Date.parse(s.replace(" ", "T") + "Z");
      if (!isNaN(tCh)) return tCh;
    }
    var t = Date.parse(s);
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

  /** Dense 1 Hz coverage history needs a higher point budget than host charts. */
  function mergeClientSeriesPts(prev, next) {
    var mins = state.minutes || selectedMinutes() || 10;
    var lookback = Math.max(60000, mins * 60000 + 30000);
    var limit = mins <= 15 ? mins * 60 + 90 : 1200;
    if (typeof LF.mergeByTimestamp === "function") {
      return LF.mergeByTimestamp(prev, next, lookback, {
        parseTs: parseTs,
        limit: limit
      });
    }
    return mergeSeriesPts(prev, next);
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
   * Absolute + residential inflate gates (mirror cpe_agent / edgehost ingest).
   * QCA driver rates over the gate but under absolute max were left uncorrected
   * by the old "only /10 when over max" logic → wild 600↔2164 Mbps charts.
   */
  var LINK_RATE_KBPS_MAX = 5000000; /* 5 Gbps */

  function phyModeCaps(phy) {
    phy = Number(phy) || 0;
    if (phy & 0x4) return { max: 2402000, gate: 1300000 }; /* HE */
    if (phy & 0x2) return { max: 1733000, gate: 900000 }; /* VHT */
    if (phy & 0x1) return { max: 600000, gate: 350000 }; /* HT */
    /* Unknown phy_mode: use HE-class gate so we still catch multi-gig
     * QCA ghosts without zeroing ordinary VHT/HT rates. */
    return { max: 2402000, gate: 1300000 };
  }

  function sanitizeLinkKbps(kbps, phyMode) {
    kbps = Number(kbps) || 0;
    if (kbps <= 0 || kbps > LINK_RATE_KBPS_MAX) return 0;
    var caps = phyModeCaps(phyMode);
    if (kbps > caps.max || kbps > caps.gate) {
      var d = Math.round(kbps / 10);
      if (d > 0 && d <= caps.max) return d;
      if (kbps > caps.max) return 0;
    }
    return kbps;
  }

  function stationLinkTx(s) {
    var kbps = sanitizeLinkKbps(s && s.tx_bitrate_kbps, s && s.phy_mode);
    if (kbps > 0) return { text: fmtLinkRate(kbps), est: false };
    return { text: "—", est: false };
  }

  function stationLinkRx(s) {
    var kbps = sanitizeLinkKbps(s && s.rx_bitrate_kbps, s && s.phy_mode);
    if (kbps > 0) return { text: fmtLinkRate(kbps), est: false };
    return { text: "—", est: false };
  }

  /**
   * Causal EMA on link-rate series so last-MPDU MCS chatter does not thrash
   * the coverage chart. Half-life ~2.5 s at 1 Hz samples. Zeros are gaps
   * (hold previous smoothed value) rather than cliffs to 0.
   */
  function smoothRatePts(pts, keys, halfLifeSec) {
    halfLifeSec = halfLifeSec || 2.5;
    if (!pts || !pts.length) return pts || [];
    var alphaPerSec = 1 - Math.exp(-Math.LN2 / halfLifeSec);
    var out = [];
    var prev = {};
    var prevT = NaN;
    var i, k, p, t, dt, a, v, sm, o;
    for (i = 0; i < keys.length; i++) prev[keys[i]] = null;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (!p) continue;
      t = typeof p.ts === "number" ? p.ts : parseTs(p.ts);
      o = Object.assign({}, p);
      dt = !isNaN(t) && !isNaN(prevT) ? Math.max(0, (t - prevT) / 1000) : 1;
      a = 1 - Math.pow(1 - alphaPerSec, Math.min(dt, 10));
      if (a < 0.05) a = 0.05;
      if (a > 1) a = 1;
      for (k = 0; k < keys.length; k++) {
        v = Number(p[keys[k]]);
        if (!isFinite(v) || v <= 0) {
          /* Hold last good smoothed value across idle gaps. */
          o[keys[k]] = prev[keys[k]] != null ? prev[keys[k]] : 0;
          continue;
        }
        if (prev[keys[k]] == null) sm = v;
        else sm = prev[keys[k]] + a * (v - prev[keys[k]]);
        prev[keys[k]] = sm;
        o[keys[k]] = sm;
      }
      if (!isNaN(t)) prevT = t;
      out.push(o);
    }
    return out;
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

  /**
   * Airtime efficiency: actual thr / PHY rate.
   * Low efficiency with high PHY often means retries, interference, or idle
   * negotiated rate (not a hard fault alone).
   */
  function stationEfficiency(s) {
    var phy = Number(s && s.phy_mode) || 0;
    var txPhy =
      sanitizeLinkKbps(s && s.tx_bitrate_kbps, phy) * 1000; /* kbps → bps */
    var rxPhy = sanitizeLinkKbps(s && s.rx_bitrate_kbps, phy) * 1000;
    var thrTx = Number(s && s.tx_throughput_bps) || 0;
    var thrRx = Number(s && s.rx_throughput_bps) || 0;
    var thr = Math.max(thrTx, thrRx);
    var phyMax = Math.max(txPhy, rxPhy);
    /* Need meaningful thr (>50 kbps) and PHY to score. */
    if (thr < 50000 || phyMax < 1e6) {
      return { text: "—", title: "Need active thr + PHY to score efficiency", pct: null };
    }
    var pct = (100 * thr) / phyMax;
    if (pct > 100) pct = 100;
    var title =
      "Actual thr / PHY = " +
      pct.toFixed(1) +
      "% (thr " +
      fmtThroughput(thr) +
      " / PHY " +
      fmtThroughput(phyMax) +
      "). Low + high PHY often means airtime waste.";
    return {
      text: pct.toFixed(0) + "%",
      title: title,
      pct: pct,
      low: pct < 5 && thr > 100000
    };
  }

  /**
   * Association / security / retry fault badges from hostapd + driver fields.
   */
  function stationStatusBadges(s) {
    var badges = [];
    var inactive = Number(s && s.inactive_msec) || 0;
    var ptk = Number(s && s.ptk_state) || 0;
    var mic = Number(s && s.mic_failures) || 0;
    var flags = Number(s && s.assoc_flags) || 0;
    var retryD = Number(s && s.tx_retry_delta) || 0;
    var failD = Number(s && s.tx_failed_delta) || 0;
    var retries = Number(s && s.tx_retries) || 0;
    var failed = Number(s && s.tx_failed) || 0;
    var AUTH = 0x1;
    var ASSOC = 0x2;
    var AUTHORIZED = 0x4;
    var eff = stationEfficiency(s);

    if (inactive >= 60000) {
      badges.push({
        cls: "sta-badge sta-idle",
        text: "idle " + Math.round(inactive / 1000) + "s",
        title: "No STA activity for " + inactive + " ms (hostapd inactive_msec)"
      });
    } else if (inactive >= 15000) {
      badges.push({
        cls: "sta-badge sta-quiet",
        text: "quiet",
        title: "inactive_msec=" + inactive
      });
    }
    if (flags && !(flags & ASSOC) && flags & AUTH) {
      badges.push({
        cls: "sta-badge sta-partial",
        text: "auth-only",
        title: "AUTH without ASSOC (partial association)"
      });
    } else if (flags && !(flags & AUTHORIZED) && flags & ASSOC) {
      badges.push({
        cls: "sta-badge sta-partial",
        text: "no-authz",
        title: "ASSOC without AUTHORIZED"
      });
    }
    /* hostapdWPAPTKState: 11 = installed; 0 = incomplete (common stuck state). */
    if (flags & ASSOC && ptk === 0) {
      badges.push({
        cls: "sta-badge sta-ptk",
        text: "ptk?",
        title: "WPAPTKState=0 while associated (incomplete PTK)"
      });
    }
    if (mic > 0) {
      badges.push({
        cls: "sta-badge sta-mic",
        text: "MIC " + mic,
        title: "TKIP MIC failures (local+remote) = " + mic
      });
    }
    if (retryD >= 20 || failD >= 5) {
      badges.push({
        cls: "sta-badge sta-retry",
        text: failD >= 5 ? "fail +" + failD : "retry +" + retryD,
        title:
          "Per-tick TX retry Δ=" +
          retryD +
          " failed Δ=" +
          failD +
          " (cumulative retries=" +
          retries +
          " failed=" +
          failed +
          ")"
      });
    } else if (retries > 0 && retries >= 500) {
      badges.push({
        cls: "sta-badge sta-retry-soft",
        text: "rtry " + retries,
        title: "Cumulative TX retries=" + retries + " failed=" + failed
      });
    }
    if (eff.low) {
      badges.push({
        cls: "sta-badge sta-eff",
        text: "low-eff",
        title: eff.title
      });
    }
    if (!badges.length) {
      return { html: '<span class="hint">—</span>', cls: "" };
    }
    var html = badges
      .map(function (b) {
        return (
          '<span class="' +
          b.cls +
          '" title="' +
          esc(b.title) +
          '">' +
          esc(b.text) +
          "</span>"
        );
      })
      .join(" ");
    return { html: html, cls: " has-status" };
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
    /* Freshness = last successful push for this chart (or host/wifi default). */
    var lastPush =
      opts.lastPushMs != null && isFinite(opts.lastPushMs)
        ? opts.lastPushMs
        : Math.max(state.lastHostPushMs || 0, state.lastWifiPushMs || 0);
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
    restPollWifiFw();
    /* proc_stats disabled on cpe_agent — skip Processes REST poll */
  }

  /** Merge process snapshot: keep live CPU/RSS; never freeze on a zero-cpu dump. */
  function applyProcSnapshot(incoming) {
    if (!Array.isArray(incoming) || !incoming.length) return false;
    var prev = state.procs || [];
    var prevCpuNz = 0;
    var i;
    for (i = 0; i < prev.length; i++) {
      if (Number(prev[i].cpu_pct) > 0) prevCpuNz++;
    }
    var nextCpuNz = 0;
    var nextMaxTs = 0;
    for (i = 0; i < incoming.length; i++) {
      if (Number(incoming[i].cpu_pct) > 0) nextCpuNz++;
      var t = parseTs(incoming[i].last_ts || incoming[i].ts);
      if (!isNaN(t) && t > nextMaxTs) nextMaxTs = t;
    }
    /* Reject a large all-idle dump when we already have live CPU rows. */
    if (
      prevCpuNz >= 3 &&
      nextCpuNz === 0 &&
      incoming.length >= Math.max(16, prev.length * 0.6)
    ) {
      return false;
    }
    /* Thin partial (< half) only if it has no better CPU signal. */
    if (
      prev.length > 32 &&
      incoming.length < prev.length * 0.5 &&
      nextCpuNz <= prevCpuNz
    ) {
      return false;
    }
    state.procs = incoming;
    state.procsLastMs = nextMaxTs || Date.now();
    return true;
  }

  /** Full process table REST bootstrap (WS procs watch can lag on reconnect). */
  function restPollProcs() {
    var opts = seriesOpts();
    var q = "/api/v1/cpe/procs?limit=512";
    if (opts.router_id) {
      q += "&router_id=" + encodeURIComponent(opts.router_id);
    }
    fetch(q, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok === false || !Array.isArray(d.processes)) return;
        if (applyProcSnapshot(d.processes)) renderProcs();
      })
      .catch(function () {
        /* ignore */
      });
  }

  /** QDF HTT radio health (xretry / underrun / PPDU) for Radio health chart. */
  function restPollWifiFw() {
    var opts = seriesOpts();
    var mins = opts.minutes || selectedMinutes() || 10;
    var lim = mins <= 15 ? mins * 60 + 30 : 600;
    var q =
      "/api/v1/cpe/wifi/fw?minutes=" +
      encodeURIComponent(mins) +
      "&limit=" +
      encodeURIComponent(lim);
    if (opts.router_id) {
      q += "&router_id=" + encodeURIComponent(opts.router_id);
    }
    fetch(q, { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || d.ok === false || !Array.isArray(d.points)) return;
        state.wifiFwPts = d.points;
        state.lastWifiFwMs = Date.now();
        state.metaDirty = true;
        scheduleCharts();
      })
      .catch(function () {
        /* ignore */
      });
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
        /* Keep coverage-walk tips live with the association snapshot. */
        if (anyClientExpanded()) {
          scheduleCharts();
        }
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

  function stationForMac(mac) {
    mac = macKey(mac);
    var ent = state.wifiStationMap && state.wifiStationMap[mac];
    return ent && ent.s ? ent.s : null;
  }

  /**
   * Live tip from the current association snapshot (2 s station poll / WS).
   * CH series history can lag ~several seconds; the tip keeps coverage charts
   * tracking the same RSSI/rates as the Connected clients table in real time.
   */
  function liveTipFromStation(s) {
    if (!s) return null;
    var phy = Number(s.phy_mode) || 0;
    return {
      ts: Date.now(),
      ifname: s.ifname || "",
      rssi: Number(s.rssi) || 0,
      rssi_avg: Number(s.rssi_avg) || 0,
      snr: Number(s.snr) || 0,
      freq_mhz: Number(s.freq_mhz) || 0,
      tx_bitrate_kbps: sanitizeLinkKbps(s.tx_bitrate_kbps, phy),
      rx_bitrate_kbps: sanitizeLinkKbps(s.rx_bitrate_kbps, phy),
      tx_throughput_bps: Number(s.tx_throughput_bps) || 0,
      rx_throughput_bps: Number(s.rx_throughput_bps) || 0,
      chain_rssi: s.chain_rssi != null ? s.chain_rssi : "",
      phy_mode: phy,
      tx_retries: Number(s.tx_retries) || 0,
      tx_failed: Number(s.tx_failed) || 0,
      tx_retry_delta: Number(s.tx_retry_delta) || 0,
      tx_failed_delta: Number(s.tx_failed_delta) || 0,
      _live: 1
    };
  }

  /** History from ClickHouse + live tip at wall-clock now (for plotSeries). */
  function clientSeriesForChart(mac) {
    mac = macKey(mac);
    var hist =
      (state.clientSeries[mac] && state.clientSeries[mac].points) || [];
    var tip = liveTipFromStation(stationForMac(mac));
    if (!tip) return hist;
    var tipT = tip.ts;
    var out = [];
    var i;
    for (i = 0; i < hist.length; i++) {
      var p = hist[i];
      if (!p || p._live) continue;
      var t = parseTs(p.ts);
      /* Leave the right edge to the live tip (morph target). */
      if (!isNaN(t) && tipT - t < 2000 && t <= tipT) continue;
      out.push(p);
    }
    out.push(tip);
    return out;
  }

  function clientChartLastPushMs() {
    return Math.max(
      state.lastStationsMs || 0,
      state.lastClientSeriesMs || 0,
      state.lastWifiPushMs || 0
    );
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
        var prev =
          (state.clientSeries[mac] && state.clientSeries[mac].points) || [];
        /* Accumulate history; never wipe a longer buffer with a short reply. */
        state.clientSeries[mac] = {
          points: mergeClientSeriesPts(prev, d.points)
        };
        state.lastClientSeriesMs = Date.now();
        scheduleCharts();
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
      scheduleCharts();
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

  function anyClientExpanded() {
    var macs = Object.keys(state.expandedClients || {});
    var i;
    for (i = 0; i < macs.length; i++) {
      if (state.expandedClients[macs[i]]) return true;
    }
    return false;
  }

  function renderClientDetailCharts(mac) {
    mac = macKey(mac);
    if (!mac || !state.expandedClients[mac]) return;
    var safe = mac.replace(/:/g, "");
    var rssiCanvas = $("clientRssiChart_" + safe);
    var rateCanvas = $("clientRateChart_" + safe);
    var thrCanvas = $("clientThrChart_" + safe);
    var retryCanvas = $("clientRetryChart_" + safe);
    if (!rssiCanvas && !rateCanvas && !thrCanvas && !retryCanvas) return;
    var pts = clientSeriesForChart(mac);
    /* Sanitize + smooth PHY rates: fix residual QCA 10×, tame last-MPDU jumps. */
    var ratePts = smoothRatePts(
      pts.map(function (p) {
        var phy = Number(p.phy_mode) || 0;
        return {
          ts: p.ts,
          tx_mbps: sanitizeLinkKbps(p.tx_bitrate_kbps, phy) / 1000,
          rx_mbps: sanitizeLinkKbps(p.rx_bitrate_kbps, phy) / 1000
        };
      }),
      ["tx_mbps", "rx_mbps"],
      2.5
    );
    var thrPts = pts.map(function (p) {
      return {
        ts: p.ts,
        tx_mbps: (Number(p.tx_throughput_bps) || 0) / 1e6,
        rx_mbps: (Number(p.rx_throughput_bps) || 0) / 1e6
      };
    });
    /* Prefer agent deltas; fall back to cumulative differencing for old data. */
    var retryPts = [];
    var ri;
    var prevR = null;
    var prevF = null;
    for (ri = 0; ri < pts.length; ri++) {
      var rp = pts[ri];
      var rd = Number(rp.tx_retry_delta);
      var fd = Number(rp.tx_failed_delta);
      var rc = Number(rp.tx_retries) || 0;
      var fc = Number(rp.tx_failed) || 0;
      if (!isFinite(rd) || rd < 0) {
        rd = prevR != null && rc >= prevR ? rc - prevR : 0;
      }
      if (!isFinite(fd) || fd < 0) {
        fd = prevF != null && fc >= prevF ? fc - prevF : 0;
      }
      prevR = rc;
      prevF = fc;
      retryPts.push({ ts: rp.ts, retry_delta: rd, failed_delta: fd });
    }
    var win = {
      windowMinutes: state.minutes || selectedMinutes(),
      live: true,
      height: 150,
      /* Station poll freshness drives live scroll (not host WS alone). */
      lastPushMs: clientChartLastPushMs()
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
    plotSeries(
      retryCanvas,
      retryPts,
      [
        {
          key: "retry_delta",
          color: "#e87a82",
          width: 2.2,
          fill: "rgba(232,122,130,0.10)",
          showTip: true
        },
        {
          key: "failed_delta",
          color: "#f0a040",
          width: 1.8,
          showTip: true
        }
      ],
      Object.assign(
        {
          chartId: "clientRetry_" + safe,
          ymin: 0,
          yLabel: "Δ / sample",
          fmtY: function (v) {
            return (Number(v) || 0).toFixed(0);
          }
        },
        win
      )
    );
  }

  function renderExpandedClientCharts() {
    var macs = Object.keys(state.expandedClients || {});
    var i;
    for (i = 0; i < macs.length; i++) {
      if (state.expandedClients[macs[i]]) {
        renderClientDetailCharts(macs[i]);
      }
    }
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
            " · live · click for coverage history"
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
              "<td>—</td>" +
              "<td>" +
              esc(seen.text) +
              "</td></tr>";
          }
          tb.innerHTML =
            '<tr class="hint"><td colspan="11">' +
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
          '<tr><td colspan="12" class="hint">' + esc(emptyHint) + "</td></tr>";
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
        var eff = stationEfficiency(s);
        var chains = fmtChainRssi(s);
        var stBadges = stationStatusBadges(s);
        var seen = clientSeenAge(s);
        var cls = "client-row";
        if (exp) cls += " expanded";
        if (rssi <= -75) cls += " client-weak";
        else if (rssi >= -60) cls += " client-ok";
        if (seen.stale) cls += " client-stale";
        if (stBadges.cls) cls += stBadges.cls;
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
          '<td class="rate-cell' +
          (eff.low ? " eff-low" : "") +
          '" title="' +
          esc(eff.title || "Airtime efficiency") +
          '">' +
          esc(eff.text) +
          "</td>" +
          '<td class="status-cell">' +
          stBadges.html +
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
            '"><td colspan="12">' +
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
            '<div><div class="client-detail-title">TX retries / fails — per sample Δ</div>' +
            '<canvas id="clientRetryChart_' +
            esc(safe) +
            '" width="360" height="140"></canvas>' +
            '<p class="client-detail-hint">Red = retry Δ, orange = failed Δ. Spikes during walks = RF stress.</p></div>' +
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
          (wlast.noise_dbm != null ? wlast.noise_dbm + " dBm" : "—") +
          (Number(wlast.has_survey) ? "" : " · no survey")
        : "—";
    }
    if ($("wifiFwMeta")) {
      var fw = state.wifiFwPts || [];
      var lastXr = 0;
      var lastUnd = 0;
      var radios = {};
      var j;
      for (j = 0; j < fw.length; j++) {
        var p = fw[j];
        if (!p) continue;
        if (p.radio) radios[p.radio] = 1;
        var xr = Number(p.xretry_pct) || 0;
        if (xr > lastXr) lastXr = xr;
        lastUnd += Number(p.underrun_delta) || 0;
      }
      /* Prefer last bucket only for underrun tip */
      if (fw.length) {
        var lastTs = fw[fw.length - 1].ts;
        lastUnd = 0;
        lastXr = 0;
        for (j = 0; j < fw.length; j++) {
          if (String(fw[j].ts) !== String(lastTs)) continue;
          lastUnd += Number(fw[j].underrun_delta) || 0;
          lastXr = Math.max(lastXr, Number(fw[j].xretry_pct) || 0);
        }
      }
      var rnames = Object.keys(radios);
      $("wifiFwMeta").textContent = fw.length
        ? "xretry " +
          lastXr.toFixed(1) +
          "% · underrun Δ " +
          lastUnd +
          (rnames.length ? " · " + rnames.join("+") : "") +
          " · " +
          fw.length +
          " pts"
        : "waiting for QDF fw samples…";
      $("wifiFwMeta").style.color =
        lastXr >= 3 ? "var(--bad, #e87a82)" : lastXr >= 1.5 ? "var(--warn, #f0a040)" : "";
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

    /* Radio health: collapse multi-radio FW points to one series per ts. */
    var fwAgg = {};
    var fwList = [];
    var fi;
    for (fi = 0; fi < (state.wifiFwPts || []).length; fi++) {
      var fp = state.wifiFwPts[fi];
      if (!fp || !fp.ts) continue;
      var fkey = String(fp.ts);
      var cur = fwAgg[fkey];
      var xr = Number(fp.xretry_pct) || 0;
      var und = Number(fp.underrun_delta) || 0;
      var pp = Number(fp.ppdu_ok_delta) || 0;
      var fr = Number(fp.rssi);
      if (!cur) {
        fwAgg[fkey] = {
          ts: fp.ts,
          xretry_pct: xr,
          underrun_delta: und,
          ppdu_ok_delta: pp,
          /* Scale PPDU to fit % axis (~100 PPDU/s → 100). */
          ppdu_scaled: Math.min(100, pp / 10),
          rssi: isFinite(fr) && fr !== 0 ? fr : null
        };
      } else {
        if (xr > cur.xretry_pct) cur.xretry_pct = xr;
        cur.underrun_delta += und;
        cur.ppdu_ok_delta += pp;
        cur.ppdu_scaled = Math.min(100, cur.ppdu_ok_delta / 10);
        if (isFinite(fr) && fr !== 0) {
          if (cur.rssi == null) cur.rssi = fr;
          else cur.rssi = Math.min(cur.rssi, fr);
        }
      }
    }
    for (fi in fwAgg) {
      if (Object.prototype.hasOwnProperty.call(fwAgg, fi)) {
        fwList.push(fwAgg[fi]);
      }
    }
    fwList.sort(function (a, b) {
      return parseTs(a.ts) - parseTs(b.ts);
    });
    plotSeries(
      $("wifiFwChart"),
      fwList,
      [
        {
          key: "xretry_pct",
          color: "#e87a82",
          width: 2.4,
          fill: "rgba(232,122,130,0.10)",
          showTip: true
        },
        {
          key: "underrun_delta",
          color: "#f0a040",
          width: 1.6,
          showTip: true
        },
        {
          key: "ppdu_scaled",
          color: "#6b8cff",
          width: 1.4,
          showTip: false
        }
      ],
      Object.assign(
        {
          chartId: "wifiFw",
          height: 220,
          ymin: 0,
          yLabel: "xretry % · underrun Δ",
          refLines: [
            {
              value: 3,
              color: "#e87a82",
              dash: [5, 4],
              label: "3% xretry caution"
            }
          ],
          dual: {
            key: "rssi",
            color: "#5ad67d",
            fmtY: function (v) {
              return (Number(v) || 0).toFixed(0) + " dBm";
            }
          },
          fmtY: function (v) {
            return v.toFixed(v < 10 ? 1 : 0);
          },
          lastPushMs: Math.max(
            state.lastWifiFwMs || 0,
            state.lastWifiPushMs || 0
          )
        },
        win
      )
    );

    /* Fault timeline: xretry base + join/leave/error event markers. */
    drawFaultTimeline($("faultChart"), fwList, state.wifiEv || [], win);

    /* Expanded process sparklines also scroll/morph with the same loop */
    var pid;
    for (pid in state.expanded) {
      if (state.expanded[pid] && state.procSeries[pid]) {
        renderProcDetailCharts(pid);
      }
    }
    /* Coverage-walk charts: live tip from station snapshot + CH history. */
    if (anyClientExpanded()) {
      renderExpandedClientCharts();
    }
  }

  /**
   * Fault timeline: plot xretry and overlay join/leave/error markers.
   * Uses plotSeries for the base line, then draws event ticks on top.
   */
  function drawFaultTimeline(canvas, fwList, events, win) {
    if (!canvas) return;
    var base = (fwList || []).map(function (p) {
      return { ts: p.ts, xretry_pct: Number(p.xretry_pct) || 0 };
    });
    /* Inject zero-height points at event times so the window spans them. */
    var i;
    var evPts = [];
    for (i = 0; i < (events || []).length; i++) {
      var e = events[i];
      if (!e || !e.ts) continue;
      var kind = String(e.event || "").toLowerCase();
      var y = kind === "join" ? 2 : kind === "leave" ? 4 : kind === "error" ? 6 : 3;
      evPts.push({
        ts: e.ts,
        xretry_pct: null,
        _ev: kind,
        _yMark: y,
        _mac: e.client_mac || e.message || ""
      });
    }
    plotSeries(
      canvas,
      base.length ? base : [{ ts: new Date().toISOString(), xretry_pct: 0 }],
      [
        {
          key: "xretry_pct",
          color: "rgba(232,122,130,0.85)",
          width: 2.0,
          fill: "rgba(232,122,130,0.08)",
          showTip: true
        }
      ],
      Object.assign(
        {
          chartId: "fault",
          height: 200,
          ymin: 0,
          yLabel: "xretry %",
          refLines: [
            {
              value: 3,
              color: "#e87a82",
              dash: [4, 4],
              label: "3%"
            }
          ],
          fmtY: function (v) {
            return v.toFixed(v < 10 ? 1 : 0);
          },
          lastPushMs: Math.max(
            state.lastWifiFwMs || 0,
            state.lastWifiPushMs || 0,
            state.lastStationsMs || 0
          )
        },
        win || {}
      )
    );
    /* Overlay event markers without re-clearing the canvas. */
    if (!evPts.length) {
      if ($("faultMeta")) {
        $("faultMeta").textContent =
          (base.length ? base.length + " xretry pts" : "no FW") +
          " · 0 events";
      }
      return;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.width / dpr;
    var H = canvas.height / dpr;
    var padL = 68;
    var padR = 18;
    var padT = 22;
    var padB = 36;
    var nowMs = Date.now();
    var winMs = ((win && win.windowMinutes) || state.minutes || 10) * 60 * 1000;
    var t1 = nowMs;
    var t0 = nowMs - winMs;
    var lastPush = Math.max(
      state.lastWifiFwMs || 0,
      state.lastWifiPushMs || 0
    );
    if (typeof LF !== "undefined" && LF.liveWindow) {
      var ext = dataTimeExtent(base);
      var lw = LF.liveWindow({
        nowMs: nowMs,
        durationMs: winMs,
        dataEndMs: ext ? ext.tmax : nowMs,
        lastPushMs: lastPush,
        leadMs: LIVE_LEAD_MS,
        staleMs: PUSH_STALE_MS
      });
      t0 = lw.t0;
      t1 = lw.t1;
    }
    function xAt(t) {
      if (isNaN(t) || t1 === t0) return padL;
      var x = padL + ((W - padL - padR) * (t - t0)) / (t1 - t0);
      if (x < padL) return padL;
      if (x > W - padR) return W - padR;
      return x;
    }
    var joins = 0,
      leaves = 0,
      errs = 0;
    for (i = 0; i < evPts.length; i++) {
      var t = parseTs(evPts[i].ts);
      if (isNaN(t) || t < t0 - 5000 || t > t1 + 5000) continue;
      var x = xAt(t);
      var kind2 = evPts[i]._ev;
      var col =
        kind2 === "join"
          ? "#5ad67d"
          : kind2 === "leave"
            ? "#f0a040"
            : kind2 === "error"
              ? "#e87a82"
              : "#8ec8ff";
      if (kind2 === "join") joins++;
      else if (kind2 === "leave") leaves++;
      else if (kind2 === "error") errs++;
      ctx.save();
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, padT + 4);
      ctx.lineTo(x, H - padB - 4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, padT + 10, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if ($("faultMeta")) {
      $("faultMeta").textContent =
        joins +
        " join · " +
        leaves +
        " leave · " +
        errs +
        " error · " +
        (base.length || 0) +
        " xretry pts";
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
      if (anyClientExpanded()) {
        scheduleCharts();
      }
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
      if (applyProcSnapshot(body.processes)) {
        renderProcs();
        status(
          "procs " +
            state.procs.length +
            " · host " +
            state.hostPts.length +
            " pts · " +
            state.wsStatus
        );
      }
    } else if (msg.op === "proc_series") {
      if (body.ok === false || !Array.isArray(body.points)) return;
      var pid = body.pid != null ? String(body.pid) : null;
      if (!pid) return;
      state.procSeries[pid] = { points: body.points };
      /* Patch the table row from the series tip so expanded rows stay live. */
      if (body.points.length && state.procs && state.procs.length) {
        var tip = body.points[body.points.length - 1];
        var patched = false;
        state.procs = state.procs.map(function (p) {
          if (String(p.pid) !== pid) return p;
          patched = true;
          return Object.assign({}, p, {
            cpu_pct:
              tip.cpu_pct != null ? tip.cpu_pct : p.cpu_pct,
            rss_kb: tip.rss_kb != null ? tip.rss_kb : p.rss_kb,
            vsize_kb: tip.vsize_kb != null ? tip.vsize_kb : p.vsize_kb,
            cpu_time_ms:
              tip.cpu_time_ms != null ? tip.cpu_time_ms : p.cpu_time_ms,
            threads: tip.threads != null ? tip.threads : p.threads
          });
        });
        if (patched) renderProcs();
      }
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
    /* CH history fill for open coverage charts (live tip comes from stations). */
    if (state.clientSeriesPollTimer) {
      clearInterval(state.clientSeriesPollTimer);
    }
    state.clientSeriesPollTimer = setInterval(pollExpandedClientSeries, 3000);
    /* QDF radio health (xretry) — independent of host WS frame budget. */
    if (state.wifiFwPollTimer) {
      clearInterval(state.wifiFwPollTimer);
    }
    restPollWifiFw();
    state.wifiFwPollTimer = setInterval(restPollWifiFw, 4000);
    /* Ensure anim loop is running so expanded coverage charts scroll. */
    scheduleCharts();
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
    var sl = $("openShellLink");
    if (sl) {
      sl.href =
        "/terminal/?router_id=" +
        encodeURIComponent(rid || "cpe-lab") +
        (rid ? "&auto=1" : "");
    }
  }

  /* ── USP config capture (TR-369 over edge-usp) ───────────── */
  var uspPollTimer = 0;
  var uspCaptureBusy = false;
  var uspLastModel = null;

  function routerId() {
    var el = $("filterRouter");
    return el && el.value ? String(el.value).trim() : "";
  }

  function uspProfile() {
    var el = $("uspCfgProfile");
    return el && el.value ? String(el.value) : "all";
  }

  function setUspStatus(st, detail) {
    var el = $("uspCfgStatus");
    var meta = $("uspCfgMeta");
    if (el) {
      el.textContent = st + (detail ? " · " + detail : "");
      el.setAttribute("data-st", st || "idle");
    }
    if (meta) {
      meta.textContent = st === "ok" ? "captured" : st || "—";
    }
  }

  function paramMap(params) {
    var m = {};
    var i;
    if (!params) return m;
    for (i = 0; i < params.length; i++) {
      if (params[i] && params[i].path) {
        m[params[i].path] = params[i];
      }
    }
    return m;
  }

  function pval(m, path) {
    var p = m[path];
    if (!p) return "—";
    if (p.err && p.err !== 0) return "—";
    return p.value != null && p.value !== "" ? String(p.value) : "—";
  }

  function modelVal(model, section, key) {
    if (!model || !model[section]) return null;
    var v = model[section][key];
    return v != null && v !== "" ? String(v) : null;
  }

  function renderUciPackages(model) {
    var wrap = $("uspUciPackages");
    var hint = $("uspUciHint");
    var pkgs = model && model.openwrt_uci && model.openwrt_uci.packages;
    var names = [];
    var html = "";
    var i;
    var name;
    var text;
    var n;
    if (!wrap) return;
    if (pkgs && typeof pkgs === "object") {
      for (name in pkgs) {
        if (Object.prototype.hasOwnProperty.call(pkgs, name)) {
          names.push(name);
        }
      }
      names.sort();
    }
    n = names.length;
    if (hint) {
      hint.textContent =
        n > 0
          ? n +
            " package" +
            (n === 1 ? "" : "s") +
            (model.openwrt_uci.package_count != null
              ? " · count " + model.openwrt_uci.package_count
              : "")
          : "No UCI packages in last capture (try profile All / OpenWrt UCI).";
    }
    for (i = 0; i < names.length; i++) {
      name = names[i];
      text = pkgs[name] != null ? String(pkgs[name]) : "";
      html +=
        '<details class="host-uci-pkg">' +
        "<summary><code>" +
        esc(name) +
        "</code> <span class=\"hint\">" +
        text.length +
        " B</span></summary>" +
        '<pre class="host-pre host-uci-pre">' +
        esc(text) +
        "</pre></details>";
    }
    wrap.innerHTML = html;
  }

  function renderUspConfig(j) {
    var m = paramMap(j && j.params);
    var model = (j && j.model) || {};
    var di = model.device_info || {};
    var wifi = model.wifi || {};
    var dl = $("uspDeviceInfo");
    var keys = [
      ["Serial", "SerialNumber", "Device.DeviceInfo.SerialNumber"],
      ["Manufacturer", "Manufacturer", "Device.DeviceInfo.Manufacturer"],
      ["Model", "ModelName", "Device.DeviceInfo.ModelName"],
      ["Class", "ProductClass", "Device.DeviceInfo.ProductClass"],
      ["Software", "SoftwareVersion", "Device.DeviceInfo.SoftwareVersion"],
      ["Hostname", "X_ECOEC_Hostname", "Device.DeviceInfo.X_ECOEC_Hostname"],
      ["Kernel", "X_ECOEC_Kernel", "Device.DeviceInfo.X_ECOEC_Kernel"],
      ["UpTime (s)", "UpTime", "Device.DeviceInfo.UpTime"]
    ];
    var html = "";
    var i;
    var rb;
    var sb;
    var rows;
    var radios;
    var ssids;
    var v;

    uspLastModel = model;

    if (dl) {
      for (i = 0; i < keys.length; i++) {
        v = di[keys[i][1]];
        if (v == null || v === "") v = pval(m, keys[i][2]);
        else v = String(v);
        if (v === "") v = "—";
        html +=
          "<dt>" +
          esc(keys[i][0]) +
          "</dt><dd>" +
          esc(v) +
          "</dd>";
      }
      dl.innerHTML = html || '<dt class="hint">empty</dt>';
    }

    radios = wifi.radios || [];
    rb = $("uspRadioBody");
    if (rb) {
      rows = "";
      if (radios.length) {
        for (i = 0; i < radios.length; i++) {
          var r = radios[i] || {};
          rows +=
            "<tr><td>" +
            esc(String(r.i != null ? r.i : i + 1)) +
            "</td><td>" +
            esc(r.Name || "—") +
            "</td><td>" +
            esc(r.Enable != null ? String(r.Enable) : "—") +
            "</td><td>" +
            esc(r.Band || "—") +
            "</td><td>" +
            esc(r.Channel != null ? String(r.Channel) : "—") +
            "</td></tr>";
        }
      } else {
        /* Fallback: flat params */
        for (i = 1; i <= 4; i++) {
          var pref = "Device.WiFi.Radio." + i + ".";
          var name = pval(m, pref + "Name");
          if (name === "—") continue;
          rows +=
            "<tr><td>" +
            i +
            "</td><td>" +
            esc(name) +
            "</td><td>" +
            esc(pval(m, pref + "Enable")) +
            "</td><td>" +
            esc(pval(m, pref + "OperatingFrequencyBand")) +
            "</td><td>" +
            esc(pval(m, pref + "Channel")) +
            "</td></tr>";
        }
      }
      rb.innerHTML = rows || '<tr><td colspan="5" class="hint">—</td></tr>';
    }

    ssids = wifi.ssids || [];
    sb = $("uspSsidBody");
    if (sb) {
      rows = "";
      if (ssids.length) {
        for (i = 0; i < ssids.length; i++) {
          var s = ssids[i] || {};
          rows +=
            "<tr><td>" +
            esc(String(s.i != null ? s.i : i + 1)) +
            "</td><td>" +
            esc(s.SSID || "—") +
            "</td><td>" +
            esc(s.BSSID || "—") +
            "</td><td>" +
            esc(s.Enable != null ? String(s.Enable) : "—") +
            "</td><td>" +
            esc(s.LowerLayers || "—") +
            "</td></tr>";
        }
      } else {
        for (i = 1; i <= 8; i++) {
          var sp = "Device.WiFi.SSID." + i + ".";
          var ssid = pval(m, sp + "SSID");
          var bssid = pval(m, sp + "BSSID");
          if (ssid === "—" && bssid === "—") continue;
          rows +=
            "<tr><td>" +
            i +
            "</td><td>" +
            esc(ssid) +
            "</td><td>" +
            esc(bssid) +
            "</td><td>" +
            esc(pval(m, sp + "Enable")) +
            "</td><td>" +
            esc(pval(m, sp + "LowerLayers")) +
            "</td></tr>";
        }
      }
      sb.innerHTML = rows || '<tr><td colspan="5" class="hint">no SSIDs</td></tr>';
    }

    renderUciPackages(model);

    if ($("uspCfgMeta") && j) {
      var bits = [];
      if (j.profile) bits.push(j.profile);
      if (j.status === "ok") bits.push("ok");
      if (model.openwrt_uci && model.openwrt_uci.package_count != null) {
        bits.push(model.openwrt_uci.package_count + " UCI pkgs");
      }
      $("uspCfgMeta").textContent = bits.length ? bits.join(" · ") : "captured";
    }

    if ($("uspCfgRaw")) {
      try {
        $("uspCfgRaw").textContent = JSON.stringify(
          {
            profile: j && j.profile,
            model: model,
            params: (j && j.params) || []
          },
          null,
          2
        );
      } catch (e) {
        $("uspCfgRaw").textContent = "[]";
      }
    }
  }

  /**
   * SPA fetch helper — matches app.js edgehostFetch shape
   * { status, body, ok, headers }, not a raw Response.
   */
  function uspHttp(url, opts) {
    if (typeof window.edgehostFetch === "function") {
      return window.edgehostFetch(url, opts);
    }
    return fetch(url, Object.assign({ credentials: "same-origin" }, opts || {}))
      .then(function (r) {
        return r.text().then(function (body) {
          return {
            status: r.status,
            body: body,
            headers: r.headers,
            ok: r.ok
          };
        });
      });
  }

  function parseUspJson(r) {
    var j = null;
    try {
      j = JSON.parse(r && r.body != null ? r.body : "");
    } catch (e) {
      j = { ok: false, status: "error", err: "bad json" };
    }
    if (!j || typeof j !== "object") {
      j = { ok: false, status: "error", err: "bad json" };
    }
    j._http = r ? r.status : 0;
    return j;
  }

  function fetchUspConfig() {
    var rid = routerId();
    if (!rid) {
      setUspStatus("error", "set router_id");
      return Promise.resolve(null);
    }
    var url =
      "/api/v1/cpe/usp/config?router_id=" + encodeURIComponent(rid);
    return uspHttp(url, { credentials: "same-origin" })
      .then(function (r) {
        return parseUspJson(r);
      })
      .then(function (j) {
        if (!j) return null;
        setUspStatus(j.status || "idle", j.err || j.error || "");
        if (j.status === "ok" || (j.params && j.params.length)) {
          renderUspConfig(j);
        }
        return j;
      })
      .catch(function (err) {
        setUspStatus("error", String(err && err.message ? err.message : err));
        return null;
      });
  }

  function pollUspUntilDone(tries) {
    /* Full UCI dump is multi-round; allow ~45s. */
    tries = tries == null ? 180 : tries;
    if (uspPollTimer) {
      clearTimeout(uspPollTimer);
      uspPollTimer = 0;
    }
    return fetchUspConfig().then(function (j) {
      if (!j) {
        uspCaptureBusy = false;
        return;
      }
      if (j.status === "pending" && tries > 0) {
        var ph = j.phase != null ? " phase " + j.phase : "";
        setUspStatus("pending", "waiting USP…" + ph);
        uspPollTimer = setTimeout(function () {
          pollUspUntilDone(tries - 1);
        }, 250);
        return;
      }
      uspCaptureBusy = false;
      if (j.status === "pending") {
        setUspStatus("error", "timeout waiting GetResp");
      }
    });
  }

  function captureUspConfig() {
    var rid = routerId();
    var prof = uspProfile();
    if (!rid) {
      setUspStatus("error", "set router_id");
      return;
    }
    if (uspCaptureBusy) return;
    uspCaptureBusy = true;
    setUspStatus("pending", "sending Get (" + prof + ")…");
    var url =
      "/api/v1/cpe/usp/config/capture?router_id=" +
      encodeURIComponent(rid) +
      "&profile=" +
      encodeURIComponent(prof);
    uspHttp(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: prof })
    })
      .then(function (r) {
        var j = parseUspJson(r);
        if (r.status === 202 || (j && j.status === "pending")) {
          setUspStatus("pending", "waiting USP (" + prof + ")…");
          return pollUspUntilDone(180);
        }
        uspCaptureBusy = false;
        setUspStatus(
          "error",
          (j && (j.error || j.err || j.hint)) || "HTTP " + r.status
        );
      })
      .catch(function (err) {
        uspCaptureBusy = false;
        setUspStatus("error", String(err && err.message ? err.message : err));
      });
  }

  function setApplyStatus(msg) {
    var el = $("uspApplyStatus");
    if (el) el.textContent = msg || "";
  }

  function uspSetParams(params) {
    var rid = routerId();
    if (!rid) {
      setApplyStatus("set router_id");
      return Promise.resolve(null);
    }
    if (uspCaptureBusy) {
      setApplyStatus("busy");
      return Promise.resolve(null);
    }
    uspCaptureBusy = true;
    setApplyStatus("sending Set…");
    var url =
      "/api/v1/cpe/usp/config/set?router_id=" + encodeURIComponent(rid);
    return uspHttp(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: params })
    })
      .then(function (r) {
        var j = parseUspJson(r);
        if (r.status === 202 || (j && j.status === "pending")) {
          setApplyStatus("waiting SetResp…");
          return pollUspUntilDone(40).then(function () {
            setApplyStatus("done");
            return j;
          });
        }
        uspCaptureBusy = false;
        setApplyStatus(
          (j && (j.error || j.err || j.hint)) || "HTTP " + r.status
        );
        return null;
      })
      .catch(function (err) {
        uspCaptureBusy = false;
        setApplyStatus(String(err && err.message ? err.message : err));
        return null;
      });
  }

  function applyUciSet() {
    var inp = $("uspApplyValue");
    var val = inp && inp.value ? String(inp.value).trim() : "";
    if (!val || val.indexOf("=") < 0) {
      setApplyStatus("need pkg.sec.opt=val");
      return;
    }
    uspSetParams([
      { path: "Device.X_ECOEC_OpenWrt.UCI.Apply", value: val }
    ]);
  }

  function commitUci() {
    var inp = $("uspApplyValue");
    var val = inp && inp.value ? String(inp.value).trim() : "";
    var pkg = "";
    /* If value looks like pkg.sec.opt=val, commit just that package. */
    if (val && val.indexOf(".") > 0) {
      pkg = val.split(".")[0];
    }
    uspSetParams([
      { path: "Device.X_ECOEC_OpenWrt.UCI.Commit", value: pkg }
    ]);
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
    /* USP config UI moved to /cpe-config/ */
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
