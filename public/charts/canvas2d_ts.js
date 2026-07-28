/**
 * Canvas2D fallback for the same mesh/series model (light strokes).
 * Series are clipped to the plot rect so they never paint under the Y-axis.
 */
import { parseColor, parseTs, downsample } from "./ts_util.js";

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createCanvas2dTsRenderer(canvas) {
  /**
   * @param {object} model — same fields as buildChartMesh opts
   */
  function drawModel(model) {
    const cssW = model.cssW || canvas.clientWidth || 800;
    const cssH = model.cssH || 220;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padL = model.padL != null ? model.padL : 56;
    const padR = model.padR != null ? model.padR : 16;
    const padT = model.padT != null ? model.padT : 16;
    const padB = model.padB != null ? model.padB : 28;
    const t0 = model.t0;
    const t1 = model.t1 > model.t0 ? model.t1 : model.t0 + 1;
    const yMin = isFinite(model.yMin) ? model.yMin : 0;
    const yMax =
      isFinite(model.yMax) && model.yMax > yMin ? model.yMax : yMin + 1;
    const plotW = Math.max(1, cssW - padL - padR);
    const plotH = Math.max(1, cssH - padT - padB);
    const plotRight = padL + plotW;

    function xAt(t) {
      return padL + (plotW * (t - t0)) / (t1 - t0);
    }
    function yAt(v) {
      return padT + plotH * (1 - (v - yMin) / (yMax - yMin));
    }

    const bg = parseColor(model.bgColor || "#121820", 1);
    ctx.fillStyle = rgbaCss(bg);
    ctx.fillRect(0, 0, cssW, cssH);

    const plotBg = parseColor(model.plotColor || "rgba(8,12,18,0.45)", 1);
    ctx.fillStyle = rgbaCss(plotBg);
    ctx.fillRect(padL, padT, plotW, plotH);

    const grid = parseColor(model.gridColor || "rgba(46,54,72,0.5)", 1);
    ctx.strokeStyle = rgbaCss(grid);
    ctx.lineWidth = 1;
    let g;
    for (g = 0; g <= 4; g++) {
      const gy = padT + (plotH * g) / 4;
      ctx.globalAlpha = g === 0 || g === 4 ? 1 : 0.55;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(plotRight, gy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    (model.refLines || []).forEach(function (ref) {
      if (!isFinite(ref.value) || ref.value < yMin || ref.value > yMax) return;
      const c = parseColor(ref.color || "#e87a82", 0.85);
      ctx.strokeStyle = rgbaCss(c);
      ctx.lineWidth = 1.25;
      ctx.setLineDash(ref.dash || [4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, yAt(ref.value));
      ctx.lineTo(plotRight, yAt(ref.value));
      ctx.stroke();
      ctx.setLineDash([]);
    });

    const live = model.liveState || null;
    if (live && live.dataEndT != null && isFinite(live.dataEndT)) {
      const de = live.dataEndT;
      if (de >= t0 && de <= t1) {
        const dx0 = Math.max(padL, Math.min(plotRight, xAt(de)));
        if (plotRight - dx0 > 1) {
          ctx.fillStyle = rgbaCss(
            parseColor(live.receiving ? "#4ecf9a" : "#e6b84d", 0.04)
          );
          ctx.fillRect(dx0, padT, plotRight - dx0, plotH);
        }
      }
    }

    /* Clip all series drawing to the plot rectangle */
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();

    const maxPts = Math.max(64, Math.floor(plotW * 2.5));
    (model.series || []).forEach(function (ser) {
      if (!ser || ser.hidden) return;
      let pts = ser.points || [];
      if (pts.length > maxPts) pts = downsample(pts, maxPts);
      const path = [];
      let i;
      for (i = 0; i < pts.length; i++) {
        const t = pts[i].t != null ? pts[i].t : parseTs(pts[i].ts);
        const yv = Number(pts[i].y != null ? pts[i].y : pts[i].value);
        if (!isFinite(t) || !isFinite(yv)) continue;
        path.push({ x: xAt(t), y: yAt(yv) });
      }
      if (!path.length) return;
      const col = parseColor(ser.color || "#6b8cff", 1);
      const fillA = ser.fillAlpha != null ? ser.fillAlpha : 0;
      if (fillA > 0 && path.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(path[0].x, padT + plotH);
        for (i = 0; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
        ctx.lineTo(path[path.length - 1].x, padT + plotH);
        ctx.closePath();
        ctx.fillStyle = rgbaCss([col[0], col[1], col[2], fillA]);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.strokeStyle = rgbaCss(col);
      ctx.lineWidth = ser.width != null ? ser.width : 1.35;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (i = 0; i < path.length; i++) {
        if (i === 0) ctx.moveTo(path[i].x, path[i].y);
        else ctx.lineTo(path[i].x, path[i].y);
      }
      ctx.stroke();
      if (ser.showTip !== false) {
        const tip = path[path.length - 1];
        if (tip.x >= padL && tip.x <= plotRight) {
          ctx.fillStyle = rgbaCss(col);
          ctx.beginPath();
          ctx.arc(tip.x, tip.y, 2.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });

    (model.markers || []).forEach(function (mk) {
      const mt = mk.t != null ? mk.t : parseTs(mk.ts);
      if (!isFinite(mt) || mt < t0 || mt > t1) return;
      const mc = parseColor(mk.color || model.defectColor || "#e87a82", 0.9);
      ctx.fillStyle = rgbaCss(mc);
      const mw = mk.kind === "destroy" ? 2 : 1.25;
      ctx.fillRect(xAt(mt) - mw * 0.5, padT, mw, plotH);
    });

    if (live && live.dataEndT != null && isFinite(live.dataEndT)) {
      const det = live.dataEndT;
      if (det >= t0 && det <= t1) {
        const dex = xAt(det);
        ctx.strokeStyle = rgbaCss(
          parseColor(live.receiving ? "#4ecf9a" : "#e6b84d", 0.35)
        );
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(dex, padT);
        ctx.lineTo(dex, padT + plotH);
        ctx.stroke();
      }
    }

    if (live && live.live) {
      ctx.strokeStyle = rgbaCss(
        parseColor(live.receiving ? "#4ecf9a" : "#e6b84d", 0.45)
      );
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(plotRight - 0.6, padT);
      ctx.lineTo(plotRight - 0.6, padT + plotH);
      ctx.stroke();
    }

    if (model.cursorT != null && isFinite(model.cursorT)) {
      const cx = xAt(model.cursorT);
      if (cx >= padL && cx <= plotRight) {
        ctx.strokeStyle = "rgba(232,226,216,0.55)";
        ctx.lineWidth = 1.25;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, padT);
        ctx.lineTo(cx, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.restore();

    /* plot border */
    ctx.strokeStyle = "rgba(46,54,72,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
  }

  function draw() {
    /* mesh path unused for 2d; drawModel is preferred */
  }

  function destroy() {
    /* nothing */
  }

  return { draw, drawModel, destroy, mode: "canvas2d" };
}

function rgbaCss(c) {
  return (
    "rgba(" +
    Math.round(c[0] * 255) +
    "," +
    Math.round(c[1] * 255) +
    "," +
    Math.round(c[2] * 255) +
    "," +
    c[3] +
    ")"
  );
}
