/**
 * Graphs workspace — WebGPU time-series panels, shared time, catalog picker.
 */
import { createChartView } from "/charts/chart_view.js";
import { fmtDuration, fmtLocalTs } from "/charts/ts_util.js";
import { createTimeController } from "./time_controller.js";
import {
  loadLayout,
  saveLayout,
  loadRecentRouters,
  rememberRouter,
  uid,
  defaultPanels
} from "./layout_store.js";
import { GRAPH_TYPES, SOURCE_KINDS, typeById, sourceById } from "./catalog.js";
import { createPanelElement } from "./panel.js";
import { createAdapterHub } from "./series_adapters.js";

const PRESETS = [
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "2h", ms: 2 * 3600 * 1000 },
  { label: "8h", ms: 8 * 3600 * 1000 },
  { label: "24h", ms: 24 * 3600 * 1000 },
  { label: "48h", ms: 48 * 3600 * 1000 }
];

function $(id) {
  return document.getElementById(id);
}

function qs(name) {
  try {
    return new URLSearchParams(location.search).get(name) || "";
  } catch (e) {
    return "";
  }
}

function parseDeepLinkPanels(raw, routerId) {
  if (!raw) return null;
  const ids = raw.split(",").map(function (s) {
    return s.trim();
  }).filter(Boolean);
  if (!ids.length) return null;
  return ids.map(function (typeId) {
    return {
      id: uid(),
      typeId: typeId,
      source: { kind: "cpe", router_id: routerId || "" },
      collapsed: false,
      height: typeId.indexOf("host.cpu") === 0 ? 220 : 200
    };
  });
}

