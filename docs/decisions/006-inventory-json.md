# ADR-006: Inventory as HTTP JSON (catalog v1)

## Status

Accepted (v1)

## Date

2026-07-28

## Context

Location-first context needs a premise list with `router_id` and map
coordinates. A full Postgres inventory service is not ready. Hardcoding only
inside `context_catalog.js` made updates awkward and blocked the status map
from seeding `map.dynamic`.

## Decision

1. **v1 inventory document:** `GET /inventory/locations.json` (static under
   edge-web `public/`, served by edgehost `spa.root`).
2. **`EdgeContextCatalog`** loads that URL on startup; falls back to embedded
   fixtures if fetch fails.
3. Shape:

```json
{
  "v": 1,
  "locations": [
    {
      "id": "loc-…",
      "address": "…",
      "router_id": "router",
      "lon": -95.99,
      "lat": 36.12,
      "ont": { "id": "…", "status": "online" },
      "router": { "router_id": "router", "status": "online" }
    }
  ]
}
```

4. Catalog may **publish** premises into `map.dynamic` via
   `PUT /api/v1/state/map.dynamic/feature/premise/{id}` for map paint/WS.
5. Future: replace static file with edgehost `GET /api/v1/inventory/locations`
   backed by Postgres without changing the JSON shape consumers expect.

## Consequences

- Operators edit lab inventory without redeploying JS logic.
- Map and devices share one list.
- No edgehost C change required for v1.

## Alternatives considered

| Option | Why not (now) |
|--------|----------------|
| Only embedded JS array | Hard to edit; not an “API” |
| Full PG inventory service first | Blocks map/context work |
| ClickHouse as inventory | Wrong store for current premise state |
