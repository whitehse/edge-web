/**
 * Series adapters: existing host/wifi/flow APIs → normalized chart bundles.
 */
import {
  parseTs,
  dataTimeExtent,
  CORE_COLORS,
  OVERLAY_COLORS,
  fmtPct,
  fmtRate,
  fmtNum,
  robustMax
} from "/charts/ts_util.js";

function emptyBundle(title, msg) {
  return {
    points: [],
    series: [],
    markers: [],
    refLines: [],
    meta: { title: title, subtitle: msg || "", lastPushMs: 0, stale: false },
    yHints: { mode: "auto", includeZero: true }
  };
}

function bandFromFreq(mhz) {
  mhz = Number(mhz) || 0;
  if (mhz >= 5925) return "6";
  if (mhz >= 4900) return "5";
  if (mhz >= 2400 && mhz < 2500) return "2.4";
  return "";
}

function hostPointsToSeries(typeId, points) {
  const pts = points || [];
  let series = [];
  let yHints = { mode: "auto", includeZero: true };
  let refLines = [];

  if (typeId === "host.cpu") {
    let nCpus = 0;
    let i;
    for (i = 0; i < 8; i++) {
      const key = "cpu" + i + "_pct";
      let any = false;
      for (let j = 0; j < pts.length; j++) {
        if (pts[j][key] != null && isFinite(Number(pts[j][key]))) {
          any = true;
          break;
        }
      }
      if (any) {
        series.push({
          key: key,
          label: "core " + i,
          color: CORE_COLORS[i % CORE_COLORS.length],
          width: 1.2,
          fillAlpha: 0.04
        });
        nCpus++;
      }
    }
    series.push({
      key: "cpu_pct",
      label: "total",
      color: "#e8e2d8",
      width: 1.6,
      fillAlpha: 0.06
    });
    series.push({
      key: "cpu_iowait_pct",
      label: "iowait",
      color: "#e6b84d",
      width: 1.1,
      fillAlpha: 0
    });
    yHints = {
      mode: "fixed",
      yMin: 0,
      yMax: 100,
      fmtY: fmtPct,
      includeZero: true
    };
  } else if (typeId === "host.mem") {
    series = [
      {
        key: "mem_used_pct",
        label: "used %",
        color: "#6b8cff",
        width: 1.5,
        fillAlpha: 0.08
      }
    ];
    yHints = { mode: "fixed", yMin: 0, yMax: 100, fmtY: fmtPct };
    refLines = [
      { value: 90, color: "#e6b84d" },
      { value: 100, color: "#e87a82" }
    ];
  } else if (typeId === "host.net") {
    series = [
      {
        key: "net_rx_bps",
        label: "↓ rx",
        color: "#5aa8ff",
        width: 2.4,
        fillAlpha: 0.1
      },
      {
        key: "net_tx_bps",
        label: "↑ tx",
        color: "#f0a040",
        width: 2.2,
        fillAlpha: 0.06
      }
    ];
    const vals = [];
    pts.forEach(function (p) {
      vals.push(p.net_rx_bps, p.net_tx_bps);
    });
    /* Auto-scale in chart view from sample bps; unit tags the axis formatter. */
    yHints = {
      mode: "auto",
      yMin: 0,
      fmtY: fmtRate,
      includeZero: true,
      unit: "bps"
    };
    refLines = [];
  } else if (typeId === "host.load") {
    series = [
      { key: "load1", label: "1m", color: "#6b8cff", width: 1.4, fillAlpha: 0.06 },
      { key: "load5", label: "5m", color: "#5ad67d", width: 1.2, fillAlpha: 0 },
      { key: "load15", label: "15m", color: "#e6b84d", width: 1.1, fillAlpha: 0 }
    ];
    let n = 1;
    for (let j = 0; j < pts.length; j++) {
      if (pts[j].n_cpus) n = Math.max(n, Number(pts[j].n_cpus) || 1);
    }
    yHints = { mode: "auto", yMin: 0, fmtY: function (v) { return fmtNum(v, 2); }, includeZero: true };
    refLines = [{ value: n, color: "#e87a82" }];
  }

  return mapKeyedSeries(pts, series, yHints, refLines);
}

