/* Locations & devices — premise ONT + customer router views. */
(function () {
  function $(id) { return document.getElementById(id); }

  function locations() {
    if (window.EdgeContextCatalog && typeof EdgeContextCatalog.all === "function") {
      return EdgeContextCatalog.all();
    }
    return [];
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusClass(st) {
    var s = String(st || "").toLowerCase();
    if (s === "online" || s === "up") return "ok";
    if (s === "degraded") return "warn";
    if (s === "offline" || s === "down") return "bad";
    return "muted";
  }

  function kv(pairs) {
    return pairs
      .map(function (p) {
        return (
          '<div><div class="k">' +
          escapeHtml(p[0]) +
          '</div><div class="v">' +
          (p[2] ? p[1] : escapeHtml(p[1])) +
          "</div></div>"
        );
      })
      .join("");
  }

  function filterList(q) {
    var LOCATIONS = locations();
    q = (q || "").trim().toLowerCase();
    if (!q) return LOCATIONS.slice();
    return LOCATIONS.filter(function (loc) {
      var blob = [
        loc.address,
        loc.member,
        loc.account,
        loc.region,
        loc.router_id,
        loc.ont && loc.ont.id,
        loc.ont && loc.ont.serial,
        loc.ont && loc.ont.model,
        loc.router && loc.router.mac,
        loc.router && loc.router.model,
        loc.router && loc.router.router_id
      ]
        .join(" ")
        .toLowerCase();
      return blob.indexOf(q) >= 0;
    });
  }

  function renderList(list) {
    var g = $("deviceGrid");
    var c = $("deviceCount");
    if (c) c.textContent = list.length + " location" + (list.length === 1 ? "" : "s");
    if (!g) return;
    if (!list.length) {
      g.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1">' +
        '<div class="empty-ico">⌕</div>' +
        "<p>No locations match that search.</p></div>";
      return;
    }
    g.innerHTML = list
      .map(function (loc) {
        var st = (loc.ont && loc.ont.status) || "unknown";
        return (
          '<button type="button" class="device-card" data-id="' +
          escapeHtml(loc.id) +
          '" style="text-align:left;width:100%;font:inherit;cursor:pointer">' +
          '<div class="device-head">' +
          "<div>" +
          '<div class="device-kind">Premise</div>' +
          "<h3>" +
          escapeHtml(loc.address) +
          "</h3></div>" +
          '<span class="badge ' +
          statusClass(st) +
          '">' +
          escapeHtml(st) +
          "</span></div>" +
          '<div class="device-meta">' +
          "<span>" +
          escapeHtml(loc.member) +
          " · " +
          escapeHtml(loc.account) +
          "</span>" +
          "<span>ONT <code>" +
          escapeHtml(loc.ont.id) +
          "</code></span>" +
          "<span>Router <code>" +
          escapeHtml(loc.router.mac) +
          "</code></span>" +
          "</div></button>"
        );
      })
      .join("");

    g.querySelectorAll(".device-card").forEach(function (el) {
      el.addEventListener("click", function () {
        showDetail(el.getAttribute("data-id"));
      });
    });
  }

  function findLoc(id) {
    if (window.EdgeContextCatalog && EdgeContextCatalog.get) {
      return EdgeContextCatalog.get(id);
    }
    return null;
  }

  function showDetail(id) {
    var loc = findLoc(id);
    if (!loc) return;
    /* Location-first: selecting a premise sets global operator context */
    if (window.EdgeContext && EdgeContext.setFromLocation) {
      EdgeContext.setFromLocation(loc, { source: "device" });
    }
    var list = $("listView");
    var det = $("detailView");
    if (list) list.classList.add("hidden");
    if (det) det.classList.remove("hidden");

    if ($("detailAddress")) $("detailAddress").textContent = loc.address;
    if ($("detailMember")) {
      $("detailMember").textContent =
        loc.member + " · account " + loc.account + " · " + loc.region;
    }
    var overall = loc.ont.status === "online" && loc.router.status === "online"
      ? "online"
      : loc.ont.status === "offline" || loc.router.status === "offline"
        ? "attention"
        : loc.ont.status;
    if ($("detailStatus")) {
      $("detailStatus").textContent = overall;
      $("detailStatus").className = "badge " + statusClass(
        overall === "attention" ? "degraded" : overall
      );
    }
    if ($("detailKv")) {
      $("detailKv").innerHTML = kv([
        ["Installed", loc.installed],
        ["Region", loc.region],
        ["Account", loc.account],
        ["Location id", loc.id]
      ]);
    }

    var ont = loc.ont;
    if ($("ontBadge")) {
      $("ontBadge").textContent = ont.status;
      $("ontBadge").className = "badge " + statusClass(ont.status);
    }
    if ($("ontKv")) {
      $("ontKv").innerHTML = kv([
        ["ONT id", ont.id],
        ["Model", ont.model],
        ["Serial", ont.serial],
        ["Vendor", ont.vendor],
        ["Shelf MAC", ont.shelf_mac],
        ["Rx power", ont.rx_dbm != null ? ont.rx_dbm + " dBm" : "—"]
      ]);
    }
    if ($("ontE7Link")) {
      $("ontE7Link").href = "/e7/";
    }

    var rt = loc.router;
    if ($("routerBadge")) {
      $("routerBadge").textContent = rt.status;
      $("routerBadge").className = "badge " + statusClass(rt.status);
    }
    if ($("routerKv")) {
      $("routerKv").innerHTML = kv([
        ["router_id", loc.router_id || (rt && rt.router_id) || "—"],
        ["Model", rt.model],
        ["LAN MAC", rt.mac],
        ["Software", rt.software],
        ["WAN", rt.wan],
        ["Last seen", rt.last_seen]
      ]);
    }

    /* Telemetry deep links inherit shell context */
    var EC = window.EdgeContext;
    function href(path) {
      return EC && EC.hrefWithContext
        ? EC.hrefWithContext(path)
        : path;
    }
    var hostL = $("linkHost");
    var graphsL = $("linkGraphs");
    var flowsL = $("linkFlows");
    if (hostL) hostL.href = href("/host/");
    if (graphsL) graphsL.href = href("/graphs/");
    if (flowsL) flowsL.href = href("/flows/");

    /* Update URL without full reload (keep location + router_id via EdgeContext) */
    try {
      var u = "/devices/?id=" + encodeURIComponent(id);
      if (loc.router_id) u += "&router_id=" + encodeURIComponent(loc.router_id);
      u += "&location=" + encodeURIComponent(id);
      history.replaceState(null, "", u);
    } catch (e) { /* ignore */ }
  }

  function showList() {
    var list = $("listView");
    var det = $("detailView");
    if (list) list.classList.remove("hidden");
    if (det) det.classList.add("hidden");
    try {
      history.replaceState(null, "", "/devices/");
    } catch (e) { /* ignore */ }
  }

  function refresh() {
    var q = $("deviceSearch") ? $("deviceSearch").value : "";
    renderList(filterList(q));
  }

  if ($("deviceSearch")) {
    $("deviceSearch").addEventListener("input", refresh);
  }
  if ($("btnRefresh")) $("btnRefresh").addEventListener("click", refresh);
  if ($("btnBack")) $("btnBack").addEventListener("click", showList);

  refresh();

  var params = new URLSearchParams(location.search);
  var id = params.get("id");
  if (id && findLoc(id)) {
    showDetail(id);
  }

  /* Soft auth check — still usable in open mode */
  if (window.EdgeShell && window.EdgeShell.refreshAuth) {
    window.EdgeShell.refreshAuth();
  }
})();
