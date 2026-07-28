/**
 * CPU mesh builder for light time-series charts.
 * Interleaved verts: x,y,r,g,b,a (pixel space, +Y down).
 * Series geometry is clipped to the plot rectangle so lines never
 * paint under the Y-axis gutter.
 */
import { parseColor, parseTs, downsample } from "./ts_util.js";

function pushVert(buf, x, y, rgba) {
  buf.push(x, y, rgba[0], rgba[1], rgba[2], rgba[3]);
}

function pushTri(buf, x0, y0, x1, y1, x2, y2, rgba) {
  pushVert(buf, x0, y0, rgba);
  pushVert(buf, x1, y1, rgba);
  pushVert(buf, x2, y2, rgba);
}

function pushQuad(buf, x0, y0, x1, y1, x2, y2, x3, y3, rgba) {
  pushTri(buf, x0, y0, x1, y1, x2, y2, rgba);
  pushTri(buf, x0, y0, x2, y2, x3, y3, rgba);
}

function pushRect(buf, x, y, w, h, rgba) {
  if (w <= 0 || h <= 0) return;
  pushQuad(buf, x, y, x + w, y, x + w, y + h, x, y + h, rgba);
}

/**
 * Clip segment AB to x ∈ [xMin, xMax]. Returns null or {ax,ay,bx,by}.
 */
function clipSegX(ax, ay, bx, by, xMin, xMax) {
  if ((ax < xMin && bx < xMin) || (ax > xMax && bx > xMax)) return null;
  var x0 = ax;
  var y0 = ay;
  var x1 = bx;
  var y1 = by;
  if (x0 !== x1) {
    if (x0 < xMin) {
      y0 = y0 + ((y1 - y0) * (xMin - x0)) / (x1 - x0);
      x0 = xMin;
    } else if (x0 > xMax) {
      y0 = y0 + ((y1 - y0) * (xMax - x0)) / (x1 - x0);
      x0 = xMax;
    }
    if (x1 < xMin) {
      y1 = ay + ((by - ay) * (xMin - ax)) / (bx - ax);
      x1 = xMin;
    } else if (x1 > xMax) {
      y1 = ay + ((by - ay) * (xMax - ax)) / (bx - ax);
      x1 = xMax;
    }
  } else {
    if (x0 < xMin || x0 > xMax) return null;
  }
  if (Math.abs(x1 - x0) < 1e-9 && Math.abs(y1 - y0) < 1e-9) return null;
  return { ax: x0, ay: y0, bx: x1, by: y1 };
}

/**
 * Expand a polyline into triangles, clipped to plot x-range.
 */
function strokePolylineClipped(buf, points, width, rgba, xMin, xMax) {
  if (!points || points.length < 2) return;
  var hw = Math.max(0.5, width) * 0.5;
  var i;
  for (i = 0; i < points.length - 1; i++) {
    var seg = clipSegX(
      points[i].x,
      points[i].y,
      points[i + 1].x,
      points[i + 1].y,
      xMin,
      xMax
    );
    if (!seg) continue;
    var ax = seg.ax;
    var ay = seg.ay;
    var bx = seg.bx;
    var by = seg.by;
    var dx = bx - ax;
    var dy = by - ay;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) continue;
    var nx = (-dy / len) * hw;
    var ny = (dx / len) * hw;
    pushQuad(
      buf,
      ax + nx,
      ay + ny,
      ax - nx,
      ay - ny,
      bx - nx,
      by - ny,
      bx + nx,
      by + ny,
      rgba
    );
  }
}

/**
 * Area under polyline, clipped to plot x-range.
 */
function fillUnderClipped(buf, points, yBase, rgba, xMin, xMax) {
  if (!points || points.length < 2) return;
  var i;
  for (i = 0; i < points.length - 1; i++) {
    var seg = clipSegX(
      points[i].x,
      points[i].y,
      points[i + 1].x,
      points[i + 1].y,
      xMin,
      xMax
    );
    if (!seg) continue;
    pushQuad(
      buf,
      seg.ax,
      seg.ay,
      seg.bx,
      seg.by,
      seg.bx,
      yBase,
      seg.ax,
      yBase,
      rgba
    );
  }
}

/**
 * @param {object} opts
 * @returns {{ verts: Float32Array, nVerts: number, axis: object }}
 */