function mapKeyedSeries(pts, seriesDefs, yHints, refLines) {
  const outSeries = seriesDefs.map(function (def) {
    const points = [];
    for (let i = 0; i < pts.length; i++) {
      const t = parseTs(pts[i].ts);
      const raw = pts[i][def.key];
      /* null must not become 0 via Number(null) — that collapsed the Y scale */
      if (raw == null || raw === "") continue;
      const y = typeof raw === "number" ? raw : Number(raw);
      if (!isFinite(t) || !isFinite(y)) continue;
      points.push({ t: t, y: y, ts: pts[i].ts });
    }
    return {
      id: def.key,
      label: def.label,
      color: def.color,
      width: def.width,
      fillAlpha: def.fillAlpha,
      showTip: true,
      points: points
    };
  });
  return {
    series: outSeries,
    markers: [],
    refLines: refLines || [],
    yHints: yHints || { mode: "auto" },
    meta: {}
  };
}

function wifiRadioBundle(pts, source) {
  let filtered = pts || [];
  if (source.ifname) {
    filtered = filtered.filter(function (p) {
      return !p.ifname || p.ifname === source.ifname;
    });
  }
  if (source.band) {
    filtered = filtered.filter(function (p) {
      const b = bandFromFreq(p.freq_mhz);
      return !b || b === String(source.band);
    });
  }
  const seriesDefs = [
    {
      key: "stations",
      label: "stations",
      color: "#6b8cff",
      width: 1.4,
      fillAlpha: 0.06
    },
    {
      key: "chan_util_pct",
      label: "chan util %",
      color: "#e6b84d",
      width: 1.3,
      fillAlpha: 0.05
    }
  ];
  const packed = mapKeyedSeries(filtered, seriesDefs, {
    mode: "auto",
    yMin: 0,
    fmtY: fmtNum,
    includeZero: true
  }, []);
  /* noise as optional third if present */
  const noisePts = [];
  for (let i = 0; i < filtered.length; i++) {
    const t = parseTs(filtered[i].ts);
    const y = Number(filtered[i].noise_dbm);
    if (isFinite(t) && isFinite(y) && y !== 0) noisePts.push({ t: t, y: y });
  }
  if (noisePts.length) {
    packed.series.push({
      id: "noise_dbm",
      label: "noise dBm",
      color: "#c4788a",
      width: 1.1,
      fillAlpha: 0,
      points: noisePts
    });
  }
  return packed;
}

function clientSeriesBundle(pts) {
  const seriesDefs = [
    { key: "rssi_dbm", label: "RSSI", color: "#6b8cff", width: 1.4, fillAlpha: 0.06 },
    { key: "tx_rate_mbps", label: "TX Mbps", color: "#5ad67d", width: 1.2, fillAlpha: 0 },
    { key: "rx_rate_mbps", label: "RX Mbps", color: "#e6b84d", width: 1.2, fillAlpha: 0 },
    {
      key: "tx_bitrate_mbps",
      label: "thr TX",
      color: "#9b7bff",
      width: 1.1,
      fillAlpha: 0
    }
  ];
  /* prefer throughput fields when present */
  const packed = mapKeyedSeries(pts || [], seriesDefs, {
    mode: "auto",
    fmtY: fmtNum,
    includeZero: false
  }, []);
  packed.series = packed.series.filter(function (s) {
    return s.points && s.points.length;
  });
  return packed;
}

function flowOverlayBundle(flowsSeries) {
  /* flowsSeries: [{ flow, points, color }] */
  const series = [];
  const markers = [];
  let i;
  for (i = 0; i < (flowsSeries || []).length; i++) {
    const entry = flowsSeries[i];
    const color = entry.color || OVERLAY_COLORS[i % OVERLAY_COLORS.length];
    const points = [];
    const pts = entry.points || [];
    for (let j = 0; j < pts.length; j++) {
      const t = parseTs(pts[j].ts);
      const up = Number(pts[j].rate_up_bps) || 0;
      const down = Number(pts[j].rate_down_bps) || 0;
      if (!isFinite(t)) continue;
      points.push({ t: t, y: up + down });
      if (
        pts[j].event === "destroy" ||
        pts[j].syn_retrans ||
        pts[j].loss_hint ||
        (pts[j].win_down != null && Number(pts[j].win_down) > 0 && Number(pts[j].win_down) < 4096)
      ) {
        markers.push({
          t: t,
          kind: pts[j].event === "destroy" ? "destroy" : "defect",
          color: "#e87a82"
        });
      }
    }
    const label =
      (entry.flow && (entry.flow.remote_label || entry.flow.remote_ip)) ||
      (entry.flow && entry.flow.flow_id) ||
      "flow " + i;
    series.push({
      id: "f" + i,
      label: String(label).slice(0, 24),
      color: color,
      width: 1.15,
      fillAlpha: 0.03,
      points: points
    });
  }
  const vals = [];
  series.forEach(function (s) {
    s.points.forEach(function (p) {
      vals.push(p.y);
    });
  });
  const peak = robustMax(vals, 1000);
  return {
    series: series,
    markers: markers,
    refLines: [],
    yHints: { mode: "auto", yMin: 0, yMax: peak * 1.2, fmtY: fmtRate, includeZero: true },
    meta: {}
  };
}

