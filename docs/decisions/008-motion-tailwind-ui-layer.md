# ADR-008: Motion + Tailwind-inspired UI layer (no bundler)

## Status

Accepted — 2026-08-04

## Context

edge-web is a static multi-page SPA with **no required bundler**. Operator pages
need modern interaction quality (Framer/Motion micro-animations, utility spacing,
decoration-first active states) without converting to React.

## Decision

1. **`public/ui.css`** — design utilities and decoration system:
   - Type scale (`t-xs` … `t-4xl`, overlines, metrics)
   - Sparse surfaces (`.surface`, `.surface-inset`, `.toolbar`) vs rare `.card`
   - Active emphasis via **decoration** (rail, ring, glow, live pulse) — not size
2. **`public/ui.js`** — vanilla **Motion** (Framer lineage) from CDN ESM:
   - Staggered reveal, press springs, active helpers
   - No-op when offline or `prefers-reduced-motion`
3. **Tailwind Play CDN** optional (`preflight: false`) + `tailwind-edge.js`
   theme tokens; offline still works via `ui.css`.
4. Shell (`shell.js`) injects the layer on `app-shell` pages.

## Consequences

- Pages keep vanilla HTML/JS; no React dependency.
- CDN failure degrades to CSS-only (acceptable for lab).
- Prefer `.surface-inset` / toolbars for chrome; reserve `.card` for hero,
  empty states, and warnings.
