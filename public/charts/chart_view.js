/**
 * One chart canvas: WebGPU (preferred) or Canvas2D fallback.
 * Emits pan/zoom/scrub pointer events for a shared TimeController.
 *
 * Live mode (hospital strip / host.js model):
 *  - Right edge is the pen; history scrolls left as the window advances.
 *  - Committed samples are joined with Catmull–Rom (bezier-like) curves.
 *  - Newest sample is the pen *target*; tip eases toward it (live morph).
 *  - Prefer WebGPU for continuous redraw.
 */
import { buildChartMesh, autoYRange } from "./mesh.js";
import { createWebGpuTsRenderer, webgpuAvailable } from "./webgpu_ts.js";
import { createCanvas2dTsRenderer } from "./canvas2d_ts.js";
import {
  parseColor,
  readThemeTokens,
  fmtLocalTs,
  parseTs,
  smoothTimeSeries,
  downsample,
  easeOutCubic,
  lerp
} from "./ts_util.js";

/** Subdivisions between consecutive samples for the smooth curve. */
const SMOOTH_SEGS = 10;
/** Max raw anchors before densify. */
const MAX_RAW_PTS = 600;
/** How long the live pen takes to settle on a new sample value. */
const LIVE_MORPH_MS = 1600;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onGesture?: Function, height?: number }} opts
 */
