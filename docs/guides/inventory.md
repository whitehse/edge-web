# Inventory (locations)

## Endpoint (v1)

```http
GET /inventory/locations.json
```

Static file: `public/inventory/locations.json`.

Used by `EdgeContextCatalog` for:

- Shell location picker
- Devices list
- Map premise seed / focus

## Fields

| Field | Required | Notes |
|-------|----------|--------|
| `id` | yes | Stable premise id |
| `address` | yes | Display label |
| `router_id` | yes for telemetry | CH / WS filter |
| `lon` / `lat` | for map | WGS84 |
| `ont` / `router` | recommended | Status + hardware |

## Edit lab inventory

1. Edit `public/inventory/locations.json`
2. Reload the browser (catalog fetches with `cache: no-cache`)
3. Open `/map/` to re-seed `map.dynamic` points

## Future

Postgres-backed `GET /api/v1/inventory/locations` with the same JSON envelope
(ADR-006).