export function buildChartMesh(opts) {
  opts = opts || {};
  var W = opts.cssW || 800;
  var H = opts.cssH || 220;
  var padL = opts.padL != null ? opts.padL : 56;
  var padR = opts.padR != null ? opts.padR : 16;
  var padT = opts.padT != null ? opts.padT : 16;
  var padB = opts.padB != null ? opts.padB : 28;
  var t0 = opts.t0;
  var t1 = opts.t1;
  if (!(t1 > t0)) {
    t1 = t0 + 1;
  }
  var plotW = Math.max(1, W - padL - padR);
  var plotH = Math.max(1, H - padT - padB);
  var plotBottom = padT + plotH;
  var plotRight = padL + plotW;
  var xMin = padL;
  var xMax = plotRight;

  var yMin = opts.yMin;
  var yMax = opts.yMax;
  if (!isFinite(yMin) || !isFinite(yMax) || yMax <= yMin) {
    yMin = 0;
    yMax = 1;
  }

  function xAt(t) {
    return padL + (plotW * (t - t0)) / (t1 - t0);
  }
  function yAt(v) {
    return padT + plotH * (1 - (v - yMin) / (yMax - yMin));
  }
  function clampY(y) {
    if (y < padT) return padT;
    if (y > plotBottom) return plotBottom;
    return y;
  }

  var buf = [];
  var bg = parseColor(opts.bgColor || "#121820", 1);
  var plotBg = parseColor(opts.plotColor || "rgba(8,12,18,0.45)", 1);
  var grid = parseColor(opts.gridColor || "rgba(46,54,72,0.5)", 1);

  /* plot band only (gutters stay clear / masked later with solid bg) */
  pushRect(buf, padL, padT, plotW, plotH, plotBg);

  /* horizontal grid */
  var g;
  for (g = 0; g <= 4; g++) {
    var gy = padT + (plotH * g) / 4;
    var ga =
      g === 0 || g === 4
        ? grid
        : [grid[0], grid[1], grid[2], grid[3] * 0.55];
    pushRect(buf, padL, gy - 0.5, plotW, 1, ga);
  }

  /* ref lines — stay inside plot */
  var refs = opts.refLines || [];
  for (g = 0; g < refs.length; g++) {
    var rv = refs[g].value;
    if (!isFinite(rv) || rv < yMin || rv > yMax) continue;
    var ry = yAt(rv);
    var rc = parseColor(refs[g].color || "#e87a82", 0.85);
    pushRect(buf, padL, ry - 0.75, plotW, 1.5, rc);
  }

  /* live runway: very faint band from last sample → window end */
  var live = opts.liveState || null;
  if (live && live.dataEndT != null && isFinite(live.dataEndT)) {
    var de = live.dataEndT;
    if (de >= t0 && de <= t1) {
      var dx0 = Math.max(padL, Math.min(plotRight, xAt(de)));
      var runway = parseColor(
        live.receiving ? "#4ecf9a" : "#e6b84d",
        0.04
      );
      if (plotRight - dx0 > 1) {
        pushRect(buf, dx0, padT, plotRight - dx0, plotH, runway);
      }
    }
  }

  var series = opts.series || [];
  var maxPts = Math.max(64, Math.floor(plotW * 2.5));
  var s;
  var i;

  for (s = 0; s < series.length; s++) {
    var ser = series[s];
    if (!ser || ser.hidden) continue;
    var pts = ser.points || [];
    if (pts.length < 1) continue;
    if (pts.length > maxPts) pts = downsample(pts, maxPts);

    var path = [];
    for (i = 0; i < pts.length; i++) {
      var t = pts[i].t != null ? pts[i].t : parseTs(pts[i].ts);
      var yv = Number(pts[i].y != null ? pts[i].y : pts[i].value);
      if (!isFinite(t) || !isFinite(yv)) continue;
      /*
       * Do NOT clamp Y into the plot: if the scale is wrong, clamping glues
       * every sample to the top/bottom edge (looked like "data stuck at top
       * while axis says 1 bps"). X is still clipped per-segment.
       */
      path.push({ x: xAt(t), y: yAt(yv), t: t });
    }
    if (path.length < 1) continue;

    var col = parseColor(ser.color || "#6b8cff", 1);
    var fillA = ser.fillAlpha != null ? ser.fillAlpha : 0;
    if (fillA > 0 && path.length >= 2) {
      fillUnderClipped(
        buf,
        path,
        plotBottom,
        [col[0], col[1], col[2], fillA],
        xMin,
        xMax
      );
    }
    var lw = ser.width != null ? ser.width : 2.0;
    strokePolylineClipped(buf, path, lw, col, xMin, xMax);

    /* tip at series end (pen sits at live edge when following now) */
    if (ser.showTip !== false && path.length) {
      var tip = path[path.length - 1];
      if (tip.x >= xMin - 0.5 && tip.x <= xMax + 0.5) {
        var tx = Math.max(xMin, Math.min(xMax, tip.x));
        var ty = tip.y;
        var tr = 2.8;
        pushQuad(
          buf,
          tx - tr,
          ty - tr,
          tx + tr,
          ty - tr,
          tx + tr,
          ty + tr,
          tx - tr,
          ty + tr,
          col
        );
      }
    }
  }

  /* markers */
  var markers = opts.markers || [];
  for (i = 0; i < markers.length; i++) {
    var mk = markers[i];
    var mt = mk.t != null ? mk.t : parseTs(mk.ts);
    if (!isFinite(mt) || mt < t0 || mt > t1) continue;
    var mx = xAt(mt);
    if (mx < xMin || mx > xMax) continue;
    var mc = parseColor(mk.color || opts.defectColor || "#e87a82", 0.9);
    var mw = mk.kind === "destroy" ? 2 : 1.25;
    pushRect(buf, mx - mw * 0.5, padT, mw, plotH, mc);
  }

  /* latest-sample edge (where data actually ends) */
  if (live && live.dataEndT != null && isFinite(live.dataEndT)) {
    var det = live.dataEndT;
    if (det >= t0 && det <= t1) {
      var dex = xAt(det);
      if (dex >= xMin && dex <= xMax) {
        var deCol = parseColor(
          live.receiving ? "#4ecf9a" : "#e6b84d",
          0.35
        );
        pushRect(buf, dex - 0.5, padT, 1, plotH, deCol);
      }
    }
  }

  /* thin static live edge (no pulse) — pen writes at the right */
  if (live && live.live) {
    var liveCol = parseColor(
      live.receiving ? "#4ecf9a" : "#e6b84d",
      0.45
    );
    pushRect(buf, plotRight - 1.25, padT, 1.25, plotH, liveCol);
  }

  /* scrub / cursor */
  if (opts.cursorT != null && isFinite(opts.cursorT)) {
    var cx = xAt(opts.cursorT);
    if (cx >= xMin && cx <= xMax) {
      var cc = parseColor(opts.cursorColor || "#e8e2d8", 0.55);
      pushRect(buf, cx - 0.75, padT, 1.5, plotH, cc);
    }
  }

  /*
   * Hard clip: repaint gutters with solid background so any stroke bleed
   * under the Y-axis (or past the right pad) is covered.
   */
  pushRect(buf, 0, 0, padL, H, bg);
  if (padR > 0) pushRect(buf, plotRight, 0, padR + 1, H, bg);
  pushRect(buf, 0, 0, W, padT, bg);
  pushRect(buf, 0, plotBottom, W, padB + 1, bg);

  /* thin plot border so the cut is obvious */
  var border = parseColor(opts.borderColor || "rgba(46,54,72,0.9)", 0.9);
  pushRect(buf, padL, padT, 1, plotH, border);
  pushRect(buf, plotRight - 1, padT, 1, plotH, border);

  var verts = new Float32Array(buf);
  return {
    verts: verts,
    nVerts: verts.length / 6,
    axis: {
      padL: padL,
      padR: padR,
      padT: padT,
      padB: padB,
      plotW: plotW,
      plotH: plotH,
      t0: t0,
      t1: t1,
      yMin: yMin,
      yMax: yMax,
      cssW: W,
      cssH: H,
      xAt: xAt,
      yAt: yAt
    }
  };
}