function flowStreamBundle(body) {
  const pts = (body && body.points) || [];
  const seriesDefs = [
    {
      key: "rate_down_bps",
      label: "↓ down",
      color: "#6b8cff",
      width: 1.5,
      fillAlpha: 0.08
    },
    {
      key: "rate_up_bps",
      label: "↑ up",
      color: "#c4788a",
      width: 1.3,
      fillAlpha: 0.04
    }
  ];
  const packed = mapKeyedSeries(pts, seriesDefs, {
    mode: "auto",
    yMin: 0,
    fmtY: fmtRate,
    includeZero: true
  }, []);
  const markers = [];
  for (let i = 0; i < pts.length; i++) {
    const t = parseTs(pts[i].ts);
    if (!isFinite(t)) continue;
    if (pts[i].event === "destroy") {
      markers.push({ t: t, kind: "destroy", color: "#e87a82" });
    }
  }
  packed.markers = markers;
  return packed;
}

/**
 * Create adapter manager bound to EdgeMux + fetch.
 *
 * Host/wifi history reliability (mirrors /host/):
 *  - Server host series cap is 120 pts (WS frame size). Use limit 120.
 *  - Re-watch + REST on every WS open (server drops watches on reconnect).
 *  - Never replace a dense series with a sparse push.
 *  - REST bootstrap always on panel refresh; periodic REST safety net.
 */
