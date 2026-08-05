/**
 * Optional Tailwind CDN config for edge-web.
 * Preflight OFF so app.css remains the base. Theme mirrors design tokens.
 * Loaded only when tailwindcss Play CDN is present (see shell inject).
 */
(function () {
  if (typeof tailwind === "undefined") return;
  tailwind.config = {
    corePlugins: {
      preflight: false
    },
    theme: {
      extend: {
        colors: {
          edge: {
            bg: "var(--bg)",
            elevated: "var(--bg-elevated)",
            surface: "var(--surface)",
            soft: "var(--surface-2)",
            border: "var(--border)",
            muted: "var(--muted)",
            faint: "var(--faint)",
            accent: "var(--accent)",
            peach: "var(--accent-2)",
            ok: "var(--ok)",
            warn: "var(--warn)",
            bad: "var(--bad)"
          }
        },
        fontFamily: {
          display: ["var(--font-display)"],
          ui: ["var(--font-ui)"],
          mono: ["var(--font-mono)"]
        },
        borderRadius: {
          edge: "var(--radius)",
          "edge-sm": "var(--radius-sm)"
        },
        boxShadow: {
          edge: "var(--shadow)",
          "edge-sm": "var(--shadow-sm)",
          ring: "0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)",
          "ring-lg": "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent), 0 0 24px color-mix(in srgb, var(--accent) 12%, transparent)"
        },
        fontSize: {
          "2xs": ["0.625rem", { lineHeight: "1.3" }],
          overline: ["0.625rem", { lineHeight: "1.3", letterSpacing: "0.1em" }]
        },
        transitionTimingFunction: {
          edge: "cubic-bezier(0.22, 1, 0.36, 1)"
        }
      }
    }
  };
})();
