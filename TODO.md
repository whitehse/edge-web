# TODO — edge-web

Living checklist for the browser project and interaction redesign.

## Done

- [x] Extract SPA from edgehost into sibling `edge-web` (`public/`)
- [x] Scaffold agent-ready docs (`AGENTS.md`, `ARCHITECTURE.md`, interfaces)
- [x] Document data-exchange contracts (CPE ↔ DB ↔ browser, WS-first)

## Next (redesign — owner: product / UI)

- [ ] Define information architecture (nav, primary operator jobs)
- [ ] Clarify CPE selection model (how `router_id` is chosen and persisted)
- [ ] Unify live-strip vs history interaction across graphs/host/flows
- [ ] Document per-page WS subscription matrix (which channels each route needs)
- [ ] Decide auth UX (lab password vs proxy headers) for multi-page flows
- [ ] Map page: live `map.dynamic` via WS feed (status-map guide “next”)
- [ ] Optional: build step / module packaging ADR if the site outgrows static JS

## Contract follow-ups (need edgehost when wire changes)

- [ ] Align default CH series push interval to **1 s** where product requires it
  (flows watch is ~2 s today — see interfaces)
- [ ] Complete PG LISTEN writer in-process if NOTIFY path is still inject-only
- [ ] Path / inventory graph sources (stubs in graphs catalog)
