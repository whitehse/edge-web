# TODO — edge-web

Living checklist for the browser project and interaction redesign.

## Done

- [x] Extract SPA from edgehost into sibling `edge-web` (`public/`)
- [x] Scaffold agent-ready docs (`AGENTS.md`, `ARCHITECTURE.md`, interfaces)
- [x] Document data-exchange contracts (CPE ↔ DB ↔ browser, WS-first)

## Next (redesign — owner: product / UI)

- [x] Slice 1: shell + **location-first** global context (`EdgeContext`)
- [x] Wire host / flows / graphs + devices to shared context
- [x] Light nav grouping (Telemetry / Access gear)
- [x] Slice 2: unify live-strip / merge / reconnect (`live_feed.js`)
- [x] Document per-page WS subscription matrix (live-telemetry guide)
- [x] Auth UX ADR (Home-only login · next= · open/proxy/lab modes)
- [x] Map: live `map.dynamic` WS feed + inventory seed + focus highlight
- [x] Inventory JSON API (`/inventory/locations.json` → catalog)
- [x] Map: satellite basemap + Calix subscribers package (libwebmap ADR-028)
- [ ] Optional: build step / module packaging ADR if the site outgrows static JS
- [ ] Postgres-backed inventory endpoint (same JSON shape)
- [ ] Map: ONT status from Postgres NOTIFY / FSAN join (edgehost)

## Remote desktop (noVNC)

- [x] **PR-6** SPA `/desktop/` (REST session + noVNC path WS; clipboard off)
- [ ] Optional: vendor noVNC under `public/desktop/novnc/` (CDN default today)
- [ ] Optional: throttle UI quality from session `throttled` flag

## Contract follow-ups (need edgehost when wire changes)

- [ ] Align default CH series push interval to **1 s** where product requires it
  (flows watch is ~2 s today — see interfaces)
- [ ] Complete PG LISTEN writer in-process if NOTIFY path is still inject-only
- [ ] Path / inventory graph sources (stubs in graphs catalog)
