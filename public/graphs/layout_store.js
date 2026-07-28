/**
 * Persist graph workspace layout in localStorage.
 */

const KEY = "edgehost-graphs-layout-v1";
const RECENT_KEY = "edgehost-graphs-recent-routers";

export function loadLayout() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.panels)) return null;
    return j;
  } catch (e) {
    return null;
  }
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        durationMs: layout.durationMs,
        panels: layout.panels,
        savedAt: Date.now()
      })
    );
  } catch (e) {
    /* quota / private mode */
  }
}

export function loadRecentRouters() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a.filter(Boolean).slice(0, 12) : [];
  } catch (e) {
    return [];
  }
}

export function rememberRouter(routerId) {
  if (!routerId) return;
  const id = String(routerId).trim();
  if (!id) return;
  let a = loadRecentRouters().filter(function (x) {
    return x !== id;
  });
  a.unshift(id);
  a = a.slice(0, 12);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(a));
  } catch (e) {
    /* ignore */
  }
}

export function uid() {
  return (
    "p-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

/** Default panels when deep-link or empty. */
export function defaultPanels(routerId) {
  const rid = routerId || "";
  const src = { kind: "cpe", router_id: rid };
  return [
    {
      id: uid(),
      typeId: "host.cpu",
      source: Object.assign({}, src),
      collapsed: false,
      height: 220
    },
    {
      id: uid(),
      typeId: "host.mem",
      source: Object.assign({}, src),
      collapsed: false,
      height: 200
    },
    {
      id: uid(),
      typeId: "host.net",
      source: Object.assign({}, src),
      collapsed: false,
      height: 200
    },
    {
      id: uid(),
      typeId: "wifi.radio",
      source: Object.assign({}, src),
      collapsed: false,
      height: 200
    },
    {
      id: uid(),
      typeId: "flow.overlay",
      source: Object.assign({}, src),
      collapsed: false,
      height: 220
    }
  ];
}
