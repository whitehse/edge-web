/**
 * Shared chart_view embed for host/flows pages (PR-7 stretch).
 * Installs window.EdgeChartEmbed used by host.js / flows.js when present.
 *
 * Host/flows stay classic scripts; this module loads first:
 *   <script type="module" src="/charts/page_embed.js"></script>
 */
import { createChartView } from "/charts/chart_view.js";

const views = new WeakMap();

function parseTs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === "number" && isFinite(ts)) {
    return ts > 1e12 ? ts : ts * 1000;
  }
  const n = Number(ts);
  if (isFinite(n) && String(ts).trim() !== "") {
    return n > 1e12 ? n : n * 1000;
  }
  const d = Date.parse(ts);
  return isFinite(d) ? d : NaN;
}

/**
 * Convert host-style pts [{ts, key: val, ...}] + series [{key,label,color}]
 * into chart_view series [{label,color,points:[{t,y}]}].
 */
function toViewSeries(pts, seriesDefs) {
  if (!pts || !seriesDefs) return [];
  return seriesDefs.map(function (s) {
    const points = [];
    for (let i = 0; i < pts.length; i++) {
      const t = parseTs(pts[i].ts != null ? pts[i].ts : pts[i].t);
      const y = Number(pts[i][s.key]);
      if (!isFinite(t) || !isFinite(y)) continue;
      points.push({ t: t, y: y });
    }
    return {
      key: s.key,
      label: s.label || s.key,
      color: s.color || "#6b8cff",
      points: points
    };
  });
}

async function getView(canvas, height) {
  let slot = views.get(canvas);
  if (slot && slot.view) return slot.view;
  const view = await createChartView(canvas, { height: height || 220 });
  views.set(canvas, { view: view });
  return view;
}

/**
 * Plot host/flows style series onto a canvas using chart_view (WebGPU preferred).
 * @returns {Promise<boolean>} true if plotted via chart_view
 */
async function plot(canvas, pts, seriesDefs, opts) {
  opts = opts || {};
  if (!canvas) return false;
  try {
    const view = await getView(canvas, opts.height || 240);
    const vs = toViewSeries(pts, seriesDefs);
    const now = Date.now();
    const winMs = (opts.windowMinutes || 10) * 60 * 1000;
    let t1 = now;
    let t0 = now - winMs;
    if (opts.t0 != null) t0 = opts.t0;
    if (opts.t1 != null) t1 = opts.t1;
    view.setWindow({ t0: t0, t1: t1 });
    view.setLiveState({
      live: opts.live !== false,
      dataEndT: t1,
      receiving: true
    });
    if (opts.fixedY || (opts.ymin != null && opts.ymax != null)) {
      view.setYScale({
        mode: "fixed",
        yMin: opts.ymin != null ? opts.ymin : 0,
        yMax: opts.ymax != null ? opts.ymax : 100,
        fmtY: opts.fmtY || null
      });
    } else {
      view.setYScale({
        mode: "auto",
        includeZero: opts.includeZero !== false,
        fmtY: opts.fmtY || null
      });
    }
    if (opts.refLines) {
      view.setRefLines(opts.refLines);
    }
    view.setSeries(vs);
    view.setEmptyMessage(opts.emptyMsg || "No samples yet");
    return true;
  } catch (e) {
    console.warn("EdgeChartEmbed.plot failed", e);
    return false;
  }
}

function modeFor(canvas) {
  const slot = views.get(canvas);
  return slot && slot.view ? slot.view.mode : null;
}

const api = {
  plot: plot,
  modeFor: modeFor,
  ready: true
};

if (typeof window !== "undefined") {
  window.EdgeChartEmbed = api;
  try {
    window.dispatchEvent(new CustomEvent("edgechart:ready"));
  } catch (e) {
    /* ignore */
  }
}

export { plot, modeFor, toViewSeries };
