/**
 * edge-ui — Motion (Framer lineage) micro-interactions + decoration helpers.
 *
 * Vanilla SPA: loads Motion from CDN (ESM). Safe no-op if offline / reduced-motion.
 * Shell mounts this after chrome exists.
 */
(function (global) {
  "use strict";

  var motionApi = null;
  var motionReady = null;
  var reduced =
    global.matchMedia &&
    global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function loadMotion() {
    if (motionReady) return motionReady;
    if (reduced) {
      motionReady = Promise.resolve(null);
      return motionReady;
    }
    motionReady = import("https://cdn.jsdelivr.net/npm/motion@12.23.12/+esm")
      .then(function (m) {
        motionApi = m;
        return m;
      })
      .catch(function () {
        /* offline / blocked CDN — CSS-only falls back */
        return null;
      });
    return motionReady;
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* ── Reveal (stagger fade-up) ─────────────────────────── */

  function markRevealed(el) {
    el.classList.add("is-revealed");
    el.style.opacity = "";
    el.style.transform = "";
  }

  function reveal(root) {
    var scope = root || document.getElementById("edge-shell-content") || document.body;
    var nodes = $$("[data-reveal]", scope);
    if (!nodes.length) {
      /* Auto-tag common content blocks once */
      nodes = $$(".metric-strip .metric, .service-tile, .device-card, .host-health-card, .graphs-panel, .stat-card, .glance-list li, .surface-flat, .toolbar, .graphs-timebar, .host-health, .section-head", scope)
        .filter(function (el) {
          return !el.hasAttribute("data-reveal");
        });
      nodes.forEach(function (el, i) {
        el.setAttribute("data-reveal", "");
        el.setAttribute("data-reveal-i", String(i));
      });
    }
    if (!nodes.length) return;

    if (reduced) {
      nodes.forEach(markRevealed);
      return;
    }

    loadMotion().then(function (m) {
      if (!m || !m.animate || !m.stagger) {
        nodes.forEach(markRevealed);
        return;
      }
      nodes.forEach(function (el) {
        el.style.opacity = "0";
      });
      m.animate(
        nodes,
        { opacity: [0, 1], y: [10, 0] },
        {
          duration: 0.42,
          delay: m.stagger(0.035, { startDelay: 0.04 }),
          easing: [0.22, 1, 0.36, 1]
        }
      ).finished.then(function () {
        nodes.forEach(markRevealed);
      }).catch(function () {
        nodes.forEach(markRevealed);
      });
    });
  }

  /* ── Pressable spring ─────────────────────────────────── */

  function bindPressable(root) {
    if (reduced) return;
    var scope = root || document;
    $$("[data-pressable], .service-tile, .device-card, .btn, button.primary, a.btn", scope).forEach(function (el) {
      if (el.__edgePressBound) return;
      el.__edgePressBound = true;
      el.setAttribute("data-pressable", "");

      el.addEventListener("pointerdown", function () {
        loadMotion().then(function (m) {
          if (!m || !m.animate) return;
          m.animate(el, { scale: 0.985 }, { duration: 0.1, easing: "ease-out" });
        });
      });
      function release() {
        loadMotion().then(function (m) {
          if (!m || !m.animate) return;
          m.animate(
            el,
            { scale: 1 },
            { type: "spring", visualDuration: 0.35, bounce: 0.25 }
          );
        });
      }
      el.addEventListener("pointerup", release);
      el.addEventListener("pointerleave", release);
      el.addEventListener("pointercancel", release);
    });
  }

  /* ── Active decoration helpers ────────────────────────── */

  function setActive(el, on) {
    if (!el) return;
    el.classList.toggle("is-active", !!on);
    el.classList.toggle("active", !!on);
    if (on) el.setAttribute("data-active", "1");
    else el.removeAttribute("data-active");
  }

  function exclusiveActive(container, selector, target) {
    if (!container) return;
    $$(selector, container).forEach(function (el) {
      setActive(el, el === target);
    });
  }

  /** Wire segmented controls: .seg > button */
  function bindSegments(root) {
    $$( ".seg", root || document).forEach(function (seg) {
      if (seg.__edgeSegBound) return;
      seg.__edgeSegBound = true;
      seg.addEventListener("click", function (e) {
        var btn = e.target.closest("button, .seg-btn");
        if (!btn || !seg.contains(btn)) return;
        exclusiveActive(seg, "button, .seg-btn", btn);
      });
    });
  }

  /** Graph time presets + live already use .active — polish with motion tick */
  function pulse(el) {
    if (!el || reduced) return;
    loadMotion().then(function (m) {
      if (!m || !m.animate) return;
      m.animate(
        el,
        { boxShadow: [
          "0 0 0 0 rgba(56,189,248,0)",
          "0 0 0 6px rgba(56,189,248,0.2)",
          "0 0 0 0 rgba(56,189,248,0)"
        ] },
        { duration: 0.55, easing: "ease-out" }
      );
    });
  }

  /* ── Page content polish ──────────────────────────────── */

  function decorateShell() {
    /* Topbar title hierarchy already set; ensure content has room */
    var content = $("#edge-shell-content");
    if (content && !content.classList.contains("ui-ready")) {
      content.classList.add("ui-ready");
    }
  }

  function enhance() {
    decorateShell();
    reveal();
    bindPressable();
    bindSegments();
  }

  /* Observe dynamic grids (home services, devices) */
  function observeDynamic() {
    var content = $("#edge-shell-content");
    if (!content || content.__edgeUiObs) return;
    content.__edgeUiObs = true;
    var t = null;
    var obs = new MutationObserver(function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        bindPressable(content);
        bindSegments(content);
      }, 80);
    });
    obs.observe(content, { childList: true, subtree: true });
  }

  function boot() {
    enhance();
    observeDynamic();
    /* Re-reveal after auth paints home dashboard */
    if (global.EdgeShell && typeof global.EdgeShell.onAuthChange === "function") {
      global.EdgeShell.onAuthChange(function (ok) {
        if (ok) setTimeout(function () { reveal(); bindPressable(); }, 40);
      });
    }
  }

  global.EdgeUI = {
    reveal: reveal,
    bindPressable: bindPressable,
    setActive: setActive,
    exclusiveActive: exclusiveActive,
    pulse: pulse,
    loadMotion: loadMotion,
    enhance: enhance
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      /* After shell boot (shell also listens DOMContentLoaded) */
      setTimeout(boot, 0);
    });
  } else {
    setTimeout(boot, 0);
  }
})(typeof window !== "undefined" ? window : globalThis);