async function boot() {
  const Shell = window.EdgeShell;
  if (Shell && typeof Shell.requireAuth === "function") {
    const ok = await Shell.requireAuth();
    if (!ok) return;
  }

  const statusLine = $("statusLine");
  const stack = $("graphStack");
  const emptyEl = $("graphsEmpty");
  const timeLabel = $("timeLabel");
  const scrub = $("timeScrub");
  const renderChip = $("renderChip");
  const feedChip = $("feedChip");
  const filterRouter = $("filterRouter");
  const presetRow = $("timePresets");
  const LF = window.LiveFeed || null;
  const PUSH_STALE_MS = (LF && LF.FEED_STALE_MS) || 15000;

  /* recent routers into datalist */
  const dl = $("routerRecent");
  if (dl) {
    loadRecentRouters().forEach(function (r) {
      const o = document.createElement("option");
      o.value = r;
      dl.appendChild(o);
    });
  }

  const routerFromUrl = qs("router_id");
  const recentRouters = loadRecentRouters();

  const time = createTimeController({
    durationMs: 10 * 60 * 1000,
    live: true
  });

  let panels = [];
  const views = {}; /* panelId -> { view, unsub, ui } */
  let renderMode = "…";
  let saveTimer = 0;

  const saved = loadLayout();
  const deep = parseDeepLinkPanels(
    qs("panels"),
    routerFromUrl || (filterRouter && filterRouter.value) || ""
  );
  if (deep) {
    panels = deep;
  } else if (saved && saved.panels && saved.panels.length) {
    panels = saved.panels;
    if (saved.durationMs) time.setDuration(saved.durationMs, true);
  } else {
    panels = defaultPanels(routerFromUrl || "");
  }

  /* apply default router to empty / cpe sources */
  function applyGlobalRouter(rid) {
    const r = (rid || "").trim();
    panels.forEach(function (p) {
      if (!p.source) p.source = { kind: "cpe" };
      if (
        p.source.kind === "cpe" ||
        p.source.kind === "band" ||
        p.source.kind === "radio" ||
        !p.source.router_id
      ) {
        if (!p.source.router_id || p.source.kind === "cpe") {
          p.source.router_id = r;
        }
      }
    });
  }

  /**
   * Pick initial CPE: EdgeContext → URL → toolbar → panel → recent.
   * Location-first shell context is the primary source of truth.
   */
  function resolveInitialRouter() {
    const fromCtx =
      (window.EdgeContext &&
        typeof window.EdgeContext.routerId === "function" &&
        window.EdgeContext.routerId()) ||
      "";
    if (fromCtx) return String(fromCtx).trim();
    const fromFilter =
      (filterRouter && filterRouter.value && filterRouter.value.trim()) || "";
    if (routerFromUrl) return routerFromUrl.trim();
    if (fromFilter) return fromFilter;
    for (let i = 0; i < panels.length; i++) {
      const r =
        panels[i].source && panels[i].source.router_id
          ? String(panels[i].source.router_id).trim()
          : "";
      if (r) return r;
    }
    if (recentRouters && recentRouters[0]) return String(recentRouters[0]).trim();
    return "";
  }

  function ensureContextBanner() {
    let el = $("contextEmpty");
    if (el) return el;
    const host = document.getElementById("edge-shell-content") || document.body;
    el = document.createElement("div");
    el.id = "contextEmpty";
    el.className = "context-empty-banner";
    el.innerHTML =
      "Select a <strong>location</strong> in the top bar (or open " +
      '<a href="/devices/">Locations &amp; devices</a>) before live series can load. ' +
      "Lab CPE is often <code>router</code>.";
    host.insertBefore(el, host.firstChild);
    return el;
  }

  function paintContextEmpty(rid) {
    const ban = ensureContextBanner();
    if (!ban) return;
    if (rid) ban.classList.remove("is-visible");
    else ban.classList.add("is-visible");
  }

  const initialRouter = resolveInitialRouter();
  if (filterRouter) {
    if (initialRouter && !filterRouter.value.trim()) {
      filterRouter.value = initialRouter;
    } else if (routerFromUrl) {
      filterRouter.value = routerFromUrl;
    }
  }
  if (initialRouter) {
    applyGlobalRouter(initialRouter);
  }
  paintContextEmpty(initialRouter);
  /* Mirror into EdgeContext when we resolved from URL/recent without context */
  if (
    initialRouter &&
    window.EdgeContext &&
    typeof window.EdgeContext.setRouter === "function" &&
    !window.EdgeContext.routerId()
  ) {
    window.EdgeContext.setRouter(initialRouter, {
      source: routerFromUrl ? "url" : "user",
      silent: true
    });
  }

  const mux = window.EdgeMux;
  const hub = createAdapterHub({ mux: mux });
  if (initialRouter && typeof hub.setRouter === "function") {
    hub.setRouter(initialRouter);
  }
  if (mux) {
    mux.onStatus(function (st) {
      if (statusLine) {
        statusLine.textContent =
          st === "open"
            ? "Live" +
              (hub.getRouter && hub.getRouter()
                ? " · " + hub.getRouter()
                : "")
            : st === "connecting"
              ? "Connecting…"
              : "WS " + st;
      }
      /* Re-watch + REST on every open — server drops watches on disconnect.
       * (Same pattern as /host/; without this graphs stay tip-only.) */
      if (st === "open" && hub && typeof hub.resubscribe === "function") {
        hub.resubscribe();
      }
    });
    mux.connect();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveLayout({
        durationMs: time.get().durationMs,
        panels: panels
      });
    }, 300);
  }

  function feedReceiving(s) {
    /* Prefer WS push age; fall back to sample age if no push tracked yet. */
    const push = hub.latestPush();
    if (LF && typeof LF.isPushStale === "function") {
      if (push > 0) return !LF.isPushStale(push, Date.now(), PUSH_STALE_MS);
    }
    if (push > 0) {
      return Date.now() - push < PUSH_STALE_MS;
    }
    if (s.dataEndMs > 0) {
      return Date.now() - s.dataEndMs < PUSH_STALE_MS;
    }
    return false;
  }

  function fmtAge(ms) {
    if (LF && typeof LF.fmtAge === "function") return LF.fmtAge(ms);
    if (!isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return "<1s";
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    return Math.round(ms / 60000) + "m";
  }

  function updateTimeChrome() {
    const s = time.get();
    const receiving = feedReceiving(s);
    const push = hub.latestPush();
    const ageMs =
      push > 0
        ? Date.now() - push
        : s.dataEndMs > 0
          ? Date.now() - s.dataEndMs
          : NaN;

    if (timeLabel) {
      timeLabel.textContent =
        fmtLocalTs(s.t0, "time") +
        " → " +
        fmtLocalTs(s.t1, "time") +
        " · " +
        fmtDuration(s.durationMs) +
        (s.live ? " · live edge" : " · history");
    }
    if (scrub) {
      /* map scrub: 0 = oldest in window, 1000 = live edge */
      if (s.scrubMs == null || s.live) {
        scrub.value = "1000";
      } else {
        const u = (s.scrubMs - s.t0) / Math.max(1, s.t1 - s.t0);
        scrub.value = String(Math.round(Math.max(0, Math.min(1, u)) * 1000));
      }
    }
    if (presetRow) {
      const buttons = presetRow.querySelectorAll("button[data-ms]");
      buttons.forEach(function (btn) {
        const ms = Number(btn.getAttribute("data-ms"));
        btn.classList.toggle(
          "active",
          Math.abs(ms - s.durationMs) / ms < 0.08
        );
      });
    }
    const liveBtn = $("btnLive");
    if (liveBtn) {
      liveBtn.classList.toggle("active", !!s.live);
      liveBtn.classList.toggle("receiving", !!s.live && receiving);
      liveBtn.classList.toggle("stalled", !!s.live && !receiving && push > 0);
      liveBtn.textContent = s.live
        ? receiving
          ? "● Live"
          : "○ Live"
        : "Go live";
    }
    if (feedChip) {
      feedChip.classList.remove("receiving", "stalled", "history", "waiting");
      const restErr =
        hub.getLastError && typeof hub.getLastError === "function"
          ? hub.getLastError()
          : "";
      const cpe = hub.getRouter ? hub.getRouter() : "";
      /* Shared LiveFeed chip labels (same semantics as /host/). */
      if (LF && typeof LF.feedChip === "function" && !restErr) {
        const chip = LF.feedChip({
          lastPushMs: push,
          dataEndMs: s.dataEndMs,
          sampleCount: 0,
          routerId: cpe,
          live: s.live,
          requireRouter: true
        });
        const kind =
          chip.kind === "receiving"
            ? "receiving"
            : chip.kind === "stalled"
              ? "stalled"
              : chip.kind === "waiting"
                ? "waiting"
                : "history";
        feedChip.className = "feed-chip " + kind;
        feedChip.innerHTML =
          '<span class="feed-dot"></span>' + chip.text;
      } else if (!push && !s.dataEndMs) {
        feedChip.className = "feed-chip waiting";
        if (!cpe) {
          feedChip.innerHTML =
            '<span class="feed-dot"></span>Select a location (top bar)…';
        } else if (restErr) {
          feedChip.className = "feed-chip stalled";
          feedChip.innerHTML =
            '<span class="feed-dot"></span>' +
            restErr.slice(0, 80);
          feedChip.title = restErr;
        } else {
          feedChip.innerHTML =
            '<span class="feed-dot"></span>Waiting for samples… · ' +
            cpe;
        }
      } else if (s.live && receiving) {
        feedChip.className = "feed-chip receiving";
        feedChip.innerHTML =
          '<span class="feed-dot"></span>Receiving · last ' +
          fmtAge(ageMs) +
          " ago";
      } else if (s.live) {
        feedChip.className = "feed-chip stalled";
        feedChip.innerHTML =
          '<span class="feed-dot"></span>Stalled · no push ' +
          fmtAge(ageMs);
      } else {
        feedChip.className = "feed-chip history";
        feedChip.innerHTML =
          '<span class="feed-dot"></span>History · data ' +
          (s.dataEndMs ? fmtLocalTs(s.dataEndMs, "time") : "—");
      }
    }
  }

  function liveStateForViews(s) {
    return {
      live: !!s.live,
      dataEndT: s.dataEndMs > 0 ? s.dataEndMs : null,
      receiving: feedReceiving(s)
    };
  }

  function applyWindowToViews() {
    const s = time.get();
    const ls = liveStateForViews(s);
    Object.keys(views).forEach(function (id) {
      const v = views[id];
      if (!v || !v.view) return;
      /* Window + live flags together so the pen always has a valid liveState. */
      v.view.setWindow({ t0: s.t0, t1: s.t1 });
      v.view.setLiveState(ls);
      if (s.scrubMs != null) v.view.setCursor(s.scrubMs);
    });
  }

  let lastMinutes = time.get().minutes;
  let lastDuration = time.get().durationMs;
  let lastChromeAt = 0;
  time.onChange(function (s) {
    /*
     * Live ticks fire every animation frame for smooth scroll. Throttle
     * DOM chrome (labels, feed chip) so we don't thrash layout; chart
     * windows still update every frame.
     */
    const now = Date.now();
    if (!s.live || now - lastChromeAt > 200) {
      lastChromeAt = now;
      updateTimeChrome();
    }
    applyWindowToViews();
    if (s.minutes !== lastMinutes) {
      lastMinutes = s.minutes;
      hub.setMinutes(s.minutes);
      hub.refreshAll(panels, s.minutes);
    }
    if (s.durationMs !== lastDuration) {
      lastDuration = s.durationMs;
      scheduleSave();
    }
  });

  /* presets */
  if (presetRow) {
    PRESETS.forEach(function (p) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost";
      b.textContent = p.label;
      b.setAttribute("data-ms", String(p.ms));
      b.addEventListener("click", function () {
        time.setDuration(p.ms, true);
        hub.refreshAll(panels, time.get().minutes);
      });
      presetRow.appendChild(b);
    });
  }

  $("btnLive") &&
    $("btnLive").addEventListener("click", function () {
      time.goLive();
    });

  if (scrub) {
    scrub.addEventListener("input", function () {
      const s = time.get();
      const u = Number(scrub.value) / 1000;
      if (u >= 0.995) {
        time.goLive();
      } else {
        time.setLive(false);
        time.setScrub(s.t0 + (s.t1 - s.t0) * u);
      }
    });
  }

  /* keyboard */
  window.addEventListener("keydown", function (ev) {
    if (ev.target && /input|select|textarea/i.test(ev.target.tagName)) return;
    const s = time.get();
    if (ev.key === "ArrowLeft") {
      time.panBy(-s.durationMs * 0.1);
      ev.preventDefault();
    } else if (ev.key === "ArrowRight") {
      time.panBy(s.durationMs * 0.1);
      ev.preventDefault();
    } else if (ev.key === "+" || ev.key === "=") {
      time.zoomAt(1 / 1.2, 0.5);
      ev.preventDefault();
    } else if (ev.key === "-" || ev.key === "_") {
      time.zoomAt(1.2, 0.5);
      ev.preventDefault();
    } else if (ev.key === "l" || ev.key === "L") {
      time.goLive();
    }
  });

  function onGesture(g) {
    if (g.type === "zoom") {
      time.zoomAt(g.factor, g.anchorFrac);
    } else if (g.type === "pan") {
      time.panTo(g.t0, g.t1);
    } else if (g.type === "scrub") {
      time.setLive(false);
      time.setScrub(g.t);
    } else if (g.type === "live") {
      time.goLive();
    }
  }

  async function mountPanel(panel) {
    if (!stack) return;
    const ui = createPanelElement(panel, {
      onRemove: function (p) {
        removePanel(p.id);
      },
      onToggle: async function (p) {
        scheduleSave();
        const slot = views[p.id];
        if (p.collapsed) {
          if (slot && slot.view) {
            slot.view.destroy();
            slot.view = null;
          }
          return;
        }
        if (slot && !slot.view) {
          slot.view = await createChartView(slot.ui.canvas, {
            height: p.height || 220,
            onGesture: onGesture
          });
          const s = time.get();
          slot.view.setWindow({ t0: s.t0, t1: s.t1 });
          slot.view.setLiveState(liveStateForViews(s));
        }
        hub.refreshAll([p], time.get().minutes);
      },
      onDrop: function (fromId, toId) {
        reorderPanels(fromId, toId);
      }
    });
    stack.appendChild(ui.el);

    let view = null;
    if (!panel.collapsed) {
      view = await createChartView(ui.canvas, {
        height: panel.height || 220,
        onGesture: onGesture
      });
      if (renderMode === "…" || renderMode === "canvas2d") {
        renderMode = view.mode;
        if (renderChip) {
          renderChip.textContent = view.mode === "webgpu" ? "WebGPU" : "Canvas2D";
          renderChip.classList.toggle("gpu", view.mode === "webgpu");
        }
      }
      const s = time.get();
      view.setWindow({ t0: s.t0, t1: s.t1 });
      view.setLiveState(liveStateForViews(s));
      if (panel.typeId === "host.cpu" || panel.typeId === "host.mem") {
        view.setYScale({ mode: "fixed", yMin: 0, yMax: 100, fmtY: function (v) {
          return v.toFixed(0) + "%";
        }});
      }
    }

    views[panel.id] = { view: view, unsub: null, ui: ui };

    const unsub = hub.subscribe(panel, function (bundle) {
      const slot = views[panel.id];
      if (!slot || !slot.view) return;
      const v = slot.view;
      const yh = bundle.yHints || {};
      v.setYScale({
        mode: yh.mode || "auto",
        yMin: yh.yMin,
        yMax: yh.yMax,
        fmtY: yh.fmtY,
        includeZero: yh.includeZero,
        unit: yh.unit || null
      });
      v.setSeries(bundle.series || []);
      v.setMarkers(bundle.markers || []);
      v.setRefLines(bundle.refLines || []);
      v.setEmptyMessage(
        (bundle.meta && bundle.meta.subtitle) || "No samples in this window"
      );
      slot.ui.setLegend(
        (bundle.series || []).map(function (s) {
          return { label: s.label, color: s.color };
        })
      );
      let n = 0;
      let tMin = Infinity;
      let tMax = -Infinity;
      (bundle.series || []).forEach(function (s) {
        const pts = s.points || [];
        n += pts.length;
        for (let i = 0; i < pts.length; i++) {
          const t = pts[i].t;
          if (!isFinite(t)) continue;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }
      });
      /* Adapter already builds a full subtitle (samples · source · cpe · span). */
      let meta =
        (bundle.meta && bundle.meta.subtitle) ||
        (n ? n + " pts" : "—");
      if (
        n &&
        isFinite(tMin) &&
        isFinite(tMax) &&
        tMax > tMin &&
        !(bundle.meta && bundle.meta.subtitle)
      ) {
        const spanMin = Math.round((tMax - tMin) / 60000);
        meta += spanMin >= 1 ? " · " + spanMin + "m span" : " · <1m span";
      }
      slot.ui.setMeta(meta);
    });
    views[panel.id].unsub = unsub;
  }

  function removePanel(id) {
    const v = views[id];
    if (v) {
      if (v.unsub) v.unsub();
      if (v.view) v.view.destroy();
      if (v.ui) v.ui.destroy();
      delete views[id];
    }
    hub.unsubscribe(id);
    panels = panels.filter(function (p) {
      return p.id !== id;
    });
    scheduleSave();
    syncEmpty();
  }

  function reorderPanels(fromId, toId) {
    const fromIdx = panels.findIndex(function (p) {
      return p.id === fromId;
    });
    const toIdx = panels.findIndex(function (p) {
      return p.id === toId;
    });
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const item = panels.splice(fromIdx, 1)[0];
    panels.splice(toIdx, 0, item);
    /* re-order DOM */
    if (stack) {
      panels.forEach(function (p) {
        const v = views[p.id];
        if (v && v.ui) stack.appendChild(v.ui.el);
      });
    }
    scheduleSave();
  }

  function syncEmpty() {
    if (emptyEl) emptyEl.hidden = panels.length > 0;
    if (stack) stack.hidden = panels.length === 0;
  }

  async function remountAll() {
    Object.keys(views).forEach(function (id) {
      const v = views[id];
      if (v.unsub) v.unsub();
      if (v.view) v.view.destroy();
      if (v.ui) v.ui.destroy();
      hub.unsubscribe(id);
      delete views[id];
    });
    if (stack) stack.innerHTML = "";
    syncEmpty();
    for (let i = 0; i < panels.length; i++) {
      await mountPanel(panels[i]);
    }
    hub.refreshAll(panels, time.get().minutes);
  }

  await remountAll();
  updateTimeChrome();

  hub.startPolling(function () {
    return panels;
  }, 5000);

  /* Initial watch + REST once panels are mounted */
  if (hub && typeof hub.resubscribe === "function") {
    hub.resubscribe();
  }

  /*
   * Live tick ~24 fps. Host page learned that 60 fps WebGPU rebuilds can
   * starve the WS onmessage handler so series freeze (then look like a flat
   * hold line as the window scrolls past). 24 fps still feels continuous.
   */
  let liveRaf = 0;
  let lastChromeMs = 0;
  let lastDrawTick = 0;
  let lastFeedCheck = 0;
  function liveLoop(ts) {
    liveRaf = requestAnimationFrame(liveLoop);
    if (document.hidden) return;

    if (ts - lastFeedCheck > 250) {
      lastFeedCheck = ts;
      const end = hub.latestDataEnd();
      const push = hub.latestPush();
      const feedAge = push > 0 ? Date.now() - push : 0;
      if (end) {
        time.setDataEnd(end, feedAge);
      } else if (push > 0) {
        time.setDataEnd(0, feedAge);
      }
      if (typeof hub.ensureFeed === "function") hub.ensureFeed();
    } else {
      /*
       * Also refresh dataEnd on every live tick when we already have points —
       * first REST after open can land between 250 ms polls and leave the
       * strip on wall-clock for a full quarter second (looks empty).
       */
      const endFast = hub.latestDataEnd();
      if (endFast > 0) {
        const pushFast = hub.latestPush();
        time.setDataEnd(
          endFast,
          pushFast > 0 ? Date.now() - pushFast : 0
        );
      }
    }

    if (time.get().live) {
      if (ts - lastDrawTick < 40) return; /* ~25 fps strip scroll */
      lastDrawTick = ts;
      time.tick();
    } else if (ts - lastChromeMs > 500) {
      lastChromeMs = ts;
      updateTimeChrome();
      applyWindowToViews();
    }
  }
  liveRaf = requestAnimationFrame(liveLoop);

  /* global CPE filter — writes EdgeContext so shell + other pages stay aligned */
  function applyCpeFromToolbar(opts) {
    opts = opts || {};
    const rid = (filterRouter && filterRouter.value.trim()) || "";
    if (rid) rememberRouter(rid);
    if (
      !opts.fromContext &&
      window.EdgeContext &&
      typeof window.EdgeContext.setRouter === "function"
    ) {
      window.EdgeContext.setRouter(rid, { source: "user", skipUrl: false });
    }
    applyGlobalRouter(rid);
    paintContextEmpty(rid);
    if (typeof hub.setRouter === "function") {
      if (rid) hub.setRouter(rid);
      else hub.setRouter("", { clear: true });
    }
    hub.ensureHostWifiWatch(rid || null, time.get().minutes, {
      clear: !rid
    });
    if (typeof hub.resubscribe === "function") hub.resubscribe();
    if (typeof hub.ensureFeed === "function") hub.ensureFeed(true);
    hub.refreshAll(panels, time.get().minutes);
    Object.keys(views).forEach(function (id) {
      if (views[id].ui) views[id].ui.syncChrome();
    });
    if (statusLine && statusLine.textContent.indexOf("Live") === 0) {
      statusLine.textContent = rid ? "Live · " + rid : "Live · no CPE";
    }
    scheduleSave();
  }
  $("btnApplyRouter") &&
    $("btnApplyRouter").addEventListener("click", function () {
      applyCpeFromToolbar();
    });
  if (filterRouter) {
    filterRouter.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        applyCpeFromToolbar();
      }
    });
    /* Match /host/: changing the field re-subscribes when a value is present. */
    filterRouter.addEventListener("change", function () {
      if (filterRouter.value.trim()) applyCpeFromToolbar();
    });
  }
  if (window.EdgeContext && typeof window.EdgeContext.onChange === "function") {
    window.EdgeContext.onChange(function (c) {
      const rid = (c && c.routerId) || "";
      if (filterRouter && filterRouter.value !== rid) {
        filterRouter.value = rid;
      }
      applyCpeFromToolbar({ fromContext: true });
    });
  }

  /* theme */
  if (window.EdgeShell && typeof window.EdgeShell.onAuth === "function") {
    /* also observe theme attribute */
  }
  const mo = new MutationObserver(function () {
    Object.keys(views).forEach(function (id) {
      if (views[id].view) views[id].view.setTheme();
    });
  });
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });

  /* ── Add graph modal ───────────────────────────────────── */
  const backdrop = $("catalogModal");
  const typeGrid = $("typeGrid");
  const sourceRow = $("sourceRow");
  const fieldsEl = $("sourceFields");
  const stubNote = $("stubNote");
  let pickType = "host.cpu";
  let pickSource = "cpe";
  let fieldValues = {};

  function openModal() {
    if (!backdrop) return;
    backdrop.hidden = false;
    backdrop.setAttribute("aria-hidden", "false");
    fieldValues = {
      router_id: (filterRouter && filterRouter.value.trim()) || routerFromUrl || ""
    };
    renderModal();
    var cancelBtn = $("btnModalCancel");
    if (cancelBtn) {
      try {
        cancelBtn.focus();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function closeModal() {
    if (!backdrop) return;
    backdrop.hidden = true;
    backdrop.setAttribute("aria-hidden", "true");
  }

  function renderModal() {
    if (!typeGrid || !sourceRow || !fieldsEl) return;
    typeGrid.innerHTML = "";
    GRAPH_TYPES.forEach(function (t) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "graphs-type-btn" + (t.id === pickType ? " active" : "");
      b.innerHTML =
        "<strong>" +
        t.label +
        '</strong><span class="tb-desc">' +
        t.desc +
        "</span>";
      b.addEventListener("click", function () {
        pickType = t.id;
        const kinds = t.sourceKinds || ["cpe"];
        if (kinds.indexOf(pickSource) < 0) pickSource = kinds[0];
        renderModal();
      });
      typeGrid.appendChild(b);
    });

    const t = typeById(pickType);
    const allowed = (t && t.sourceKinds) || ["cpe"];
    sourceRow.innerHTML = "";
    SOURCE_KINDS.forEach(function (sk) {
      if (allowed.indexOf(sk.id) < 0 && sk.live) {
        /* still show stubs always at end — skip non-matching live kinds */
        if (sk.live) return;
      }
      if (sk.live && allowed.indexOf(sk.id) < 0) return;
      /* show stubs only when browsing host-level? always show stubs in source row for awareness */
      if (!sk.live) {
        /* append stubs after */
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className =
        "graphs-source-btn" + (sk.id === pickSource ? " active" : "");
      b.textContent = sk.label;
      b.addEventListener("click", function () {
        pickSource = sk.id;
        renderModal();
      });
      sourceRow.appendChild(b);
    });
    /* stubs */
    SOURCE_KINDS.filter(function (sk) {
      return !sk.live;
    }).forEach(function (sk) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "graphs-source-btn stub";
      b.textContent = sk.label;
      b.title = sk.stub || sk.desc;
      b.disabled = true;
      sourceRow.appendChild(b);
    });

    const sk = sourceById(pickSource);
    fieldsEl.innerHTML = "";
    if (stubNote) {
      stubNote.hidden = true;
      stubNote.textContent = "";
    }
    if (!sk || !sk.live) {
      if (stubNote) {
        stubNote.hidden = false;
        stubNote.textContent = (sk && sk.stub) || "Not available yet";
      }
      return;
    }
    (sk.fields || []).forEach(function (f) {
      const lab = document.createElement("label");
      lab.textContent = f.label;
      let input;
      if (f.options) {
        input = document.createElement("select");
        f.options.forEach(function (opt) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          input.appendChild(o);
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = f.placeholder || "";
        input.autocomplete = "off";
      }
      input.value = fieldValues[f.key] || "";
      input.addEventListener("input", function () {
        fieldValues[f.key] = input.value;
      });
      input.addEventListener("change", function () {
        fieldValues[f.key] = input.value;
      });
      lab.appendChild(input);
      fieldsEl.appendChild(lab);
    });
  }

  $("btnAddGraph") &&
    $("btnAddGraph").addEventListener("click", openModal);
  $("btnEmptyAdd") &&
    $("btnEmptyAdd").addEventListener("click", openModal);
  $("btnModalCancel") &&
    $("btnModalCancel").addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      closeModal();
    });
  $("btnModalAdd") &&
    $("btnModalAdd").addEventListener("click", async function () {
      const sk = sourceById(pickSource);
      if (!sk || !sk.live) return;
      const source = { kind: pickSource };
      (sk.fields || []).forEach(function (f) {
        source[f.key] = (fieldValues[f.key] || "").trim();
      });
      if (source.router_id) rememberRouter(source.router_id);
      const panel = {
        id: uid(),
        typeId: pickType,
        source: source,
        collapsed: false,
        height: 220
      };
      panels.push(panel);
      await mountPanel(panel);
      hub.refreshAll([panel], time.get().minutes);
      scheduleSave();
      syncEmpty();
      closeModal();
    });
  if (backdrop) {
    /* Ensure closed on first paint even if CSS fought [hidden] earlier. */
    closeModal();
    backdrop.addEventListener("click", function (ev) {
      if (ev.target === backdrop) closeModal();
    });
  }
  window.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && backdrop && !backdrop.hidden) {
      closeModal();
      ev.preventDefault();
    }
  });

  $("btnResetLayout") &&
    $("btnResetLayout").addEventListener("click", async function () {
      const rid = (filterRouter && filterRouter.value.trim()) || "";
      panels = defaultPanels(rid);
      await remountAll();
      scheduleSave();
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    boot().catch(function (e) {
      console.error(e);
    });
  });
} else {
  boot().catch(function (e) {
    console.error(e);
  });
}
