/**
 * edgehost application shell — sidebar navigation + shared chrome.
 * Include after app.js on pages with <body class="app-shell" data-nav="…">.
 *
 * Auth: only the home page shows a login form. Other pages redirect to
 *   /?next=<path> when unauthenticated.
 * Theme: light/dark via html[data-theme], persisted in localStorage.
 */
(function (global) {
  var NAV = [
    { section: "Overview" },
    { id: "home", href: "/", label: "Home", ico: "◈" },
    { id: "devices", href: "/devices/", label: "Locations & devices", ico: "⌂" },
    { id: "map", href: "/map/", label: "Status map", ico: "◎" },
    { section: "Services" },
    { id: "e7", href: "/e7/", label: "E7 Call Home", ico: "⬡" },
    { id: "junos", href: "/junos/", label: "Junos Call Home", ico: "▣" },
    { id: "graphs", href: "/graphs/", label: "Graphs", ico: "▤" },
    { id: "flows", href: "/flows/", label: "CPE flows", ico: "⇄" },
    { id: "host", href: "/host/", label: "CPE host & Wi‑Fi", ico: "▣" },
    { id: "explain", href: "/explain/", label: "Fiber explain", ico: "◇" },
    { id: "ca", href: "/ca/", label: "Certificate Authority", ico: "🔐" },
    { section: "Tools" },
    { id: "documentation", href: "/documentation/", label: "Documentation", ico: "☰" },
    { id: "lab", href: "/lab/", label: "Lab console", ico: "⚙" }
  ];

  var THEME_KEY = "edgehost-theme";
  var authListeners = [];
  var lastAuthOk = null;

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function activeId() {
    var d = document.body.getAttribute("data-nav");
    if (d) return d;
    var p = location.pathname || "/";
    if (p === "/" || p === "/index.html") return "home";
    if (p.indexOf("/devices") === 0) return "devices";
    if (p.indexOf("/map") === 0) return "map";
    if (p.indexOf("/e7") === 0) return "e7";
    if (p.indexOf("/junos") === 0) return "junos";
    if (p.indexOf("/graphs") === 0) return "graphs";
    if (p.indexOf("/flows") === 0) return "flows";
    if (p.indexOf("/host") === 0) return "host";
    if (p.indexOf("/explain") === 0) return "explain";
    if (p.indexOf("/ca") === 0) return "ca";
    if (p.indexOf("/documentation") === 0) return "documentation";
    if (p.indexOf("/lab") === 0) return "lab";
    return "";
  }

  function isHome() {
    return activeId() === "home";
  }

  function applyTheme(theme) {
    if (theme !== "light" && theme !== "dark") {
      theme = "dark";
    }
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* ignore */
    }
    var btn = $("#shellThemeBtn");
    if (btn) {
      btn.textContent = theme === "light" ? "☾ Dark" : "☀ Light";
      btn.setAttribute("aria-label", "Switch to " + (theme === "light" ? "dark" : "light") + " mode");
    }
  }

  function initTheme() {
    var saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch (e) {
      saved = null;
    }
    if (saved === "light" || saved === "dark") {
      applyTheme(saved);
      return;
    }
    var prefersLight =
      global.matchMedia &&
      global.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(cur === "light" ? "dark" : "light");
  }

  function buildNavHtml(active) {
    var html = "";
    for (var i = 0; i < NAV.length; i++) {
      var n = NAV[i];
      if (n.section) {
        html += '<div class="nav-section-label">' + n.section + "</div>";
        continue;
      }
      var cls = "nav-item" + (n.id === active ? " active" : "");
      html +=
        '<a class="' +
        cls +
        '" href="' +
        n.href +
        '" data-nav-id="' +
        n.id +
        '">' +
        '<span class="nav-ico" aria-hidden="true">' +
        n.ico +
        "</span><span>" +
        n.label +
        "</span></a>";
    }
    return html;
  }

  function mountShell() {
    var body = document.body;
    if (!body || !body.classList.contains("app-shell")) return;
    if ($("#edge-shell-sidebar")) return;

    var title = body.getAttribute("data-title") || document.title || "edgehost";
    var subtitle = body.getAttribute("data-subtitle") || "";
    var wide = body.getAttribute("data-wide") === "1";
    var active = activeId();

    var frag = document.createDocumentFragment();
    while (body.firstChild) {
      frag.appendChild(body.firstChild);
    }

    var sidebar = document.createElement("aside");
    sidebar.className = "app-sidebar";
    sidebar.id = "edge-shell-sidebar";
    sidebar.innerHTML =
      '<a class="app-brand" href="/">' +
      '<span class="app-brand-mark" aria-hidden="true"></span>' +
      '<span class="app-brand-text">' +
      '<span class="app-brand-name">edgehost</span>' +
      '<span class="app-brand-tag">Network edge</span>' +
      "</span></a>" +
      '<nav class="app-nav" aria-label="Primary">' +
      buildNavHtml(active) +
      "</nav>" +
      '<div class="sidebar-foot">' +
      '<div class="sidebar-user">' +
      '<div class="sidebar-avatar" id="shellAvatar">·</div>' +
      '<div class="sidebar-foot-meta">' +
      '<div class="name" id="shellUserName">Guest</div>' +
      '<div class="role" id="shellUserRole">Sign in to continue</div>' +
      "</div></div>" +
      '<span id="authBadge" class="badge muted">not logged in</span>' +
      "</div>";

    var main = document.createElement("div");
    main.className = "app-main";
    main.id = "edge-shell-main";

    var topbar = document.createElement("header");
    topbar.className = "app-topbar";
    topbar.innerHTML =
      '<div class="topbar-left">' +
      '<button type="button" class="menu-toggle" id="shellMenuBtn" aria-label="Open menu">☰</button>' +
      "<div>" +
      '<h1 class="page-title">' +
      title +
      "</h1>" +
      (subtitle ? '<p class="page-sub">' + subtitle + "</p>" : "") +
      "</div></div>" +
      '<div class="row" style="margin:0;gap:0.5rem" id="shellTopActions">' +
      '<button type="button" class="theme-toggle" id="shellThemeBtn">☀ Light</button>' +
      "</div>";

    var content = document.createElement("div");
    content.className = "app-content" + (wide ? " wide" : "");
    content.id = "edge-shell-content";
    content.appendChild(frag);

    var scrim = document.createElement("div");
    scrim.className = "shell-scrim";
    scrim.id = "shellScrim";

    main.appendChild(topbar);
    main.appendChild(content);
    body.appendChild(sidebar);
    body.appendChild(main);
    body.appendChild(scrim);

    function closeMenu() {
      body.classList.remove("shell-open");
    }
    function toggleMenu() {
      body.classList.toggle("shell-open");
    }
    var btn = $("#shellMenuBtn");
    if (btn) btn.addEventListener("click", toggleMenu);
    scrim.addEventListener("click", closeMenu);
    var themeBtn = $("#shellThemeBtn");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

    var oldHeader = content.querySelector(":scope > header");
    if (oldHeader && !oldHeader.classList.contains("app-topbar")) {
      oldHeader.classList.add("hidden");
    }
    var oldNav = content.querySelector(":scope > p.nav-links");
    if (oldNav) oldNav.classList.add("hidden");

    /* Hide any leftover page-local login cards (single login is home only). */
    var loginCards = content.querySelectorAll(
      "#loginCard, .page-login, section.card.login-only"
    );
    for (var i = 0; i < loginCards.length; i++) {
      loginCards[i].classList.add("hidden");
    }
  }

  function setAuthUi(ok, label, sub, roles) {
    lastAuthOk = !!ok;
    var b = $("#authBadge");
    if (b) {
      b.textContent = label || (ok ? "signed in" : "not logged in");
      b.className = "badge " + (ok ? "ok" : "muted");
    }
    var name = $("#shellUserName");
    var role = $("#shellUserRole");
    var av = $("#shellAvatar");
    if (name) name.textContent = ok ? sub || "Operator" : "Guest";
    if (role) {
      role.textContent = ok ? roles || "employee" : "Sign in on Home";
    }
    if (av) {
      var letter = (sub || (ok ? "E" : "·")).charAt(0).toUpperCase();
      av.textContent = letter;
    }
    document.body.classList.toggle("signed-out", !ok);
    for (var i = 0; i < authListeners.length; i++) {
      try {
        authListeners[i](!!ok);
      } catch (e) {
        /* ignore */
      }
    }
  }

  async function refreshAuth() {
    try {
      var r = await fetch("/auth/me", { credentials: "same-origin" });
      var body = await r.text();
      if (r.ok) {
        var sub = "operator";
        var roles = "session";
        try {
          var j = JSON.parse(body);
          if (j.sub) sub = j.sub;
          if (j.roles) {
            roles = Array.isArray(j.roles) ? j.roles.join(", ") : String(j.roles);
          }
        } catch (e) {
          /* plain text ok */
        }
        setAuthUi(true, "signed in", sub, roles);
        return true;
      }
    } catch (e) {
      /* offline */
    }
    setAuthUi(false, "not logged in");
    return false;
  }

  /**
   * Ensure session exists. On non-home pages, redirect to /?next=… when
   * unauthenticated. Returns true if authenticated.
   */
  async function requireAuth() {
    var ok = await refreshAuth();
    if (ok) return true;
    if (isHome()) return false;
    var next = location.pathname + location.search + location.hash;
    if (!next || next === "/") next = "/";
    location.replace("/?next=" + encodeURIComponent(next));
    return false;
  }

  function onAuthChange(fn) {
    if (typeof fn === "function") authListeners.push(fn);
  }

  global.EdgeShell = {
    mount: mountShell,
    refreshAuth: refreshAuth,
    requireAuth: requireAuth,
    setAuthUi: setAuthUi,
    onAuthChange: onAuthChange,
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    isAuthed: function () {
      return !!lastAuthOk;
    },
    nav: NAV
  };

  initTheme();

  function boot() {
    mountShell();
    /* Theme button exists after mount */
    var t = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(t);

    requireAuth().then(function (ok) {
      if (ok && global.EdgeMux && typeof global.EdgeMux.connect === "function") {
        /* Pages that use EdgeMux connect themselves after load; do not force. */
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
