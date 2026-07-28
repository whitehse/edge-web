/**
 * EdgeContext — location-first operator focus shared across pages.
 *
 * Shape:
 *   { v:1, locationId, routerId, ontId, label, source }
 *
 * Persistence: localStorage edge-web-context-v1
 * URL sync: ?location= & ?router_id=  (merge on load; replaceState on set)
 * Events:   window "edgecontext:change" detail = context object
 *
 * Load before shell.js. Pages may also listen and re-subscribe telemetry.
 */
(function (global) {
  var STORAGE_KEY = "edge-web-context-v1";
  var EVENT = "edgecontext:change";
  var ctx = empty();
  var listeners = [];
  var suppressUrl = false;

  function empty() {
    return {
      v: 1,
      locationId: null,
      routerId: null,
      ontId: null,
      label: null,
      source: null
    };
  }

  function clone(c) {
    return {
      v: 1,
      locationId: c.locationId || null,
      routerId: c.routerId || null,
      ontId: c.ontId || null,
      label: c.label || null,
      source: c.source || null
    };
  }

  function normalize(partial) {
    var next = clone(ctx);
    if (!partial || typeof partial !== "object") return next;
    if (Object.prototype.hasOwnProperty.call(partial, "locationId")) {
      next.locationId = partial.locationId
        ? String(partial.locationId).trim() || null
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "routerId")) {
      next.routerId = partial.routerId
        ? String(partial.routerId).trim() || null
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "ontId")) {
      next.ontId = partial.ontId
        ? String(partial.ontId).trim() || null
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "label")) {
      next.label = partial.label
        ? String(partial.label).trim() || null
        : null;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "source")) {
      next.source = partial.source || null;
    }
    return next;
  }

  function same(a, b) {
    return (
      (a.locationId || null) === (b.locationId || null) &&
      (a.routerId || null) === (b.routerId || null) &&
      (a.ontId || null) === (b.ontId || null) &&
      (a.label || null) === (b.label || null)
    );
  }

  function loadStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      return normalize({
        locationId: j.locationId,
        routerId: j.routerId,
        ontId: j.ontId,
        label: j.label,
        source: j.source || "storage"
      });
    } catch (e) {
      return null;
    }
  }

  function saveStorage(c) {
    try {
      if (!c.locationId && !c.routerId) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    } catch (e) {
      /* private mode */
    }
  }

  function readUrl() {
    try {
      var p = new URLSearchParams(location.search);
      var loc = p.get("location") || p.get("location_id") || "";
      var rid = p.get("router_id") || p.get("router") || "";
      if (!loc && !rid) return null;
      return normalize({
        locationId: loc || null,
        routerId: rid || null,
        source: "url"
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Merge context into the current URL without dropping other query keys
   * (e.g. panels=, id= on devices).
   */
  function writeUrl(c) {
    if (suppressUrl) return;
    try {
      var u = new URL(location.href);
      if (c.locationId) u.searchParams.set("location", c.locationId);
      else u.searchParams.delete("location");
      u.searchParams.delete("location_id");
      if (c.routerId) u.searchParams.set("router_id", c.routerId);
      else u.searchParams.delete("router_id");
      u.searchParams.delete("router");
      var next = u.pathname + u.search + u.hash;
      var cur = location.pathname + location.search + location.hash;
      if (next !== cur) {
        history.replaceState(null, "", next);
      }
    } catch (e) {
      /* ignore */
    }
  }

  function emit(c) {
    var detail = clone(c);
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](detail);
      } catch (e) {
        console.error("EdgeContext listener", e);
      }
    }
    try {
      global.dispatchEvent(
        new CustomEvent(EVENT, { detail: detail })
      );
    } catch (e) {
      /* IE N/A */
    }
  }

  function apply(next, opts) {
    opts = opts || {};
    next = normalize(next);
    /* If location set and catalog available, fill missing fields */
    if (
      next.locationId &&
      global.EdgeContextCatalog &&
      typeof global.EdgeContextCatalog.get === "function"
    ) {
      var loc = global.EdgeContextCatalog.get(next.locationId);
      if (loc) {
        if (!next.label) next.label = loc.address || loc.id;
        if (!next.ontId && loc.ont && loc.ont.id) next.ontId = loc.ont.id;
        if (!next.routerId && loc.router_id) next.routerId = loc.router_id;
        if (
          !next.routerId &&
          loc.router &&
          loc.router.router_id
        ) {
          next.routerId = loc.router.router_id;
        }
      }
    }
    if (!opts.force && same(ctx, next)) {
      if (!opts.skipUrl) writeUrl(ctx);
      return clone(ctx);
    }
    ctx = next;
    if (!opts.skipStorage) saveStorage(ctx);
    if (!opts.skipUrl) writeUrl(ctx);
    if (!opts.silent) emit(ctx);
    return clone(ctx);
  }

  function get() {
    return clone(ctx);
  }

  function set(partial, opts) {
    var merged = normalize(partial);
    /* set() replaces listed fields from partial onto current */
    var base = clone(ctx);
    if (Object.prototype.hasOwnProperty.call(partial || {}, "locationId")) {
      base.locationId = merged.locationId;
      /* Changing location clears CPE/ONT unless provided in same call */
      if (!Object.prototype.hasOwnProperty.call(partial, "routerId")) {
        base.routerId = null;
      }
      if (!Object.prototype.hasOwnProperty.call(partial, "ontId")) {
        base.ontId = null;
      }
      if (!Object.prototype.hasOwnProperty.call(partial, "label")) {
        base.label = null;
      }
    }
    if (Object.prototype.hasOwnProperty.call(partial || {}, "routerId")) {
      base.routerId = merged.routerId;
    }
    if (Object.prototype.hasOwnProperty.call(partial || {}, "ontId")) {
      base.ontId = merged.ontId;
    }
    if (Object.prototype.hasOwnProperty.call(partial || {}, "label")) {
      base.label = merged.label;
    }
    if (Object.prototype.hasOwnProperty.call(partial || {}, "source")) {
      base.source = merged.source;
    } else if (partial) {
      base.source = partial.source || "user";
    }
    return apply(base, opts);
  }

  function setFromLocation(loc, opts) {
    if (!loc) return clear(opts);
    return apply(
      {
        locationId: loc.id || null,
        routerId: loc.router_id || (loc.router && loc.router.router_id) || null,
        ontId: (loc.ont && loc.ont.id) || null,
        label: loc.address || loc.id || null,
        source: (opts && opts.source) || "device"
      },
      opts
    );
  }

  function setRouter(routerId, opts) {
    opts = opts || {};
    var rid = routerId ? String(routerId).trim() : "";
    var next = clone(ctx);
    next.routerId = rid || null;
    next.source = opts.source || "user";
    /* Free-typed CPE: drop location if it no longer matches catalog router */
    if (
      next.locationId &&
      global.EdgeContextCatalog &&
      typeof global.EdgeContextCatalog.get === "function"
    ) {
      var loc = global.EdgeContextCatalog.get(next.locationId);
      var locRid =
        loc &&
        (loc.router_id || (loc.router && loc.router.router_id) || "");
      if (loc && locRid && rid && locRid !== rid) {
        next.locationId = null;
        next.ontId = null;
        next.label = rid ? "CPE " + rid : null;
      } else if (!next.label && rid) {
        next.label = rid;
      }
    } else if (!next.label && rid) {
      next.label = rid;
    }
    if (!rid && !next.locationId) {
      next.label = null;
    }
    return apply(next, opts);
  }

  function clear(opts) {
    return apply(empty(), opts);
  }

  function routerId() {
    return ctx.routerId || null;
  }

  function hasFocus() {
    return !!(ctx.routerId || ctx.locationId);
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return function off() {
      listeners = listeners.filter(function (f) {
        return f !== fn;
      });
    };
  }

  function hrefWithContext(path, extra) {
    try {
      var u = new URL(path, location.origin);
      if (ctx.locationId) u.searchParams.set("location", ctx.locationId);
      if (ctx.routerId) u.searchParams.set("router_id", ctx.routerId);
      if (extra && typeof extra === "object") {
        Object.keys(extra).forEach(function (k) {
          if (extra[k] == null || extra[k] === "") u.searchParams.delete(k);
          else u.searchParams.set(k, String(extra[k]));
        });
      }
      return u.pathname + u.search + u.hash;
    } catch (e) {
      return path;
    }
  }

  /**
   * Bootstrap: URL wins over storage; then fill from catalog.
   * Call after context_catalog.js is loaded when possible.
   */
  function init(opts) {
    opts = opts || {};
    var fromUrl = readUrl();
    var fromStore = loadStorage();
    var seed = empty();
    if (fromStore) seed = fromStore;
    if (fromUrl) {
      /* URL router_id overrides stored; location from URL preferred */
      if (fromUrl.locationId) seed.locationId = fromUrl.locationId;
      if (fromUrl.routerId) seed.routerId = fromUrl.routerId;
      seed.source = "url";
    }
    suppressUrl = !!opts.skipUrl;
    apply(seed, {
      force: true,
      silent: !!opts.silent,
      skipUrl: !!opts.skipUrl
    });
    suppressUrl = false;
    if (!opts.skipUrl) writeUrl(ctx);
    return clone(ctx);
  }

  /* Auto-init after DOM scripts (catalog may load next tick) */
  function autoInit() {
    init({ silent: false });
  }

  global.EdgeContext = {
    get: get,
    set: set,
    setFromLocation: setFromLocation,
    setRouter: setRouter,
    clear: clear,
    routerId: routerId,
    hasFocus: hasFocus,
    onChange: onChange,
    hrefWithContext: hrefWithContext,
    init: init,
    STORAGE_KEY: STORAGE_KEY,
    EVENT: EVENT
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      /* Defer so context_catalog.js can define EdgeContextCatalog first */
      setTimeout(autoInit, 0);
    });
  } else {
    setTimeout(autoInit, 0);
  }
})(typeof window !== "undefined" ? window : globalThis);
