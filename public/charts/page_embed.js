/**
 * Shared chart_view embed for host/flows pages (PR-7 stretch).
 * Installs window.EdgeChartEmbed used by host.js / flows.js when present.
 *
 * Host/flows stay classic scripts; this module loads deferred:
 *   <script type="module" src="/charts/page_embed.js"></script>
 *
 * Live window + timestamp rules must match host.js / live_feed.js:
 *  - ClickHouse DateTime text is UTC (force …T…Z; never bare Date.parse).
 *  - Right edge may only lead the latest sample by LIVE_LEAD_MS.
 */
import { createChartView } from "/charts/chart_view.js";
import { parseTs, dataTimeExtent } from "/charts/ts_util.js";

const views = new WeakMap();

/**
 * Convert host-style pts [{ts, key: val, ...}] + series [{key,label,color}]
 * into chart_view series [{label,color,points:[{t,y}]}].
 */
function toViewSeries(pts, seriesDefs) {
  if (!pts || !seriesDefs) return [];
  return seriesDefs.map(function (s) {
    const points = [];
    for (let i = 0; i < pts.length; i++) {
      const raw = pts[i].ts != null ? pts[i].ts : pts[i].t;
      const t = parseTs(raw);
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

/** Latest sample time across view series (ms), or 0. */
function seriesDataEnd(vs) {
  let tmax = 0;
  for (let s = 0; s < (vs || []).length; s++) {
    const pts = vs[s] && vs[s].points;
    if (!pts || !pts.length) continue;
    for (let i = 0; i < pts.length; i++) {
      const t = pts[i].t;
      if (isFinite(t) && t > tmax) tmax = t;
    }
  }
  return tmax;
}

/**
 * Live [t0,t1] matching LiveFeed.liveWindow / host plotSeriesLegacy.
 */
function resolveWindow(opts, dataEndMs, nowMs) {
  const winMs = (opts.windowMinutes || 10) * 60 * 1000;
  if (opts.t0 != null && opts.t1 != null && isFinite(opts.t0) && isFinite(opts.t1)) {
    return {
      t0: opts.t0,
      t1: opts.t1 > opts.t0 ? opts.t1 : opts.t0 + 1,
      stale: false,
      receiving: true
    };
  }

  const LF =
    typeof window !== "undefined" && window.LiveFeed ? window.LiveFeed : null;
  const lastPush =
    opts.lastPushMs != null && isFinite(opts.lastPushMs) ? opts.lastPushMs : 0;
  const leadMs = (LF && LF.LIVE_LEAD_MS) || 2500;
  const staleMs = (LF && LF.FEED_STALE_MS) || 15000;

  if (LF && typeof LF.liveWindow === "function") {
    const lw = LF.liveWindow({
      nowMs: nowMs,
      durationMs: winMs,
      dataEndMs: dataEndMs,
      lastPushMs: lastPush,
      leadMs: leadMs,
      staleMs: staleMs
    });
    return {
      t0: lw.t0,
      t1: lw.t1,
      stale: !!lw.stale,
      receiving: !lw.stale && (lastPush > 0 || dataEndMs > 0)
    };
  }

  /* Fallback: wall clock with lead cap (same rules as live_feed.js). */
  let t1 = nowMs;
  if (dataEndMs > 0) {
    const feedAge = lastPush > 0 ? nowMs - lastPush : 0;
    const stale = lastPush > 0 && feedAge > staleMs;
    if (stale) {
      t1 = dataEndMs + leadMs;
    } else {
      const leadCap = dataEndMs + leadMs;
      if (t1 > leadCap) t1 = leadCap;
    }
  }
  return {
    t0: t1 - winMs,
    t1: t1,
    stale: lastPush > 0 && nowMs - lastPush > staleMs,
    receiving: !(lastPush > 0 && nowMs - lastPush > staleMs)
  };
}

async function getView(canvas, height) {
  let slot = views.get(canvas);
  if (slot && slot.view) return slot.view;
  /* Serialize concurrent first-paint creates (host/flows anim loops). */
  if (slot && slot.pending) return slot.pending;
  const pending = createChartView(canvas, { height: height || 220 }).then(
    function (view) {
      views.set(canvas, { view: view });
      return view;
    },
    function (err) {
      views.delete(canvas);
      throw err;
    }
  );
  views.set(canvas, { pending: pending });
  return pending;
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

    /* Prefer series-derived end; fall back to raw pts extent. */
    let dataEnd = seriesDataEnd(vs);
    if (!(dataEnd > 0) && pts && pts.length) {
      const ext = dataTimeExtent(pts);
      if (ext && ext.tmax > 0) dataEnd = ext.tmax;
    }

    const win = resolveWindow(opts, dataEnd, now);
    view.setWindow({ t0: win.t0, t1: win.t1 });
    view.setLiveState({
      live: opts.live !== false,
      /* Pen / hold band should track real samples, not wall clock alone. */
      dataEndT: dataEnd > 0 ? dataEnd : win.t1,
      receiving: opts.live === false ? false : win.receiving
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
  ready: true,
  /* Expose for unit-style smoke checks / debugging. */
  _toViewSeries: toViewSeries,
  _resolveWindow: resolveWindow
};

if (typeof window !== "undefined") {
  window.EdgeChartEmbed = api;
  try {
    window.dispatchEvent(new CustomEvent("edgechart:ready"));
  } catch (e) {
    /* ignore */
  }
}

export { plot, modeFor, toViewSeries, resolveWindow };
