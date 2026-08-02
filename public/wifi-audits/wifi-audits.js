(function () {
  function $(id) { return document.getElementById(id); }

  var viewMode = "auto"; /* auto | geo | relative */

  function rssiColor(dbm) {
    if (dbm == null || isNaN(dbm)) return "#64748b";
    if (dbm >= -50) return "#22c55e";
    if (dbm >= -60) return "#84cc16";
    if (dbm >= -70) return "#eab308";
    if (dbm >= -80) return "#f97316";
    return "#ef4444";
  }

  function floorColor(delta) {
    if (delta == null || isNaN(delta)) return null;
    if (delta >= 1.2) return "#a78bfa"; /* up */
    if (delta >= 0.4) return "#818cf8";
    if (delta <= -1.2) return "#f472b6"; /* down */
    if (delta <= -0.4) return "#fb7185";
    return "#94a3b8";
  }

  function floorTag(delta) {
    if (delta == null || isNaN(delta)) return null;
    var s = (delta >= 0 ? "+" : "") + delta.toFixed(1) + "m";
    if (delta >= 2.2) return "↑↑ " + s;
    if (delta >= 0.5) return "↑ " + s;
    if (delta <= -2.2) return "↓↓ " + s;
    if (delta <= -0.5) return "↓ " + s;
    return "· " + s;
  }

  function pickRssi(props) {
    if (!props) return null;
    if (props.cpe_rssi_dbm != null) return props.cpe_rssi_dbm;
    if (props.client_rssi_dbm != null) return props.client_rssi_dbm;
    if (props.rssi_dbm != null) return props.rssi_dbm;
    return null;
  }

  function hasRel(props) {
    return props && (props.x_m != null || props.y_m != null) &&
      (Number(props.x_m) !== 0 || Number(props.y_m) !== 0 ||
       props.source === "walk_pdr");
  }

  /** Compass degrees (0=N, CW) → canvas delta (y up on screen is -dy). */
  function headingArrow(ctx, x, y, headingDeg, len, color) {
    if (headingDeg == null || isNaN(headingDeg)) return;
    var rad = (headingDeg * Math.PI) / 180;
    /* east = +x, north = -y on canvas when lat maps upward */
    var dx = Math.sin(rad) * len;
    var dy = -Math.cos(rad) * len;
    var ex = x + dx;
    var ey = y + dy;
    ctx.strokeStyle = color || "#38bdf8";
    ctx.fillStyle = color || "#38bdf8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    /* arrowhead */
    var ah = 7;
    var ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4));
    ctx.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  function drawHeatmap(fc) {
    var canvas = $("heatCanvas");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle =
      getComputedStyle(document.documentElement).getPropertyValue("--surface-2") ||
      "#12141a";
    if (!ctx.fillStyle || ctx.fillStyle === "") ctx.fillStyle = "#12141a";
    ctx.fillRect(0, 0, w, h);

    var feats = (fc && fc.features) || [];
    var pts = [];
    var anyRel = false;
    feats.forEach(function (f) {
      if (!f || !f.geometry || f.geometry.type !== "Point") return;
      var c = f.geometry.coordinates || [];
      if (c.length < 2) return;
      var props = f.properties || {};
      if (hasRel(props)) anyRel = true;
      pts.push({
        lon: +c[0],
        lat: +c[1],
        x_m: props.x_m != null ? +props.x_m : null,
        y_m: props.y_m != null ? +props.y_m : null,
        props: props,
        rssi: pickRssi(props),
        heading: props.heading_deg != null ? +props.heading_deg : null,
        floor: props.floor_delta_m != null ? +props.floor_delta_m : null,
        steps: props.step_count != null ? +props.step_count : null
      });
    });
    if (!pts.length) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "14px system-ui,sans-serif";
      ctx.fillText("No path points", 20, 40);
      return { mode: "empty", n: 0 };
    }

    var useRel =
      viewMode === "relative" ||
      (viewMode === "auto" && anyRel) ||
      (viewMode === "geo" ? false : anyRel && viewMode !== "geo");
    if (viewMode === "geo") useRel = false;
    if (viewMode === "relative") useRel = true;

    /* Project into canvas space */
    var u0, u1, v0, v1;
    pts.forEach(function (p, i) {
      if (useRel && (p.x_m != null || p.y_m != null)) {
        p.u = p.x_m != null ? p.x_m : 0;
        p.v = p.y_m != null ? p.y_m : 0;
      } else {
        p.u = p.lon;
        p.v = p.lat;
      }
      if (i === 0) {
        u0 = u1 = p.u;
        v0 = v1 = p.v;
      } else {
        if (p.u < u0) u0 = p.u;
        if (p.u > u1) u1 = p.u;
        if (p.v < v0) v0 = p.v;
        if (p.v > v1) v1 = p.v;
      }
    });
    var pad = 36;
    var du = u1 - u0 || (useRel ? 2 : 0.0001);
    var dv = v1 - v0 || (useRel ? 2 : 0.0001);
    /* keep aspect roughly square in metres when relative */
    if (useRel) {
      var span = Math.max(du, dv, 1);
      var midU = (u0 + u1) / 2;
      var midV = (v0 + v1) / 2;
      u0 = midU - span / 2;
      u1 = midU + span / 2;
      v0 = midV - span / 2;
      v1 = midV + span / 2;
      du = u1 - u0;
      dv = v1 - v0;
    }
    function xy(p) {
      var x = pad + ((p.u - u0) / du) * (w - pad * 2);
      /* v increases north / +y_m → up on canvas */
      var y = h - pad - ((p.v - v0) / dv) * (h - pad * 2);
      return { x: x, y: y };
    }

    /* North indicator */
    ctx.fillStyle = "#64748b";
    ctx.font = "11px system-ui,sans-serif";
    ctx.fillText(useRel ? "Relative plan (x_m east, y_m north)" : "Geographic", pad, 16);
    ctx.strokeStyle = "#94a3b8";
    ctx.fillStyle = "#94a3b8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w - 28, 28);
    ctx.lineTo(w - 28, 12);
    ctx.stroke();
    headingArrow(ctx, w - 28, 28, 0, 14, "#94a3b8");
    ctx.fillText("N", w - 34, 10);

    /* path polyline with soft glow */
    ctx.strokeStyle = "rgba(56,189,248,0.25)";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var q = xy(p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();
    ctx.strokeStyle = "rgba(148,163,184,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var q = xy(p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();

    var withHeading = 0;
    var withFloor = 0;
    pts.forEach(function (p, i) {
      var q = xy(p);
      var col = rssiColor(p.rssi);
      var r = p.rssi != null ? 8 : 5;

      /* floor ring */
      var fc2 = floorColor(p.floor);
      if (fc2) {
        withFloor++;
        ctx.beginPath();
        ctx.strokeStyle = fc2;
        ctx.lineWidth = 2.5;
        ctx.arc(q.x, q.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.fillStyle = col;
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();

      /* heading arrow from point */
      if (p.heading != null && isFinite(p.heading)) {
        withHeading++;
        headingArrow(ctx, q.x, q.y, p.heading, 16, "#7dd3fc");
      }

      var bits = [];
      if (p.props.label) bits.push(p.props.label);
      if (p.rssi != null) bits.push(p.rssi + "dBm");
      var ft = floorTag(p.floor);
      if (ft) bits.push(ft);
      if (p.heading != null && isFinite(p.heading) && i % 2 === 0) {
        bits.push(Math.round(p.heading) + "°");
      }
      if (bits.length) {
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "11px system-ui,sans-serif";
        ctx.fillText(bits.join(" · "), q.x + 10, q.y - 8);
      }
      if (i === 0) {
        ctx.fillStyle = "#38bdf8";
        ctx.font = "10px system-ui,sans-serif";
        ctx.fillText("start", q.x - 12, q.y + 18);
      }
      if (i === pts.length - 1 && pts.length > 1) {
        ctx.fillStyle = "#fbbf24";
        ctx.font = "10px system-ui,sans-serif";
        ctx.fillText("end", q.x - 8, q.y + 18);
      }
    });

    return {
      mode: useRel ? "relative" : "geo",
      n: pts.length,
      withHeading: withHeading,
      withFloor: withFloor,
      anyRel: anyRel
    };
  }

  async function load() {
    const r = await fetch("/api/v1/wifi-audits", { credentials: "same-origin" });
    const d = await r.json();
    const el = $("list");
    if (!r.ok) {
      el.textContent = "Failed: " + r.status + " " + JSON.stringify(d);
      return;
    }
    const items = (d && d.audits) || [];
    el.innerHTML = items.length
      ? items.map(function (a) {
          return (
            "<div class=\"audit-row\" data-id=\"" + a.audit_id + "\">" +
            "<code>" + a.audit_id + "</code> · " + (a.account_id || "") +
            " · " + a.sample_count + " samples · " + (a.router_id || "") +
            "</div>"
          );
        }).join("")
      : "<p class=\"hint\">No audits yet.</p>";
    el.querySelectorAll(".audit-row").forEach(function (row) {
      row.addEventListener("click", function () {
        el.querySelectorAll(".audit-row").forEach(function (x) {
          x.classList.remove("on");
        });
        row.classList.add("on");
        $("auditId").value = row.getAttribute("data-id");
        geo();
      });
    });
    if (items[0]) $("auditId").value = items[0].audit_id;
  }

  async function seed() {
    const t0 = Math.floor(Date.now() / 1000) - 40;
    /* Synthetic indoor walk with PDR + heading + floor + RSSI for UI demo */
    const body = {
      audit_id: "aud-lab-" + Date.now(),
      account_id: "A-10428",
      location_id: "loc-north-12",
      router_id: "cpe-lab",
      client_mac_hint: "aa:bb:cc:dd:ee:01",
      role: "employee",
      coord_mode: "relative",
      samples: [
        {
          seq: 0, t: t0, lat: 36.12401, lon: -95.99202,
          x_m: 0, y_m: 0, heading_deg: 20, floor_delta_m: 0, step_count: 0,
          label: "Entry", source: "walk", client_rssi_dbm: -48
        },
        {
          seq: 1, t: t0 + 8, lat: 36.12404, lon: -95.9920,
          x_m: 1.2, y_m: 3.5, heading_deg: 15, floor_delta_m: 0.1, step_count: 5,
          label: "Hall", source: "walk_pdr", client_rssi_dbm: -55
        },
        {
          seq: 2, t: t0 + 16, lat: 36.12408, lon: -95.99195,
          x_m: 4.0, y_m: 4.2, heading_deg: 95, floor_delta_m: 0.15, step_count: 11,
          label: "Kitchen", source: "walk_pdr", client_rssi_dbm: -62
        },
        {
          seq: 3, t: t0 + 24, lat: 36.12412, lon: -95.9919,
          x_m: 7.5, y_m: 3.8, heading_deg: 100, floor_delta_m: 0.2, step_count: 16,
          label: "Living", source: "walk_pdr", client_rssi_dbm: -71
        },
        {
          seq: 4, t: t0 + 32, lat: 36.12415, lon: -95.99188,
          x_m: 8.0, y_m: 0.5, heading_deg: 185, floor_delta_m: 2.8, step_count: 22,
          label: "Stairs up", source: "walk_pdr", client_rssi_dbm: -78
        },
        {
          seq: 5, t: t0 + 40, lat: 36.12418, lon: -95.99185,
          x_m: 6.2, y_m: -1.0, heading_deg: 250, floor_delta_m: 3.0, step_count: 28,
          label: "Bedroom", source: "walk_pdr", client_rssi_dbm: -84
        }
      ]
    };
    const r = await fetch("/api/v1/wifi-audits", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    $("out").textContent = JSON.stringify(d, null, 2);
    await load();
    if (d.audit_id) {
      $("auditId").value = d.audit_id;
      await geo();
    }
  }

  async function geo() {
    const id = $("auditId").value;
    if (!id) return;
    const r = await fetch(
      "/api/v1/wifi-audits/" + encodeURIComponent(id) + "/geojson",
      { credentials: "same-origin" }
    );
    const text = await r.text();
    $("geo").textContent = text;
    let fc = null;
    try {
      fc = JSON.parse(text);
    } catch (e) {
      fc = null;
    }
    if (!r.ok || !fc) {
      $("heatMeta").textContent = "Failed " + r.status;
      return;
    }
    var info = drawHeatmap(fc);
    var parts = [];
    if (info && info.mode) parts.push("view=" + info.mode);
    if (fc.rf_join) parts.push("rf_join=" + fc.rf_join);
    if (fc.rf_samples_enriched != null) {
      parts.push("enriched=" + fc.rf_samples_enriched);
    }
    var n = (fc.features || []).length;
    var withRf = (fc.features || []).filter(function (f) {
      return pickRssi(f.properties) != null;
    }).length;
    parts.push(n + " pts · " + withRf + " RSSI");
    if (info && info.withHeading) parts.push(info.withHeading + " headings");
    if (info && info.withFloor) parts.push(info.withFloor + " floor tags");
    $("heatMeta").textContent = parts.join(" · ");
  }

  async function detail() {
    const id = $("auditId").value;
    if (!id) return;
    const r = await fetch("/api/v1/wifi-audits/" + encodeURIComponent(id), {
      credentials: "same-origin"
    });
    $("geo").textContent = await r.text();
  }

  function setMode(m) {
    viewMode = m;
    document.querySelectorAll("[data-view-mode]").forEach(function (btn) {
      btn.classList.toggle("on", btn.getAttribute("data-view-mode") === m);
    });
    geo();
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (window.EdgeShell && EdgeShell.requireAuth) {
      if (!(await EdgeShell.requireAuth())) return;
    }
    $("btnSeed").addEventListener("click", seed);
    $("btnGeo").addEventListener("click", geo);
    $("btnDetail").addEventListener("click", detail);
    document.querySelectorAll("[data-view-mode]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setMode(btn.getAttribute("data-view-mode"));
      });
    });
    load();
  });
})();
