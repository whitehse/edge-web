(function () {
  function $(id) { return document.getElementById(id); }

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
            "<div style=\"padding:0.5rem 0;border-bottom:1px solid var(--border)\">" +
            "<code>" + a.audit_id + "</code> · " + (a.account_id || "") +
            " · " + a.sample_count + " samples · " + (a.router_id || "") +
            "</div>"
          );
        }).join("")
      : "<p class=\"hint\">No audits yet.</p>";
    if (items[0]) $("auditId").value = items[0].audit_id;
  }

  async function seed() {
    const body = {
      audit_id: "aud-lab-" + Date.now(),
      account_id: "A-10428",
      location_id: "loc-north-12",
      router_id: "cpe-lab",
      role: "employee",
      coord_mode: "gps",
      samples: [
        { seq: 0, lat: 36.12401, lon: -95.99202, label: "Living room", source: "walk" },
        { seq: 1, lat: 36.12405, lon: -95.9921, label: "Kitchen", source: "walk", client_rssi_dbm: -62 },
        { seq: 2, lat: 36.1241, lon: -95.9922, label: "Bedroom", source: "walk" }
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
  }

  async function geo() {
    const id = $("auditId").value;
    const r = await fetch("/api/v1/wifi-audits/" + encodeURIComponent(id) + "/geojson", {
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
    load();
  });
})();