export async function createChartView(canvas, opts) {
  opts = opts || {};
  const height = opts.height || 220;
  let mode = "canvas2d";
  let gpu = null;
  let c2d = null;

  /* Prefer WebGPU first — a prior getContext("2d") can lock the canvas. */
  if (webgpuAvailable()) {
    try {
      gpu = await createWebGpuTsRenderer(canvas);
      mode = "webgpu";
    } catch (e) {
      console.warn("WebGPU chart init failed, using Canvas2D", e);
      gpu = null;
      mode = "canvas2d";
    }
  }
  if (mode === "canvas2d") {
    c2d = createCanvas2dTsRenderer(canvas);
  }

  let theme = readThemeTokens();
  let series = [];
  let markers = [];
  let refLines = [];
  let t0 = Date.now() - 600000;
  let t1 = Date.now();
  let cursorT = null;
  let yScale = {
    mode: "auto",
    yMin: 0,
    yMax: null,
    includeZero: true,
    unit: null,
    fmtY: null
  };
  let emptyMsg = "No samples yet";
  /** @type {{ live?: boolean, dataEndT?: number, receiving?: boolean }|null} */
  let liveState = null;
  let raf = 0;
  let destroyed = false;
  let lastAxis = null;
  /** Last good auto y-range so we never flash to 0–1 on a bad frame. */
  let lastGoodYRange = null;

  /**
   * Per-series live pen morph: key → { y, from, target, t0 }
   */
  const liveTips = Object.create(null);

  /* Extra right pad for live pen value readout */
  const pad = { L: 56, R: 56, T: 18, B: 28 };

  function cssSize() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 800;
    return { cssW: Math.max(120, w), cssH: height };
  }

  function scheduleDraw() {
    if (destroyed || raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      drawNow();
    });
  }

  function seriesKey(ser, idx) {
    return ser.key || ser.id || ser.label || "s" + idx;
  }

  function pointT(p) {
    if (p.t != null && isFinite(Number(p.t))) return Number(p.t);
    if (p.ts != null) return parseTs(p.ts);
    return NaN;
  }

  function pointY(p) {
    return Number(p.y != null ? p.y : p.value);
  }

  function morphTip(key, target, nowMs) {
    let tip = liveTips[key];
    if (!tip) {
      tip = liveTips[key] = {
        y: target,
        from: target,
        target: target,
        t0: nowMs
      };
      return target;
    }
    if (isFinite(target) && Math.abs(tip.target - target) > 1e-9) {
      tip.from = tip.y;
      tip.target = target;
      tip.t0 = nowMs;
    }
    const u = easeOutCubic((nowMs - tip.t0) / LIVE_MORPH_MS);
    tip.y = lerp(tip.from, tip.target, u);
    return tip.y;
  }

  /**
   * Build draw points (host.js model):
   *  - Polyline through samples (Catmull–Rom densified for smooth spans)
   *  - Live: pen always at window end; Y morphs toward newest sample
   *  - Keep every committed sample so the strip has real history to scroll
   */
  function seriesForDraw(seriesList, edgeT, nowMs) {
    if (!seriesList || !seriesList.length) return seriesList || [];
    const live = !!(liveState && liveState.live);
    const out = [];

    for (let s = 0; s < seriesList.length; s++) {
      const ser = seriesList[s];
      if (!ser || ser.hidden) {
        out.push(ser);
        continue;
      }
      const raw = ser.points || [];
      if (raw.length < 1) {
        out.push(ser);
        continue;
      }

      const norm = [];
      for (let i = 0; i < raw.length; i++) {
        const t = pointT(raw[i]);
        const y = pointY(raw[i]);
        if (!isFinite(t) || !isFinite(y)) continue;
        if (norm.length && t < norm[norm.length - 1].t) continue;
        if (norm.length && t === norm[norm.length - 1].t) {
          norm[norm.length - 1].y = y;
          continue;
        }
        norm.push({ t: t, y: y });
      }
      if (!norm.length) {
        out.push(ser);
        continue;
      }

      const anchors =
        norm.length > MAX_RAW_PTS ? downsample(norm, MAX_RAW_PTS) : norm;

      /*
       * Live: commit all samples into the curve (including newest at its
       * true timestamp) so history spans the window, then extend a short
       * morph segment from the newest sample to the pen at edgeT.
       * (Earlier we dropped the newest from the polyline and only drew a
       * hold-to-now; with few/bucketed points that looked like a flat line.)
       */
      let targetY = anchors[anchors.length - 1].y;
      let lastSampleT = anchors[anchors.length - 1].t;

      let smooth = smoothTimeSeries(anchors, SMOOTH_SEGS);
      if (!smooth.length) smooth = anchors.slice();

      const key = seriesKey(ser, s);
      let penY = targetY;
      let penT = lastSampleT;

      if (live && isFinite(edgeT) && edgeT > lastSampleT + 1) {
        penY = morphTip(key, targetY, nowMs);
        penT = edgeT;
        smooth = smooth.concat([{ t: edgeT, y: penY }]);
      } else if (live && isFinite(edgeT)) {
        penY = morphTip(key, targetY, nowMs);
        penT = edgeT;
        /* Newest is at/past edge — put pen on the last vertex */
        if (smooth.length) {
          smooth = smooth.slice();
          smooth[smooth.length - 1] = {
            t: Math.max(smooth[smooth.length - 1].t, edgeT),
            y: penY
          };
        }
      } else if (liveTips[key]) {
        delete liveTips[key];
      }

      out.push(
        Object.assign({}, ser, {
          points: smooth,
          showTip: true,
          width: ser.width != null ? Math.max(ser.width, 2.2) : 2.4,
          fillAlpha:
            ser.fillAlpha != null ? Math.max(ser.fillAlpha, 0.08) : 0.08,
          livePenY: penY,
          livePenT: penT
        })
      );
    }
    return out;
  }

  function considerY(minMax, y) {
    y = Number(y);
    if (!isFinite(y)) return;
    if (y < minMax.minY) minMax.minY = y;
    if (y > minMax.maxY) minMax.maxY = y;
  }

  /**
   * Auto Y-range from raw samples + live pens.
   *
   * Important: never fall back to 0–1 when we have rate data — that made real
   * bps values clamp to the top of the plot while the axis read "1 bps".
   */
  function resolveYRange(drawSeries) {
    if (yScale.mode === "fixed") {
      return {
        yMin: yScale.yMin != null ? yScale.yMin : 0,
        yMax: yScale.yMax != null ? yScale.yMax : 100
      };
    }

    const mm = { minY: Infinity, maxY: -Infinity };

    /* 1) Raw series (authoritative sample values, ignore time filter) */
    for (let s = 0; s < (series || []).length; s++) {
      const ser = series[s];
      if (!ser || ser.hidden) continue;
      const pts = ser.points || [];
      for (let i = 0; i < pts.length; i++) {
        considerY(mm, pts[i].y != null ? pts[i].y : pts[i].value);
      }
    }

    /* 2) Draw path + live pen (morph tip may sit between samples) */
    for (let s = 0; s < (drawSeries || []).length; s++) {
      const ser = drawSeries[s];
      if (!ser || ser.hidden) continue;
      if (ser.livePenY != null) considerY(mm, ser.livePenY);
      const pts = ser.points || [];
      for (let i = 0; i < pts.length; i++) {
        considerY(mm, pts[i].y != null ? pts[i].y : pts[i].value);
      }
    }

    let minY = mm.minY;
    let maxY = mm.maxY;

    if (!isFinite(minY) || !isFinite(maxY)) {
      /* No samples this frame — keep last good range, else a neutral placeholder */
      if (lastGoodYRange) return lastGoodYRange;
      return { yMin: 0, yMax: yScale.unit === "bps" ? 1000 : 1 };
    }

    if (yScale.includeZero !== false && minY > 0) minY = 0;
    if (yScale.yMin != null && isFinite(yScale.yMin)) {
      minY = Math.min(minY, yScale.yMin);
    }

    /* Flat / all-zero series: give the axis a readable span */
    if (maxY <= minY) {
      if (yScale.unit === "bps") {
        maxY = minY + 1000; /* 1 kbps floor so labels aren't "0…1 bps" */
      } else {
        maxY = minY + (Math.abs(minY) > 1e-9 ? Math.abs(minY) * 0.1 : 1);
      }
    }

    /* Headroom so the pen isn't glued to the top border */
    const span = maxY - minY;
    const padAmt = Math.max(span * 0.12, yScale.unit === "bps" ? 1 : 0);
    maxY += padAmt;
    if (yScale.includeZero === false || minY < 0) {
      minY -= padAmt * 0.5;
    }

    if (!(maxY > minY)) {
      maxY = minY + (yScale.unit === "bps" ? 1000 : 1);
    }

    const range = { yMin: minY, yMax: maxY };
    lastGoodYRange = range;
    return range;
  }

  function drawNow() {
    if (destroyed) return;
    const { cssW, cssH } = cssSize();
    theme = readThemeTokens();
    const bg = parseColor(theme.bg, 1);
    const nowMs = Date.now();

    const drawSeries = seriesForDraw(series, t1, nowMs);
    const yr = resolveYRange(drawSeries);

    const model = {
      cssW: cssW,
      cssH: cssH,
      padL: pad.L,
      padR: pad.R,
      padT: pad.T,
      padB: pad.B,
      t0: t0,
      t1: t1,
      yMin: yr.yMin,
      yMax: yr.yMax,
      series: drawSeries,
      markers: markers,
      refLines: refLines,
      cursorT: cursorT,
      liveState: liveState,
      bgColor: theme.bg,
      plotColor: theme.plot,
      gridColor: theme.grid,
      defectColor: theme.defect,
      cursorColor: theme.text,
      borderColor: theme.border
    };

    const hasPts = drawSeries.some(function (s) {
      return s.points && s.points.length;
    });

    if (mode === "webgpu" && gpu) {
      const mesh = buildChartMesh(model);
      lastAxis = mesh.axis;
      gpu.draw(mesh.verts, {
        cssW: cssW,
        cssH: cssH,
        clear: bg
      });
    } else if (c2d) {
      c2d.drawModel(model);
      lastAxis = {
        padL: pad.L,
        padR: pad.R,
        padT: pad.T,
        padB: pad.B,
        plotW: cssW - pad.L - pad.R,
        plotH: cssH - pad.T - pad.B,
        t0: t0,
        t1: t1,
        yMin: yr.yMin,
        yMax: yr.yMax,
        cssW: cssW,
        cssH: cssH,
        xAt: function (t) {
          return pad.L + ((cssW - pad.L - pad.R) * (t - t0)) / (t1 - t0);
        },
        yAt: function (v) {
          return (
            pad.T +
            (cssH - pad.T - pad.B) * (1 - (v - yr.yMin) / (yr.yMax - yr.yMin))
          );
        }
      };
    }

    paintAxisOverlay(cssW, cssH, yr, hasPts, drawSeries);
  }

  let overlay = canvas._ehAxisOverlay;
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "chart-axis-overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
    const wrap = canvas.parentElement;
    if (wrap) {
      if (getComputedStyle(wrap).position === "static") {
        wrap.style.position = "relative";
      }
      wrap.appendChild(overlay);
    }
    canvas._ehAxisOverlay = overlay;
  }

  function paintAxisOverlay(cssW, cssH, yr, hasPts, drawSeries) {
    if (!overlay) return;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.floor(cssW * dpr);
    overlay.height = Math.floor(cssH * dpr);
    overlay.style.width = cssW + "px";
    overlay.style.height = cssH + "px";
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const plotH = cssH - pad.T - pad.B;
    const plotW = cssW - pad.L - pad.R;
    const plotRight = pad.L + plotW;

    ctx.fillStyle = theme.label || "#7a756c";
    ctx.font = "600 11px IBM Plex Mono, ui-monospace, monospace";
    ctx.textAlign = "right";
    let i;
    for (i = 0; i <= 4; i++) {
      const frac = i / 4;
      const gy = pad.T + plotH * frac;
      const gv = yr.yMax - (yr.yMax - yr.yMin) * frac;
      const label = yScale.fmtY ? yScale.fmtY(gv) : gv.toFixed(1);
      ctx.fillText(label, pad.L - 6, gy + 3);
    }

    ctx.textAlign = "center";
    ctx.fillStyle = theme.muted || "#9a958c";
    ctx.font = "500 11px Outfit, system-ui, sans-serif";
    ctx.fillText(fmtLocalTs(t0, "time"), pad.L + 28, cssH - 8);

    if (liveState && liveState.live) {
      const liveColor = liveState.receiving
        ? theme.ok || "#4ecf9a"
        : theme.warn || "#e6b84d";
      ctx.fillStyle = liveColor;
      ctx.font = "700 11px Outfit, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(
        liveState.receiving ? "LIVE" : "LIVE · stalled",
        plotRight - 4,
        pad.T - 4
      );
      ctx.fillStyle = theme.muted || "#9a958c";
      ctx.font = "500 11px Outfit, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(fmtLocalTs(t1, "time"), plotRight - 28, cssH - 8);

      if (drawSeries && drawSeries.length) {
        let penY = null;
        let penColor = theme.ok || "#4ecf9a";
        for (i = 0; i < drawSeries.length; i++) {
          const ser = drawSeries[i];
          if (!ser || ser.hidden) continue;
          if (ser.livePenY != null && isFinite(ser.livePenY)) {
            penY = ser.livePenY;
            penColor = ser.color || penColor;
            break;
          }
        }
        if (penY != null) {
          const txt = yScale.fmtY ? yScale.fmtY(penY) : penY.toFixed(1);
          const py =
            pad.T +
            plotH * (1 - (penY - yr.yMin) / Math.max(1e-9, yr.yMax - yr.yMin));
          const clamped = Math.max(pad.T + 10, Math.min(pad.T + plotH - 4, py));
          ctx.fillStyle = penColor;
          ctx.font = "700 11px IBM Plex Mono, ui-monospace, monospace";
          ctx.textAlign = "left";
          ctx.fillText(txt, plotRight + 4, clamped + 3);
        }
      }
    } else {
      ctx.textAlign = "center";
      ctx.fillText(fmtLocalTs(t1, "time"), plotRight - 28, cssH - 8);
      ctx.fillStyle = theme.muted || "#9a958c";
      ctx.font = "600 10px Outfit, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("history", plotRight - 4, pad.T - 4);
    }

    if (!hasPts) {
      ctx.textAlign = "left";
      ctx.fillStyle = theme.text || "#d4cfc6";
      ctx.font = "600 13px Outfit, system-ui, sans-serif";
      ctx.fillText(emptyMsg, pad.L + 8, pad.T + 22);
    }
  }

  /* ── gestures ─────────────────────────────────────────── */
  let drag = null;

  function emit(type, detail) {
    if (typeof opts.onGesture === "function") {
      opts.onGesture(Object.assign({ type: type }, detail));
    }
  }

  function timeAtClientX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const plotL = pad.L;
    const plotR = rect.width - pad.R;
    const u = (x - plotL) / Math.max(1, plotR - plotL);
    const cl = Math.max(0, Math.min(1, u));
    return t0 + (t1 - t0) * cl;
  }

  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";

  canvas.addEventListener(
    "wheel",
    function (ev) {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const frac = Math.max(
        0,
        Math.min(
          1,
          (ev.clientX - rect.left - pad.L) /
            Math.max(1, rect.width - pad.L - pad.R)
        )
      );
      const factor = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
      emit("zoom", { factor: factor, anchorFrac: frac, clientX: ev.clientX });
    },
    { passive: false }
  );

  canvas.addEventListener("pointerdown", function (ev) {
    if (ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    drag = {
      x0: ev.clientX,
      t0: t0,
      t1: t1,
      scrub: ev.shiftKey || ev.altKey,
      moved: false
    };
    canvas.style.cursor = drag.scrub ? "col-resize" : "grabbing";
    if (drag.scrub) {
      emit("scrub", { t: timeAtClientX(ev.clientX), live: false });
    }
  });

  canvas.addEventListener("pointermove", function (ev) {
    if (!drag) {
      emit("hover", { t: timeAtClientX(ev.clientX), clientX: ev.clientX });
      return;
    }
    const dx = ev.clientX - drag.x0;
    if (Math.abs(dx) > 2) drag.moved = true;
    if (drag.scrub) {
      emit("scrub", { t: timeAtClientX(ev.clientX), live: false });
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - pad.L - pad.R);
    const dur = drag.t1 - drag.t0;
    const dt = (-dx / plotW) * dur;
    emit("pan", { t0: drag.t0 + dt, t1: drag.t1 + dt });
  });

  function endDrag(ev) {
    if (!drag) return;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch (e) {
      /* ignore */
    }
    drag = null;
    canvas.style.cursor = "grab";
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("dblclick", function () {
    emit("live", {});
  });

  canvas.addEventListener("pointerleave", function () {
    emit("hover", { t: null });
  });

  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(function () {
          scheduleDraw();
        })
      : null;
  if (ro) ro.observe(canvas.parentElement || canvas);

  return {
    mode: mode,
    setSeries: function (s) {
      series = s || [];
      scheduleDraw();
    },
    setMarkers: function (m) {
      markers = m || [];
      scheduleDraw();
    },
    setRefLines: function (r) {
      refLines = r || [];
      scheduleDraw();
    },
    setWindow: function (w) {
      if (w.t0 != null) t0 = w.t0;
      if (w.t1 != null) t1 = w.t1;
      scheduleDraw();
    },
    setCursor: function (t) {
      cursorT = t;
      scheduleDraw();
    },
    /**
     * @param {{ live?: boolean, dataEndT?: number|null, receiving?: boolean }|null} st
     */
    setLiveState: function (st) {
      liveState = st || null;
      if (!liveState || !liveState.live) {
        for (const k in liveTips) {
          if (Object.prototype.hasOwnProperty.call(liveTips, k)) {
            delete liveTips[k];
          }
        }
      }
      scheduleDraw();
    },
    setYScale: function (ys) {
      ys = ys || {};
      yScale = {
        mode: ys.mode || "auto",
        yMin: ys.yMin,
        yMax: ys.yMax,
        fmtY: ys.fmtY || null,
        includeZero: ys.includeZero !== false,
        unit: ys.unit || null
      };
      /* Drop cached range when scale mode/unit changes */
      lastGoodYRange = null;
      scheduleDraw();
    },
    setEmptyMessage: function (msg) {
      emptyMsg = msg || "No samples yet";
      scheduleDraw();
    },
    setTheme: function () {
      theme = readThemeTokens();
      scheduleDraw();
    },
    redraw: scheduleDraw,
    getAxis: function () {
      return lastAxis;
    },
    destroy: function () {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (gpu) gpu.destroy();
      if (overlay && overlay.parentElement) {
        overlay.parentElement.removeChild(overlay);
      }
      canvas._ehAxisOverlay = null;
      for (const k in liveTips) {
        if (Object.prototype.hasOwnProperty.call(liveTips, k)) {
          delete liveTips[k];
        }
      }
    }
  };
}

export { webgpuAvailable };