/**
 * Compute auto y range from series point lists {y}.
 */
export function autoYRange(seriesList, opts) {
  opts = opts || {};
  var minY = Infinity;
  var maxY = -Infinity;
  var s, i, pts, v;
  for (s = 0; s < (seriesList || []).length; s++) {
    pts = seriesList[s].points || [];
    for (i = 0; i < pts.length; i++) {
      v = Number(pts[i].y != null ? pts[i].y : pts[i].value);
      if (!isFinite(v)) continue;
      if (v < minY) minY = v;
      if (v > maxY) maxY = v;
    }
  }
  if (!isFinite(minY) || !isFinite(maxY)) {
    minY = 0;
    maxY = 1;
  }
  if (opts.fixed) {
    return {
      yMin: opts.yMin != null ? opts.yMin : 0,
      yMax: opts.yMax != null ? opts.yMax : 100
    };
  }
  if (opts.yMin != null) minY = opts.yMin;
  if (opts.yMax != null) maxY = opts.yMax;
  if (maxY <= minY) maxY = minY + 1;
  var padAmt = (maxY - minY) * 0.08;
  if (opts.yMin == null) minY -= padAmt;
  if (opts.yMax == null) maxY += padAmt * 1.4;
  if (opts.includeZero && minY > 0) minY = 0;
  return { yMin: minY, yMax: maxY };
}