export function createAdapterHub(opts) {
  opts = opts || {};
  const mux = opts.mux || (typeof window !== "undefined" ? window.EdgeMux : null);
  const fetchFn =
    opts.fetch ||
    function (url, init) {
      if (typeof window.edgehostFetch === "function") {
        return window.edgehostFetch(url, init);
      }
      return fetch(url, init);
    };

  /**
   * Normalize fetch / edgehostFetch into { ok, status, json }.
   * app.js edgehostFetch returns { status, body, ok } (text body) — NOT a
   * Response. Calling .json() on it threw and every REST bootstrap failed
   * silently → "Waiting for samples" forever when WS alone was thin.
   */
  async function fetchJson(url, init) {
    const r = await fetchFn(url, init);
    if (!r) return { ok: false, status: 0, json: null, error: "no response" };
    let status = r.status != null ? r.status : 0;
    let ok = !!r.ok;
    let json = null;
    let error = "";
    try {
      if (typeof r.json === "function") {
        json = await r.json();
      } else if (typeof r.body === "string") {
        json = r.body ? JSON.parse(r.body) : null;
      } else if (r.body && typeof r.body === "object") {
        json = r.body;
      }
    } catch (e) {
      error = (e && e.message) || "json parse failed";
      return { ok: false, status: status, json: null, error: error };
    }
    if (json && json.ok === false) {
      ok = false;
      error = json.error || "ok:false";
    }
    return { ok: ok, status: status, json: json, error: error };
  }

  /* Match server MUX_HOST_LIMIT_MAX + /host/ seriesOpts.limit (LiveFeed) */
  const LF =
    typeof window !== "undefined" && window.LiveFeed ? window.LiveFeed : null;
  const HOST_LIMIT_BASE =
    (LF && LF.HOST_SERIES_LIMIT) || 120;
  const FEED_STALE_MS = (LF && LF.FEED_STALE_MS) || 15000;

  /**
   * Point budget for REST: short windows use dense 1 Hz (capped ~1200 for
   * 10–15 min). Longer windows stay within server caps but request more than
   * the old fixed 120 so 24h live is not a handful of dots.
   */
  function hostLimitForMinutes(mins) {
    mins = mins > 0 ? mins : currentMinutes || 10;
    if (mins <= 15) {
      return Math.min(1200, Math.max(HOST_LIMIT_BASE, mins * 60 + 30));
    }
    if (mins <= 120) return 600;
    if (mins <= 24 * 60) return 800;
    return 1000;
  }

  let lastRestError = "";

  /* cache by panel id */
  const cache = {}; /* id -> { bundle, raw, lastPushMs } */
  const listeners = {}; /* id -> fn */
  let hostPts = [];
  let wifiPts = [];
  let lastHostPush = 0;
  let lastWifiPush = 0;
  let lastHostSource = "";
  let lastWifiSource = "";
  let currentRouter = "";
  let currentMinutes = 10;
  let pollTimer = 0;
  let watching = false;

  function clearSeriesBuffers() {
    hostPts = [];
    wifiPts = [];
    lastHostPush = 0;
    lastWifiPush = 0;
    lastHostSource = "";
    lastWifiSource = "";
  }

  /**
   * Set CPE filter. Non-empty updates currentRouter; empty only when clear=true
   * (Apply CPE with blank field). Changing CPE drops merge buffers so we never
   * mix two routers' samples.
   */
  function setRouter(routerId, opts) {
    opts = opts || {};
    const next =
      routerId != null && String(routerId).trim()
        ? String(routerId).trim()
        : "";
    if (!next && !opts.clear) {
      return currentRouter;
    }
    if (next === currentRouter) return currentRouter;
    currentRouter = next;
    clearSeriesBuffers();
    return currentRouter;
  }

  function resolveRouter(preferred) {
    const p =
      preferred != null && String(preferred).trim()
        ? String(preferred).trim()
        : "";
    if (p) {
      setRouter(p);
      return p;
    }
    return currentRouter || "";
  }

  function notifyPanel(id) {
    const fn = listeners[id];
    if (fn && cache[id]) {
      try {
        fn(cache[id].bundle);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function ptsExtent(pts) {
    return dataTimeExtent(pts);
  }

  function pointTime(p) {
    if (!p) return NaN;
    if (p.t != null && isFinite(Number(p.t))) return Number(p.t);
    return parseTs(p.ts);
  }

  /**
   * Merge series by timestamp (shared LiveFeed.mergeByTimestamp when loaded).
   * ALWAYS accumulate — never replace a buffer with a short WS tip.
   */
  function mergeByTimestamp(prev, next, lookbackMs) {
    if (LF && typeof LF.mergeByTimestamp === "function") {
      return LF.mergeByTimestamp(prev, next, lookbackMs, {
        parseTs: parseTs,
        limit: hostLimitForMinutes(currentMinutes) * 3
      });
    }
    /* Inline fallback if live_feed.js not on the page */
    const byT = Object.create(null);
    function ingest(list) {
      if (!list) return;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const t = pointTime(p);
        if (!isFinite(t)) continue;
        byT[String(Math.round(t))] = p;
      }
    }
    ingest(prev);
    ingest(next);
    const keys = Object.keys(byT);
    if (!keys.length) return [];
    keys.sort(function (a, b) {
      return Number(a) - Number(b);
    });
    const latest = Number(keys[keys.length - 1]);
    const cutoff = Math.max(
      0,
      latest - (lookbackMs > 0 ? lookbackMs : 10 * 60 * 1000)
    );
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const t = Number(keys[i]);
      if (t < cutoff) continue;
      out.push(byT[keys[i]]);
    }
    const cap = hostLimitForMinutes(currentMinutes) * 3;
    if (out.length > cap) return out.slice(out.length - cap);
    return out;
  }

  function lookbackMs() {
    if (LF && typeof LF.lookbackFromMinutes === "function") {
      return LF.lookbackFromMinutes(currentMinutes || 10);
    }
    return Math.max(60_000, (currentMinutes || 10) * 60_000);
  }

  function applyHostPoints(pts, source) {
    if (!Array.isArray(pts) || !pts.length) return false;
    const before = hostPts.length;
    hostPts = mergeByTimestamp(hostPts, pts, lookbackMs());
    if (!hostPts.length) return false;
    lastHostPush = Date.now();
    lastHostSource =
      (source || "ws") +
      (hostPts.length > before
        ? " · +" + (hostPts.length - before)
        : hostPts.length < before
          ? ""
          : "");
    /* Prefer showing ws/rest without the +N noise in steady state */
    lastHostSource = source || "ws";
    rebuildHostPanels();
    return true;
  }

  function applyWifiPoints(pts, source) {
    if (!Array.isArray(pts) || !pts.length) return false;
    wifiPts = mergeByTimestamp(wifiPts, pts, lookbackMs());
    if (!wifiPts.length) return false;
    lastWifiPush = Date.now();
    lastWifiSource = source || "ws";
    rebuildWifiPanels();
    return true;
  }

  function rebuildHostPanels() {
    Object.keys(cache).forEach(function (id) {
      const c = cache[id];
      if (!c || !c.panel) return;
      const tid = c.panel.typeId;
      if (tid.indexOf("host.") !== 0) return;
      const packed = hostPointsToSeries(tid, hostPts);
      const n = hostPts.length;
      const ext = ptsExtent(hostPts);
      let spanTxt = "";
      if (ext && ext.tmax > ext.tmin) {
        const spanMin = Math.round((ext.tmax - ext.tmin) / 60000);
        spanTxt = spanMin >= 1 ? " · " + spanMin + "m" : " · <1m";
      }
      c.bundle = {
        series: packed.series,
        markers: packed.markers,
        refLines: packed.refLines,
        yHints: packed.yHints,
        meta: {
          title: tid,
          lastPushMs: lastHostPush,
          stale: lastHostPush > 0 && Date.now() - lastHostPush > 15000,
          subtitle:
            n +
            " samples" +
            (lastHostSource ? " · " + lastHostSource : "") +
            (currentRouter
              ? " · " + currentRouter
              : " · set CPE in toolbar") +
            spanTxt +
            (n < 12 ? " · accumulating…" : "")
        }
      };
      notifyPanel(id);
    });
  }

  function rebuildWifiPanels() {
    Object.keys(cache).forEach(function (id) {
      const c = cache[id];
      if (!c || !c.panel) return;
      const tid = c.panel.typeId;
      if (tid !== "wifi.radio" && tid !== "wifi.band") return;
      const packed = wifiRadioBundle(wifiPts, c.panel.source || {});
      c.bundle = {
        series: packed.series,
        markers: [],
        refLines: [],
        yHints: packed.yHints,
        meta: {
          title: tid,
          lastPushMs: lastWifiPush,
          stale: lastWifiPush > 0 && Date.now() - lastWifiPush > 15000,
          subtitle:
            wifiPts.length +
            " samples" +
            (lastWifiSource ? " · " + lastWifiSource : "")
        }
      };
      notifyPanel(id);
    });
  }

  function coercePoints(body) {
    if (!body) return null;
    let b = body;
    if (typeof b === "string") {
      try {
        b = JSON.parse(b);
      } catch (e) {
        return null;
      }
    }
    if (b.ok === false) return null;
    let pts = b.points;
    if (typeof pts === "string") {
      try {
        pts = JSON.parse(pts);
      } catch (e) {
        return null;
      }
    }
    if (!Array.isArray(pts)) return null;
    return pts;
  }

  function onHostMsg(msg) {
    if (!msg) return;
    if (msg.op === "error") {
      /* Series too large / CH blip — pull REST history immediately */
      ensureFeed(true);
      return;
    }
    if (!msg.body) return;
    if (msg.op === "host" || msg.op === "series") {
      const pts = coercePoints(msg.body);
      if (!pts) {
        if (msg.body && msg.body.ok === false) ensureFeed(true);
        return;
      }
      if (!pts.length) return;
      applyHostPoints(pts, "ws");
      /* Still thin after WS? Keep REST pumping to seed the merge buffer. */
      if (hostPts.length < 24) ensureFeed(false);
    }
    if (msg.op === "wifi") {
      const pts = coercePoints(msg.body);
      if (!pts || !pts.length) {
        if (msg.body && msg.body.ok === false) ensureFeed(true);
        return;
      }
      applyWifiPoints(pts, "ws");
    }
  }

  function watchBody() {
    const body = {
      minutes: currentMinutes,
      hours: Math.max(1, Math.ceil(currentMinutes / 60)),
      /* WS frame budget is smaller; dense history comes from REST merge. */
      limit: Math.min(120, hostLimitForMinutes(currentMinutes))
    };
    if (currentRouter) body.router_id = currentRouter;
    return body;
  }

  /**
   * Arm host/wifi WS watch. routerId updates the CPE only when non-empty —
   * never wipe a good currentRouter with "" from a panel that lacks source.
   * Pass { clear: true } to intentionally clear (empty Apply CPE).
   * Without a CPE we do not watch (mixed multi-router series looks broken).
   */
  function ensureHostWifiWatch(routerId, minutes, opts) {
    opts = opts || {};
    if (minutes != null) currentMinutes = minutes || 10;
    if (opts.clear) {
      setRouter("", { clear: true });
    } else if (routerId != null && String(routerId).trim()) {
      setRouter(routerId);
    }
    if (!mux) return;
    if (!currentRouter) {
      watching = false;
      return;
    }
    mux.watch("host", "all", watchBody());
    watching = true;
  }

  /**
   * Re-arm watch + force REST. Call on every WS open (host.js does this).
   */
  function resubscribe() {
    if (!mux) return;
    if (!currentRouter) {
      watching = false;
      return;
    }
    ensureHostWifiWatch(null, currentMinutes);
    ensureFeed(true);
  }

  if (mux) {
    mux.on("host", onHostMsg);
    if (typeof mux.onStatus === "function") {
      mux.onStatus(function (st) {
        if (st === "open") {
          /* Server cleared watches on disconnect — re-subscribe. */
          resubscribe();
        }
      });
    }
  }

  async function restHost(routerId, minutes) {
    const rid = routerId != null ? routerId : currentRouter;
    const mins = minutes || currentMinutes;
    const lim = hostLimitForMinutes(mins);
    const q =
      "/api/v1/cpe/host?minutes=" +
      encodeURIComponent(mins) +
      "&limit=" +
      encodeURIComponent(lim) +
      (rid ? "&router_id=" + encodeURIComponent(rid) : "");
    const r = await fetchJson(q, { credentials: "same-origin" });
    if (!r.ok) {
      lastRestError =
        "host HTTP " +
        r.status +
        (r.error ? ": " + String(r.error).slice(0, 120) : "");
      return false;
    }
    const j = r.json;
    if (j && Array.isArray(j.points) && j.points.length) {
      lastRestError = "";
      return applyHostPoints(j.points, "rest");
    }
    lastRestError = rid
      ? "host: 0 points for " + rid
      : "host: 0 points";
    return false;
  }

  async function restWifi(routerId, minutes) {
    const rid = routerId != null ? routerId : currentRouter;
    const mins = minutes || currentMinutes;
    const lim = hostLimitForMinutes(mins);
    const q =
      "/api/v1/cpe/wifi?minutes=" +
      encodeURIComponent(mins) +
      "&limit=" +
      encodeURIComponent(lim) +
      (rid ? "&router_id=" + encodeURIComponent(rid) : "");
    const r = await fetchJson(q, { credentials: "same-origin" });
    if (!r.ok) {
      if (!lastRestError) {
        lastRestError =
          "wifi HTTP " +
          r.status +
          (r.error ? ": " + String(r.error).slice(0, 80) : "");
      }
      return false;
    }
    const j = r.json;
    if (j && Array.isArray(j.points) && j.points.length) {
      return applyWifiPoints(j.points, "rest");
    }
    return false;
  }

  let lastRestPollMs = 0;
  let restInFlight = false;
  /**
   * REST safety net. force=true bypasses freshness throttle (reconnect / error).
   * While history is still thin, poll REST often so we seed the merge buffer.
   */
  function ensureFeed(force) {
    if (!currentRouter) return;
    const now = Date.now();
    if (restInFlight) return;
    const push = Math.max(lastHostPush, lastWifiPush);
    const sparse = hostPts.length < 24;
    const stale = push === 0 || now - push > 6000;
    if (!force) {
      /* Sparse: poll every 3s; healthy: only when WS goes quiet */
      if (sparse && now - lastRestPollMs < 3000) return;
      if (!sparse && now - lastRestPollMs < 8000) return;
      if (!stale && !sparse) return;
    } else if (now - lastRestPollMs < 500) {
      return;
    }
    lastRestPollMs = now;
    restInFlight = true;
    Promise.all([
      restHost(currentRouter, currentMinutes).catch(function () {
        return false;
      }),
      restWifi(currentRouter, currentMinutes).catch(function () {
        return false;
      })
    ]).then(function () {
      restInFlight = false;
    });
  }

  async function fetchClientSeries(panel) {
    const s = panel.source || {};
    const minutes = currentMinutes;
    const q =
      "/api/v1/cpe/wifi/stations/series?client_mac=" +
      encodeURIComponent(s.client_mac || "") +
      "&minutes=" +
      encodeURIComponent(minutes) +
      "&limit=400" +
      (s.router_id ? "&router_id=" + encodeURIComponent(s.router_id) : "");
    const r = await fetchJson(q);
    const j = (r && r.json) || {};
    const packed = clientSeriesBundle(j.points || []);
    return {
      series: packed.series,
      markers: [],
      refLines: [],
      yHints: packed.yHints,
      meta: { title: "client", lastPushMs: Date.now() }
    };
  }

  async function fetchFlowOverlay(panel) {
    const s = panel.source || {};
    const hours = Math.max(1, Math.ceil(currentMinutes / 60));
    const listQ =
      "/api/v1/flows?hours=" +
      encodeURIComponent(hours) +
      "&limit=12" +
      (s.router_id ? "&router_id=" + encodeURIComponent(s.router_id) : "");
    const lr = await fetchJson(listQ);
    const lj = (lr && lr.json) || {};
    const flows = (lj && lj.flows) || [];
    const top = flows.slice(0, 8);
    const entries = [];
    await Promise.all(
      top.map(async function (f, idx) {
        if (!f.flow_id || !f.router_id) return;
        const sq =
          "/api/v1/flows/series?router_id=" +
          encodeURIComponent(f.router_id) +
          "&flow_id=" +
          encodeURIComponent(f.flow_id) +
          "&hours=" +
          encodeURIComponent(hours) +
          "&limit=200";
        try {
          const sr = await fetchJson(sq);
          const sj = (sr && sr.json) || {};
          entries.push({
            flow: f,
            points: (sj && sj.points) || [],
            color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length]
          });
        } catch (e) {
          /* skip */
        }
      })
    );
    const packed = flowOverlayBundle(entries);
    packed.meta = { title: "overlay", lastPushMs: Date.now(), count: entries.length };
    return packed;
  }

  async function fetchFlowStream(panel) {
    const s = panel.source || {};
    const hours = Math.max(1, Math.ceil(currentMinutes / 60));
    const q =
      "/api/v1/flows/series?router_id=" +
      encodeURIComponent(s.router_id || "") +
      "&flow_id=" +
      encodeURIComponent(s.flow_id || "") +
      "&hours=" +
      encodeURIComponent(hours) +
      "&limit=500";
    const r = await fetchJson(q);
    const j = (r && r.json) || {};
    const packed = flowStreamBundle(j);
    packed.meta = {
      title: (j.flow && j.flow.remote_label) || s.flow_id,
      lastPushMs: Date.now()
    };
    return packed;
  }

  async function refreshPanel(panel) {
    const id = panel.id;
    const tid = panel.typeId;
    const src = panel.source || {};

    if (tid.indexOf("host.") === 0) {
      const rid = resolveRouter(src && src.router_id);
      ensureHostWifiWatch(rid || null, currentMinutes);
      if (!rid) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle(
            tid,
            "Set a CPE id in the toolbar and click Apply CPE"
          )
        };
        notifyPanel(id);
        return;
      }
      /* Always REST bootstrap so first paint has full history (WS watch is
       * push-on-tick only and dies until re-watch after reconnect). */
      try {
        await restHost(rid, currentMinutes);
      } catch (e) {
        /* ignore */
      }
      if (!hostPts.length) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle(
            tid,
            lastRestError
              ? "No samples for " + rid + " — " + lastRestError
              : "No host samples yet for " +
                  rid +
                  " — check agent / ClickHouse (lab CPE id is often “router”)"
          )
        };
        notifyPanel(id);
        return;
      }
      rebuildHostPanels();
      return;
    }

    if (tid === "wifi.radio" || tid === "wifi.band") {
      const rid = resolveRouter(src && src.router_id);
      ensureHostWifiWatch(rid || null, currentMinutes);
      if (!rid) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle(
            tid,
            "Set a CPE id in the toolbar and click Apply CPE"
          )
        };
        notifyPanel(id);
        return;
      }
      try {
        await restWifi(rid, currentMinutes);
      } catch (e) {
        /* ignore */
      }
      if (!wifiPts.length) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle(tid, "No wifi samples yet for " + rid)
        };
        notifyPanel(id);
        return;
      }
      rebuildWifiPanels();
      return;
    }

    if (tid === "wifi.fw") {
      const rid = resolveRouter(src && src.router_id);
      if (!rid) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle(
            tid,
            "Set a CPE id in the toolbar and click Apply CPE"
          )
        };
        notifyPanel(id);
        return;
      }
      try {
        const mins = currentMinutes || 10;
        const lim = mins <= 15 ? mins * 60 + 30 : 600;
        const q =
          "/api/v1/cpe/wifi/fw?minutes=" +
          encodeURIComponent(mins) +
          "&limit=" +
          encodeURIComponent(lim) +
          "&router_id=" +
          encodeURIComponent(rid);
        const r = await fetch(q, { credentials: "same-origin" });
        const d = await r.json();
        const pts = d && Array.isArray(d.points) ? d.points : [];
        const mapped = pts.map(function (p) {
          return {
            t: parseTs(p.ts || p.t || p.time),
            xretry_pct: Number(p.xretry_pct) || 0,
            underrun_delta: Number(p.underrun_delta) || 0,
            ppdu_ok: Number(p.ppdu_ok) || 0,
            rssi_dbm: p.rssi_dbm != null ? Number(p.rssi_dbm) : null
          };
        });
        cache[id] = {
          panel: panel,
          bundle: {
            points: mapped,
            series: [
              {
                key: "xretry_pct",
                label: "xretry %",
                color: "#e87a82",
                width: 1.4,
                fillAlpha: 0.05
              },
              {
                key: "underrun_delta",
                label: "underrun Δ",
                color: "#e6b84d",
                width: 1.2,
                fillAlpha: 0
              }
            ],
            markers: [],
            refLines: [],
            meta: {
              title: "Wi‑Fi firmware health",
              subtitle: rid + " · " + mapped.length + " samples",
              lastPushMs: Date.now(),
              stale: mapped.length === 0
            },
            yHints: { mode: "auto", includeZero: true }
          }
        };
      } catch (e) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle(tid, "Failed to load wifi/fw series")
        };
      }
      notifyPanel(id);
      return;
    }

    if (tid === "wifi.client") {
      try {
        const bundle = await fetchClientSeries(panel);
        cache[id] = { panel: panel, bundle: bundle };
      } catch (e) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle("client", "Failed to load station series")
        };
      }
      notifyPanel(id);
      return;
    }

    if (tid === "flow.overlay" || tid === "flow.defects") {
      try {
        const bundle = await fetchFlowOverlay(panel);
        if (tid === "flow.defects") {
          bundle.series = [];
        }
        cache[id] = { panel: panel, bundle: bundle };
      } catch (e) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle("flows", "Failed to load flow overlay")
        };
      }
      notifyPanel(id);
      return;
    }

    if (tid === "flow.stream") {
      try {
        const bundle = await fetchFlowStream(panel);
        cache[id] = { panel: panel, bundle: bundle };
      } catch (e) {
        cache[id] = {
          panel: panel,
          bundle: emptyBundle("stream", "Failed to load flow series")
        };
      }
      notifyPanel(id);
      return;
    }

    cache[id] = {
      panel: panel,
      bundle: emptyBundle(tid, "Unknown graph type")
    };
    notifyPanel(id);
  }

  function setMinutes(minutes) {
    const next = minutes || 10;
    if (next === currentMinutes) return;
    currentMinutes = next;
    if (mux) {
      ensureHostWifiWatch(null, currentMinutes);
      ensureFeed(true);
    }
  }

  function subscribe(panel, onBundle) {
    listeners[panel.id] = onBundle;
    cache[panel.id] = cache[panel.id] || {
      panel: panel,
      bundle: emptyBundle(panel.typeId, "Loading…")
    };
    refreshPanel(panel);
    return function () {
      delete listeners[panel.id];
    };
  }

  function unsubscribe(id) {
    delete listeners[id];
    delete cache[id];
  }

  function refreshAll(panels, minutes) {
    if (minutes) setMinutes(minutes);
    (panels || []).forEach(function (p) {
      if (!p.collapsed) refreshPanel(p);
    });
  }

  function startPolling(panelsFn, intervalMs) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      const panels = typeof panelsFn === "function" ? panelsFn() : panelsFn;
      let needHost = false;
      (panels || []).forEach(function (p) {
        if (p.collapsed) return;
        const t = p.typeId;
        if (t && t.indexOf("host.") === 0) needHost = true;
        if (t === "wifi.radio" || t === "wifi.band" || t === "wifi.fw") needHost = true;
        if (
          t === "flow.overlay" ||
          t === "flow.defects" ||
          t === "flow.stream" ||
          t === "wifi.client"
        ) {
          refreshPanel(p);
        }
      });
      if (needHost) {
        if (!watching) ensureHostWifiWatch(null, currentMinutes);
        ensureFeed(false);
        /* Sparse history: force REST more aggressively */
        if (hostPts.length < 8) ensureFeed(true);
      }
    }, intervalMs || 5000);
  }

  function stop() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }

  function latestDataEnd() {
    let end = 0;
    const extH = dataTimeExtent(hostPts);
    const extW = dataTimeExtent(wifiPts);
    if (extH) end = Math.max(end, extH.tmax);
    if (extW) end = Math.max(end, extW.tmax);
    return end;
  }

  function latestPush() {
    return Math.max(lastHostPush, lastWifiPush);
  }

  function pointCount() {
    return (hostPts && hostPts.length) || 0;
  }

  function getRouter() {
    return currentRouter || "";
  }

  function getLastError() {
    return lastRestError || "";
  }

  return {
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    refreshAll: refreshAll,
    setMinutes: setMinutes,
    startPolling: startPolling,
    stop: stop,
    latestDataEnd: latestDataEnd,
    latestPush: latestPush,
    ensureHostWifiWatch: ensureHostWifiWatch,
    ensureFeed: ensureFeed,
    resubscribe: resubscribe,
    pointCount: pointCount,
    setRouter: setRouter,
    getRouter: getRouter,
    getLastError: getLastError
  };
}
