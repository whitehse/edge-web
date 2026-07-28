# ADR-003: Location-first operator context

## Status

Accepted (slice 1)

## Date

2026-07-28

## Context

Telemetry pages (`/host/`, `/flows/`, `/graphs/`) each kept a free-text
`router_id` filter. Context did not survive navigation, lab ids were unclear
(`router` vs placeholders), and operators think in **premises**, not raw CPE
keys. Data contracts already use `router_id` for ClickHouse and WS watches.

## Decision

1. Introduce a shared **`EdgeContext`** (`public/context.js`) holding
   `{ locationId, routerId, ontId, label, source }`.
2. **Location-first:** selecting a premise fills CPE/ONT from the catalog;
   free-typed `router_id` remains allowed as override.
3. Persist in `localStorage` (`edge-web-context-v1`) and sync URL
   `?location=` / `?router_id=`.
4. Shell top bar owns the primary picker; page filters mirror context.
5. Lab catalog (`context_catalog.js`) maps demo premises; live lab agent maps
   to `router_id: "router"` on `loc-north-12` until inventory API exists.
6. Keep `/host/`, `/flows/`, `/graphs/` as separate routes for now.

## Consequences

- Operators set focus once (devices or shell) and navigate telemetry pages.
- Empty context shows an explicit banner on telemetry pages.
- Inventory API can later replace the static catalog without changing
  EdgeContext shape.

## Alternatives considered

| Option | Why not (slice 1) |
|--------|-------------------|
| Per-page filters only | Does not fix cross-page confusion |
| router_id-only global context | Ignores premise-first operator model |
| Collapse all telemetry into graphs now | Larger product change; deferred |
