/**
 * Shared time-series helpers for edgehost charts.
 */

export function parseTs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === "number") {
    return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  }
  var s = String(ts).trim();
  if (!s) return NaN;
  /* Numeric string (unix s or ms) */
  if (/^\d+(\.\d+)?$/.test(s)) {
    var n = Number(s);
    if (!isFinite(n)) return NaN;
    return n > 0 && n < 1e12 ? n * 1000 : n;
  }
  var t = Date.parse(s);
  if (!isNaN(t)) return t;
  /* ClickHouse DateTime: "YYYY-MM-DD HH:mm:ss" (no T / zone) */
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    t = Date.parse(s.replace(" ", "T") + "Z");
    if (isNaN(t)) t = Date.parse(s.replace(" ", "T"));
  }
  return isNaN(t) ? NaN : t;
}

export function dataTimeExtent(pts) {
  if (!pts || !pts.length) return null;
  var tmin = Infinity;
  var tmax = -Infinity;
  for (var i = 0; i < pts.length; i++) {
    var v =
      pts[i].t != null && isFinite(pts[i].t)
        ? pts[i].t
        : parseTs(pts[i].ts);
    if (!isFinite(v)) continue;
    if (v < tmin) tmin = v;
    if (v > tmax) tmax = v;
  }
  if (!isFinite(tmin) || !isFinite(tmax)) return null;
  return { tmin: tmin, tmax: tmax };
}

export function fmtRate(bps) {
  bps = Number(bps);
  if (!isFinite(bps)) return "—";
  const sign = bps < 0 ? "-" : "";
  bps = Math.abs(bps);
  if (bps < 1000) return sign + bps.toFixed(bps < 10 && bps > 0 ? 1 : 0) + " bps";
  if (bps < 1e6) return sign + (bps / 1000).toFixed(1) + " kbps";
  if (bps < 1e9) return sign + (bps / 1e6).toFixed(2) + " Mbps";
  return sign + (bps / 1e9).toFixed(2) + " Gbps";
}

export function fmtPct(v) {
  return (Number(v) || 0).toFixed(1) + "%";
}

export function fmtNum(v, digits) {
  digits = digits == null ? 1 : digits;
  return (Number(v) || 0).toFixed(digits);
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  if (n < 1073741824) return (n / 1048576).toFixed(2) + " MiB";
  return (n / 1073741824).toFixed(2) + " GiB";
}

export function fmtDuration(ms) {
  ms = Math.max(0, Number(ms) || 0);
  if (ms < 60000) return Math.round(ms / 1000) + "s";
  if (ms < 3600000) return Math.round(ms / 60000) + "m";
  if (ms < 86400000) {
    var h = ms / 3600000;
    return h < 10 ? h.toFixed(1) + "h" : Math.round(h) + "h";
  }
  return (ms / 86400000).toFixed(1) + "d";
}

