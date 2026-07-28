/**
 * Static location catalog for lab / redesign slice 1.
 * Each premise has a telemetry router_id (ClickHouse / WS filter).
 *
 * Lab note: the live agent often posts as router_id "router".
 * loc-north-12 maps to that so demo selection yields real series.
 */
(function (global) {
  var LOCATIONS = [
    {
      id: "loc-north-12",
      address: "12 North Ridge Rd",
      member: "Rivera household",
      account: "A-10428",
      region: "North ridge",
      installed: "2024-03-12",
      router_id: "router",
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
        router_id: "router",
        model: "prplOS CPE",
        status: "online",
        mac: "02:1a:2b:3c:4d:5e",
        software: "cpe_agent · OpenWrt",
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

  global.EdgeContextCatalog = {
    all: all,
    get: get,
    byRouterId: byRouterId,
    optionsHtml: optionsHtml
  };
})(typeof window !== "undefined" ? window : globalThis);
