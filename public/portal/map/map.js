/**
 * Member map — plot /api/v1/me/map self + Tap-snapped neighbors.
 */
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function project(lon, lat, bounds, w, h, pad) {
    pad = pad || 24;
    const x =
      pad +
      ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon || 1)) * (w - 2 * pad);
    const y =
      pad +
      (1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat || 1)) *
        (h - 2 * pad);
    return { x: x, y: y };
  }

  async function boot() {
    const rMe = await fetch("/auth/me", { credentials: "same-origin" });
    if (!rMe.ok) {
      location.href = "/portal/?next=/portal/map/";
      return;
    }
    const auth = await rMe.json();
    const isCustomer =
      auth.account_id ||
      (Array.isArray(auth.roles) && auth.roles.indexOf("customer") >= 0);
    if (!isCustomer) {
      location.href = "/portal/";
      return;
    }

    const r = await fetch("/api/v1/me/map", { credentials: "same-origin" });
    const d = await r.json();
    const raw = $("mapRaw");
    if (raw) raw.textContent = JSON.stringify(d, null, 2);

    const canvas = $("mapCanvas");
    if (!canvas || !d || !d.self) return;

    const pts = [{ lon: d.self.lon, lat: d.self.lat, kind: "self", status: d.self.status }];
    (d.neighbors || []).forEach(function (n) {
      pts.push({ lon: n.lon, lat: n.lat, kind: "nbr", status: n.status, id: n.id });
    });

    let minLon = pts[0].lon,
      maxLon = pts[0].lon,
      minLat = pts[0].lat,
      maxLat = pts[0].lat;
    pts.forEach(function (p) {
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
    });
    /* pad empty extent */
    if (maxLon - minLon < 0.001) {
      minLon -= 0.002;
      maxLon += 0.002;
    }
    if (maxLat - minLat < 0.001) {
      minLat -= 0.002;
      maxLat += 0.002;
    }
    const bounds = { minLon: minLon, maxLon: maxLon, minLat: minLat, maxLat: maxLat };
    const w = canvas.clientWidth || 640;
    const h = canvas.clientHeight || 420;
    canvas.innerHTML = "";
    pts.forEach(function (p) {
      const xy = project(p.lon, p.lat, bounds, w, h, 28);
      const el = document.createElement("div");
      el.className =
        "map-dot " +
        (p.kind === "self" ? "self" : p.status === "down" ? "down" : p.status === "ok" ? "ok" : "unknown");
      el.style.left = xy.x + "px";
      el.style.top = xy.y + "px";
      el.title = p.kind === "self" ? "Your service" : "Neighbor " + (p.id || "") + " · " + (p.status || "");
      canvas.appendChild(el);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