export function fmtLocalTs(ms, mode) {
  if (ms == null || !isFinite(ms)) return "—";
  var d = new Date(ms);
  if (mode === "time") {
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
}

/**
 * Ease-out cubic in [0,1].
 */
export function easeOutCubic(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  var t = 1 - u;
  return 1 - t * t * t;
}

/**
 * Linear interpolate.
 */
export function lerp(a, b, u) {
  return a + (b - a) * u;
}

/**
 * Centripetal-friendly cubic Catmull–Rom (uniform) on scalars.
 * Passes through p1 at u=0 and p2 at u=1.
 */
export function catmullRom(p0, p1, p2, p3, u) {
  var u2 = u * u;
  var u3 = u2 * u;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

/**
 * Densify time-series points with cubic Catmull–Rom in Y and linear T.
 * Produces a smooth bezier-like curve through each sample (ECG-style).
 *
 * @param {Array<{t?:number,y?:number,value?:number,ts?:string|number}>} pts
 * @param {number} [segmentsPerSpan=10] subdivisions between consecutive samples
 * @returns {Array<{t:number,y:number}>}
 */
export function smoothTimeSeries(pts, segmentsPerSpan) {
  var segs = segmentsPerSpan != null ? segmentsPerSpan | 0 : 10;
  if (segs < 2) segs = 2;
  if (!pts || pts.length < 2) {
    if (!pts || !pts.length) return [];
    var only = pts[0];
    var ot = only.t != null ? only.t : parseTs(only.ts);
    var oy = Number(only.y != null ? only.y : only.value);
    if (!isFinite(ot) || !isFinite(oy)) return [];
    return [{ t: ot, y: oy }];
  }

  var raw = [];
  var i;
  for (i = 0; i < pts.length; i++) {
    var t = pts[i].t != null ? pts[i].t : parseTs(pts[i].ts);
    var y = Number(pts[i].y != null ? pts[i].y : pts[i].value);
    if (!isFinite(t) || !isFinite(y)) continue;
    /* drop non-monotonic duplicates that break the spline */
    if (raw.length && t < raw[raw.length - 1].t) continue;
    if (raw.length && t === raw[raw.length - 1].t) {
      raw[raw.length - 1].y = y;
      continue;
    }
    raw.push({ t: t, y: y });
  }
  if (raw.length < 2) return raw;

  function yAt(idx) {
    if (idx < 0) return raw[0].y;
    if (idx >= raw.length) return raw[raw.length - 1].y;
    return raw[idx].y;
  }

  var out = [];
  out.push({ t: raw[0].t, y: raw[0].y });
  for (i = 0; i < raw.length - 1; i++) {
    var t1 = raw[i].t;
    var t2 = raw[i + 1].t;
    var y0 = yAt(i - 1);
    var y1 = yAt(i);
    var y2 = yAt(i + 1);
    var y3 = yAt(i + 2);
    var s;
    for (s = 1; s <= segs; s++) {
      var u = s / segs;
      out.push({
        t: t1 + (t2 - t1) * u,
        y: catmullRom(y0, y1, y2, y3, u)
      });
    }
  }
  return out;
}

/** p95 of finite values for spiky series scaling. */
export function robustMax(vals, floor) {
  var a = [];
  var i;
  for (i = 0; i < (vals || []).length; i++) {
    var v = Number(vals[i]);
    if (isFinite(v)) a.push(v);
  }
  if (!a.length) return floor != null ? floor : 1;
  a.sort(function (x, y) {
    return x - y;
  });
  var idx = Math.min(a.length - 1, Math.floor(a.length * 0.95));
  var m = a[idx];
  if (floor != null && m < floor) m = floor;
  return m > 0 ? m : 1;
}

/**
 * Decimate points for display: keep ~maxPts evenly by index
 * while always retaining first/last.
 */
export function downsample(pts, maxPts) {
  if (!pts || pts.length <= maxPts) return pts || [];
  maxPts = Math.max(4, maxPts | 0);
  var out = [];
  var n = pts.length;
  var step = (n - 1) / (maxPts - 1);
  var i;
  for (i = 0; i < maxPts; i++) {
    var idx = Math.round(i * step);
    if (idx >= n) idx = n - 1;
    if (!out.length || out[out.length - 1] !== pts[idx]) {
      out.push(pts[idx]);
    }
  }
  return out;
}

/** Parse #rgb / #rrggbb / rgba() / css named fallback → [r,g,b,a] 0..1 */
export function parseColor(c, alpha) {
  var a = alpha != null ? alpha : 1;
  if (!c) return [0.4, 0.5, 0.7, a];
  c = String(c).trim();
  var m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    var h = m[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16) / 255,
        parseInt(h[1] + h[1], 16) / 255,
        parseInt(h[2] + h[2], 16) / 255,
        a
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
      a
    ];
  }
  m = c.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i
  );
  if (m) {
    return [
      Number(m[1]) / 255,
      Number(m[2]) / 255,
      Number(m[3]) / 255,
      m[4] != null ? Number(m[4]) : a
    ];
  }
  return [0.4, 0.5, 0.7, a];
}

export function readThemeTokens(el) {
  var root = el || document.documentElement;
  var cs = getComputedStyle(root);
  function v(name, fb) {
    var x = (cs.getPropertyValue(name) || "").trim();
    return x || fb;
  }
  return {
    bg: v("--surface", "#1a2030"),
    plot: v("--chart-plot", "rgba(15,18,24,0.25)"),
    grid: v("--chart-grid", "rgba(46,54,72,0.55)"),
    label: v("--chart-label", "#7a756c"),
    lineA: v("--chart-line-a", "#6b8cff"),
    lineB: v("--chart-line-b", "#c4788a"),
    fill: v("--chart-fill", "rgba(107,140,255,0.08)"),
    defect: v("--chart-defect", "#e87a82"),
    peak: v("--chart-peak", "rgba(232,122,130,0.55)"),
    text: v("--text-soft", "#d4cfc6"),
    muted: v("--muted", "#9a958c"),
    ok: v("--ok", "#4ecf9a"),
    warn: v("--warn", "#e6b84d"),
    bad: v("--bad", "#e87a82"),
    border: v("--border", "#2e3648")
  };
}

export var CORE_COLORS = [
  "#6b8cff",
  "#5ad67d",
  "#f0a040",
  "#e070f0",
  "#e0c040",
  "#4ecf9a",
  "#c4788a",
  "#8ec8ff"
];

export var OVERLAY_COLORS = [
  "#6b8cff",
  "#c4788a",
  "#4ecf9a",
  "#e6b84d",
  "#9b7bff",
  "#5ec8d6",
  "#e88a5a",
  "#a0a8b8"
];
