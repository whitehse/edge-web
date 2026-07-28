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
- [ ] Unify live-strip vs history interaction across graphs/host/flows (slice 2)
- [ ] Document per-page WS subscription matrix (which channels each route needs)
- [ ] Decide auth UX (lab password vs proxy headers) for multi-page flows
- [ ] Map page: live `map.dynamic` via WS feed + highlight selected location
- [ ] Inventory API replaces static `context_catalog.js`
- [ ] Optional: build step / module packaging ADR if the site outgrows static JS

## Contract follow-ups (need edgehost when wire changes)

- [ ] Align default CH series push interval to **1 s** where product requires it
  (flows watch is ~2 s today — see interfaces)
- [ ] Complete PG LISTEN writer in-process if NOTIFY path is still inject-only
- [ ] Path / inventory graph sources (stubs in graphs catalog)
