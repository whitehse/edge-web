(function () {
  function $(id) { return document.getElementById(id); }

  function rssiColor(dbm) {
    if (dbm == null || isNaN(dbm)) return "#64748b";
    if (dbm >= -50) return "#22c55e";
    if (dbm >= -60) return "#84cc16";
    if (dbm >= -70) return "#eab308";
    if (dbm >= -80) return "#f97316";
    return "#ef4444";
  }

  function pickRssi(props) {
    if (!props) return null;
    if (props.cpe_rssi_dbm != null) return props.cpe_rssi_dbm;
    if (props.client_rssi_dbm != null) return props.client_rssi_dbm;
    if (props.rssi_dbm != null) return props.rssi_dbm;
    return null;
  }

  function drawHeatmap(fc) {
    var canvas = $("heatCanvas");
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--surface-2") || "#12141a";
    if (!ctx.fillStyle || ctx.fillStyle === "") ctx.fillStyle = "#12141a";
    ctx.fillRect(0, 0, w, h);

    var feats = (fc && fc.features) || [];
    var pts = [];
    feats.forEach(function (f) {
      if (!f || !f.geometry || f.geometry.type !== "Point") return;
      var c = f.geometry.coordinates || [];
      if (c.length < 2) return;
      pts.push({
        lon: +c[0],
        lat: +c[1],
        props: f.properties || {},
        rssi: pickRssi(f.properties)
      });
    });
    if (!pts.length) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "14px system-ui,sans-serif";
      ctx.fillText("No path points", 20, 40);
      return;
    }

    var minLon = pts[0].lon, maxLon = pts[0].lon, minLat = pts[0].lat, maxLat = pts[0].lat;
    pts.forEach(function (p) {
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    });
    var pad = 28;
    var dLon = maxLon - minLon || 0.0001;
    var dLat = maxLat - minLat || 0.0001;
    /* square-ish aspect */
    function xy(p) {
      var x = pad + ((p.lon - minLon) / dLon) * (w - pad * 2);
      var y = h - pad - ((p.lat - minLat) / dLat) * (h - pad * 2);
      return { x: x, y: y };
    }

    /* path polyline */
    ctx.strokeStyle = "rgba(148,163,184,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(function (p, i) {
      var q = xy(p);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    });
    ctx.stroke();

    pts.forEach(function (p, i) {
      var q = xy(p);
      var col = rssiColor(p.rssi);
      ctx.beginPath();
      ctx.fillStyle = col;
      ctx.arc(q.x, q.y, p.rssi != null ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
      var label = (p.props.label || "") + (p.rssi != null ? " " + p.rssi + "dBm" : "");
      if (label) {
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "11px system-ui,sans-serif";
        ctx.fillText(label, q.x + 9, q.y - 6);
      }
      if (i === 0) {
        ctx.fillStyle = "#38bdf8";
        ctx.font = "10px system-ui,sans-serif";
        ctx.fillText("start", q.x - 10, q.y + 18);
      }
    });
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
        el.querySelectorAll(".audit-row").forEach(function (x) { x.classList.remove("on"); });
        row.classList.add("on");
        $("auditId").value = row.getAttribute("data-id");
        geo();
      });
    });
    if (items[0]) $("auditId").value = items[0].audit_id;
  }

  async function seed() {
    const t0 = Math.floor(Date.now() / 1000) - 30;
    const body = {
      audit_id: "aud-lab-" + Date.now(),
      account_id: "A-10428",
      location_id: "loc-north-12",
      router_id: "cpe-lab",
      client_mac_hint: "aa:bb:cc:dd:ee:01",
      role: "employee",
      coord_mode: "gps",
      samples: [
        { seq: 0, t: t0, lat: 36.12401, lon: -95.99202, label: "Living room", source: "walk", client_rssi_dbm: -48 },
        { seq: 1, t: t0 + 10, lat: 36.12405, lon: -95.9921, label: "Kitchen", source: "walk", client_rssi_dbm: -62 },
        { seq: 2, t: t0 + 20, lat: 36.1241, lon: -95.9922, label: "Hall", source: "walk", client_rssi_dbm: -71 },
        { seq: 3, t: t0 + 28, lat: 36.12418, lon: -95.99235, label: "Bedroom", source: "walk", client_rssi_dbm: -84 }
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
    const r = await fetch("/api/v1/wifi-audits/" + encodeURIComponent(id) + "/geojson", {
      credentials: "same-origin"
    });
    const text = await r.text();
    $("geo").textContent = text;
    let fc = null;
    try { fc = JSON.parse(text); } catch (e) { fc = null; }
    if (!r.ok || !fc) {
      $("heatMeta").textContent = "Failed " + r.status;
      return;
    }
    drawHeatmap(fc);
    var parts = [];
    if (fc.rf_join) parts.push("rf_join=" + fc.rf_join);
    if (fc.rf_samples_enriched != null) parts.push("enriched=" + fc.rf_samples_enriched);
    var n = (fc.features || []).length;
    var withRf = (fc.features || []).filter(function (f) {
      return pickRssi(f.properties) != null;
    }).length;
    parts.push(n + " points (" + withRf + " with RSSI)");
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

  document.addEventListener("DOMContentLoaded", async function () {
    if (window.EdgeShell && EdgeShell.requireAuth) {
      if (!(await EdgeShell.requireAuth())) return;
    }
    $("btnSeed").addEventListener("click", seed);
    $("btnGeo").addEventListener("click", geo);
    $("btnDetail").addEventListener("click", detail);
    load();
  });
})();
