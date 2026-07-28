/**
 * Auth gate for /map/, default live map.dynamic feed, then libwebmap main.js.
 *
 * Live feed: ?feed=ws(s)://<host>/api/v1/stream?topics=state
 *   (set automatically when feed is omitted)
 * Inventory premises → PUT map.dynamic feature/premise/* + focus highlight.
 * EdgeContext selection updates the focus marker.
 *
 * Expects run-status-map*.sh to link:
 *   map/main.js, display/, basemap/, fiber_data/, webmap.wasm, …
 */

async function fetchJson(url, opts) {
  const r = await fetch(url, { credentials: "same-origin", ...opts });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { ok: r.ok, status: r.status, text, json };
}

function $(id) {
  return document.getElementById(id);
}

function setGateMsg(msg) {
  const el = $("gateOut");
  if (el) el.textContent = msg;
}

function setVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle("hidden", !visible);
}

/**
 * Default dynamic feed to edgehost STATE_CHANGED stream (libwebmap P4.9).
 * Preserve explicit ?feed=0 / fixture / custom ws URLs.
 */
function ensureLiveFeedQuery() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has("feed")) return u.searchParams.get("feed");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl =
      proto + "//" + location.host + "/api/v1/stream?topics=state";
    u.searchParams.set("feed", wsUrl);
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    return wsUrl;
  } catch (e) {
    return null;
  }
}

async function checkSession() {
  const r = await fetchJson("/auth/me");
  return r.ok ? r.json || { sub: "operator" } : null;
}

function paintMapContext(c) {
  const el = $("mapContext");
  if (!el) return;
  c = c || (window.EdgeContext && EdgeContext.get && EdgeContext.get()) || {};
  if (c.label || c.routerId || c.locationId) {
    el.hidden = false;
    el.textContent =
      (c.label || c.locationId || "CPE") +
      (c.routerId ? " · " + c.routerId : "");
  } else {
    el.hidden = true;
    el.textContent = "";
  }
  const graphs = $("mapLinkGraphs");
  const host = $("mapLinkHost");
  const devices = $("mapLinkDevices");
  if (window.EdgeContext && EdgeContext.hrefWithContext) {
    if (graphs) graphs.href = EdgeContext.hrefWithContext("/graphs/");
    if (host) host.href = EdgeContext.hrefWithContext("/host/");
    if (devices) {
      devices.href = c.locationId
        ? EdgeContext.hrefWithContext("/devices/", { id: c.locationId })
        : "/devices/";
    }
  }
}

async function putState(path, body) {
  return fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

/**
 * Seed map.dynamic with inventory premises + optional focus for EdgeContext.
 */
async function seedMapDynamic() {
  const Cat = window.EdgeContextCatalog;
  if (!Cat) return { ok: false, reason: "no catalog" };
  try {
    await Cat.ready();
  } catch (e) {
    /* fallback already in catalog */
  }
  let published = 0;
  try {
    if (typeof Cat.publishToMapDynamic === "function") {
      await Cat.publishToMapDynamic({ put: putState });
      published = Cat.all().filter(function (l) {
        return l.lon != null && l.lat != null;
      }).length;
    }
  } catch (e) {
    console.warn("map seed premises failed", e);
  }
  const c = window.EdgeContext && EdgeContext.get ? EdgeContext.get() : null;
  if (c && c.locationId && Cat.get) {
    const loc = Cat.get(c.locationId);
    if (loc && typeof Cat.publishFocus === "function") {
      try {
        await Cat.publishFocus(loc, { put: putState });
      } catch (e) {
        /* ignore */
      }
    }
  }
  return { ok: true, published: published };
}

function wireContextToMap() {
  const Cat = window.EdgeContextCatalog;
  const EC = window.EdgeContext;
  if (EC && typeof EC.onChange === "function") {
    EC.onChange(function (c) {
      paintMapContext(c);
      if (!Cat || !c || !c.locationId) return;
      const loc = Cat.get(c.locationId);
      if (loc && typeof Cat.publishFocus === "function") {
        Cat.publishFocus(loc, { put: putState }).catch(function () {});
      }
    });
  }
  if (Cat && typeof Cat.onChange === "function") {
    Cat.onChange(function () {
      seedMapDynamic().catch(function () {});
    });
  }
  paintMapContext(EC && EC.get ? EC.get() : null);
}

function revealMap(user) {
  setVisible($("auth-gate"), false);
  setVisible($("mapTopbar"), true);
  setVisible($("wrap"), true);
  const mu = $("mapUser");
  if (mu && user) {
    const roles = Array.isArray(user.roles) ? user.roles.join(", ") : "";
    mu.textContent =
      " · " + (user.sub || "user") + (roles ? " (" + roles + ")" : "");
  }
  paintMapContext();
}

function assetsReady() {
  return fetch("./main.js", { method: "GET", credentials: "same-origin" }).then(
    (r) => r.ok
  );
}

async function startMap() {
  const status = $("status");
  if (status) status.textContent = "Checking map assets…";

  const ready = await assetsReady().catch(() => false);
  if (!ready) {
    if (status) {
      status.innerHTML =
        '<span style="color:#f07178">Map assets missing.</span> ' +
        "From the edgehost repo run <code>./scripts/run-status-map.sh</code> " +
        "(links libwebmap demo basemap / fiber_data / display / webmap.wasm).";
    }
    const log = $("log");
    if (log) {
      log.textContent +=
        "missing map/main.js — run scripts/run-status-map.sh\n";
    }
    return;
  }

  /* Seed premises into map.dynamic before WS consumers attach (best-effort). */
  if (status) status.textContent = "Seeding inventory on map.dynamic…";
  const seed = await seedMapDynamic();
  if (status && seed && seed.published) {
    status.textContent =
      "Published " + seed.published + " premises · loading WebGPU…";
  } else if (status) {
    status.textContent = "Loading WebGPU map host…";
  }

  await import("./main.js");
}

async function enterMap(user) {
  revealMap(user);
  wireContextToMap();
  try {
    await startMap();
  } catch (e) {
    setGateMsg("map load error: " + e);
    console.error(e);
  }
}

async function boot() {
  /* Init shared context before feed rewrite (URL may already have location). */
  if (window.EdgeContext && typeof EdgeContext.init === "function") {
    EdgeContext.init({ silent: true });
  }
  if (window.EdgeContextCatalog && typeof EdgeContextCatalog.ready === "function") {
    await EdgeContextCatalog.ready().catch(function () {});
  }

  const feed = ensureLiveFeedQuery();
  const logPre = $("log");
  if (logPre && feed) {
    logPre.textContent += "dynamic feed → " + feed + "\n";
  }

  let user = await checkSession();
  if (!user) {
    location.replace("/?next=" + encodeURIComponent("/map/" + location.search));
    return;
  }
  await enterMap(user);
}

boot().catch((e) => {
  setGateMsg("boot error: " + e);
  console.error(e);
});
