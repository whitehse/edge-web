/**
 * Location catalog for EdgeContext (location-first).
 *
 * Source of truth (v1): GET /inventory/locations.json
 * Fallback: embedded lab fixtures (same shape) if fetch fails.
 *
 * Optional live status overlay from map.dynamic state keys
 * (feature/premise/{id}) when edgehost is available.
 */
(function (global) {
  var FALLBACK = [
    {
      id: "loc-north-12",
      address: "12 North Ridge Rd",
      member: "Rivera household",
      account: "A-10428",
      region: "North ridge",
      installed: "2024-03-12",
      router_id: "cpe-lab",
      lon: -95.992,
      lat: 36.124,
      ont: {
        id: "1/1/3/12",
        model: "Calix GS4227E",
        status: "online",
        serial: "CXNK00A1B2C3",
        shelf_mac: "00:02:5d:d9:21:47",
        rx_dbm: -18.4,
        vendor: "Calix"
      },
      router: {
        router_id: "cpe-lab",
        model: "prplOS CPE",
        status: "online",
        mac: "02:1a:2b:3c:4d:5e",
        software: "cpe_agent · OpenWrt · callhome",
        wan: "GPON · DHCP",
        last_seen: "moments ago"
      }
    },
    {
      id: "loc-elm-408",
      address: "408 Elm Court",
      member: "Nguyen household",
      account: "A-10991",
      region: "Elm / town center",
      installed: "2023-11-02",
      router_id: "cpe-elm",
      lon: -95.975,
      lat: 36.131,
      ont: {
        id: "1/2/1/08",
        model: "Calix GS4220E",
        status: "degraded",
        serial: "CXNK00D4E5F6",
        shelf_mac: "00:02:5d:d9:21:47",
        rx_dbm: -26.1,
        vendor: "Calix"
      },
      router: {
        router_id: "cpe-elm",
        model: "OpenWrt CPE",
        status: "online",
        mac: "02:aa:bb:cc:dd:01",
        software: "cpe_agent · OpenWrt",
        wan: "GPON · DHCP",
        last_seen: "2 min ago"
      }
    },
    {
      id: "loc-pine-9",
      address: "9 Pine Hollow",
      member: "Okoye household",
      account: "A-11204",
      region: "Pine hollow",
      installed: "2025-01-18",
      router_id: "cpe-pine",
      lon: -96.01,
      lat: 36.118,
      ont: {
        id: "1/1/2/19",
        model: "Calix GS4227E",
        status: "offline",
        serial: "CXNK00G7H8I9",
        shelf_mac: "00:02:5d:aa:10:02",
        rx_dbm: null,
        vendor: "Calix"
      },
      router: {
        router_id: "cpe-pine",
        model: "prplOS CPE",
        status: "offline",
        mac: "02:11:22:33:44:55",
        software: "cpe_agent · OpenWrt",
        wan: "—",
        last_seen: "6 h ago"
      }
    },
    {
      id: "loc-meadow-77",
      address: "77 Meadow Lane",
      member: "Patel household",
      account: "A-10003",
      region: "Meadows",
      installed: "2022-08-30",
      router_id: "cpe-meadow",
      lon: -95.96,
      lat: 36.14,
      ont: {
        id: "1/3/1/04",
        model: "Calix GS4227E",
        status: "online",
        serial: "CXNK00J1K2L3",
        shelf_mac: "00:02:5d:aa:10:02",
        rx_dbm: -19.2,
        vendor: "Calix"
      },
      router: {
        router_id: "cpe-meadow",
        model: "prplOS CPE",
        status: "online",
        mac: "02:fe:dc:ba:98:76",
        software: "cpe_agent · OpenWrt",
        wan: "GPON · DHCP",
        last_seen: "moments ago"
      }
    }
  ];

  var LOCATIONS = FALLBACK.slice();
  var source = "fallback";
  var listeners = [];
  var readyPromise = null;

  function normalizeList(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(function (x) {
        return x && x.id;
      })
      .map(function (loc) {
        var o = Object.assign({}, loc);
        if (!o.router_id && o.router && o.router.router_id) {
          o.router_id = o.router.router_id;
        }
        if (o.router && !o.router.router_id && o.router_id) {
          o.router = Object.assign({}, o.router, { router_id: o.router_id });
        }
        return o;
      });
  }

  function setLocations(list, src) {
    LOCATIONS = normalizeList(list);
    if (!LOCATIONS.length) {
      LOCATIONS = FALLBACK.slice();
      source = "fallback";
    } else {
      source = src || "remote";
    }
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](LOCATIONS.slice(), source);
      } catch (e) {
        console.error("EdgeContextCatalog listener", e);
      }
    }
    try {
      global.dispatchEvent(
        new CustomEvent("edgecatalog:change", {
          detail: { locations: LOCATIONS.slice(), source: source }
        })
      );
    } catch (e) {
      /* ignore */
    }
  }

  function all() {
    return LOCATIONS.slice();
  }

  function get(id) {
    if (!id) return null;
    for (var i = 0; i < LOCATIONS.length; i++) {
      if (LOCATIONS[i].id === id) return LOCATIONS[i];
    }
    return null;
  }

  function byRouterId(rid) {
    if (!rid) return null;
    var r = String(rid).trim();
    for (var i = 0; i < LOCATIONS.length; i++) {
      var loc = LOCATIONS[i];
      if (loc.router_id === r) return loc;
      if (loc.router && loc.router.router_id === r) return loc;
    }
    return null;
  }

  function optionsHtml(selectedId) {
    var html = '<option value="">— Select location —</option>';
    for (var i = 0; i < LOCATIONS.length; i++) {
      var loc = LOCATIONS[i];
      var sel = loc.id === selectedId ? " selected" : "";
      html +=
        '<option value="' +
        escapeAttr(loc.id) +
        '"' +
        sel +
        ">" +
        escapeHtml(loc.address) +
        " · " +
        escapeHtml(loc.router_id || "") +
        "</option>";
    }
    return html;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  /**
   * Load inventory JSON. Safe to call multiple times (single-flight).
   * @returns {Promise<{locations, source}>}
   */
  function reload() {
    readyPromise = fetch("/inventory/locations.json", {
      credentials: "same-origin",
      cache: "no-cache"
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        var list = j && Array.isArray(j.locations) ? j.locations : j;
        if (!Array.isArray(list)) throw new Error("bad inventory shape");
        setLocations(list, "inventory");
        return { locations: all(), source: source };
      })
      .catch(function (err) {
        console.warn("EdgeContextCatalog: inventory fetch failed", err);
        if (!LOCATIONS.length) setLocations(FALLBACK, "fallback");
        return { locations: all(), source: source, error: String(err) };
      });
    return readyPromise;
  }

  function ready() {
    return readyPromise || reload();
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) {
        return f !== fn;
      });
    };
  }

  function getSource() {
    return source;
  }

  /**
   * Publish premise points into map.dynamic so the status map can paint them
   * over WS STATE_CHANGED (and REST readers).
   */
  function publishToMapDynamic(opts) {
    opts = opts || {};
    var put =
      opts.put ||
      function (url, body) {
        return fetch(url, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      };
    var locs = all();
    var jobs = [];
    for (var i = 0; i < locs.length; i++) {
      (function (loc) {
        if (loc.lon == null || loc.lat == null) return;
        var status = "unknown";
        if (loc.ont && loc.ont.status) status = loc.ont.status;
        if (status === "online") status = "ok";
        if (status === "offline") status = "down";
        var key = "feature/premise/" + loc.id;
        var value = {
          id: loc.id,
          class: "premise",
          status: status,
          label: loc.address,
          router_id: loc.router_id || null,
          ont_id: loc.ont && loc.ont.id ? loc.ont.id : null,
          lon: Number(loc.lon),
          lat: Number(loc.lat),
          geom: {
            type: "Point",
            coordinates: [Number(loc.lon), Number(loc.lat)]
          },
          updated_at: new Date().toISOString(),
          source: "edge-web.inventory"
        };
        jobs.push(
          put("/api/v1/state/map.dynamic/" + key, value).catch(function () {
            /* open mode / offline */
          })
        );
      })(locs[i]);
    }
    return Promise.all(jobs);
  }

  /**
   * Highlight selected premise (status=degraded ring color via dynamic feed).
   */
  function publishFocus(loc, opts) {
    opts = opts || {};
    if (!loc || loc.lon == null || loc.lat == null) {
      return Promise.resolve(null);
    }
    var put =
      opts.put ||
      function (url, body) {
        return fetch(url, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      };
    var key = "feature/focus/selected";
    var value = {
      id: "focus-" + loc.id,
      class: "focus",
      status: "degraded",
      label: loc.address || loc.id,
      location_id: loc.id,
      router_id: loc.router_id || null,
      lon: Number(loc.lon),
      lat: Number(loc.lat),
      geom: {
        type: "Point",
        coordinates: [Number(loc.lon), Number(loc.lat)]
      },
      updated_at: new Date().toISOString(),
      source: "edge-web.context"
    };
    var path =
      "/api/v1/state/map.dynamic/feature/focus/selected";
    return put(path, value);
  }

  global.EdgeContextCatalog = {
    all: all,
    get: get,
    byRouterId: byRouterId,
    optionsHtml: optionsHtml,
    reload: reload,
    ready: ready,
    onChange: onChange,
    getSource: getSource,
    publishToMapDynamic: publishToMapDynamic,
    publishFocus: publishFocus,
    INVENTORY_URL: "/inventory/locations.json"
  };

  /* Kick off load as soon as the script runs */
  reload();
})(typeof window !== "undefined" ? window : globalThis);
