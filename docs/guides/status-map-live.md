# Status map — live feed and location highlight

## Default live feed

When you open `/map/` without a `feed` query param, **map_boot.js** sets:

```text
?feed=ws://<host>/api/v1/stream?topics=state
```

(or `wss://` on HTTPS). libwebmap’s `dynamic_feed.js` consumes edgehost
`STATE_CHANGED` frames for namespace **`map.dynamic`**.

| Query | Effect |
|-------|--------|
| (omit `feed`) | Live WS to edgehost state stream |
| `?feed=0` | Dynamic layer off |
| `?feed=./dynamic/sample_events.jsonl` | Offline fixture replay |
| `?feed=ws://…` | Custom WebSocket |

## Inventory seed

On map load, catalog premises with `lon`/`lat` are **PUT** into:

```text
map.dynamic / feature/premise/{locationId}
```

as Point features (`class: premise`). The selected EdgeContext location is
also written to:

```text
map.dynamic / feature/focus/selected
```

(`class: focus`, status `degraded` for visibility). Changing location in the
shell (or devices) re-PUTs the focus key; WS fans out to the open map.

## Context chrome

Map top bar shows the active location/CPE label and deep-links to Graphs /
Host / Devices with context query params.

## Requirements

- edgehost serving `spa.root` = edge-web `public/`
- `map.dynamic` namespace **enabled** in YAML
- Session (or `auth.mode: open`) so state PUT and WS stream work
- libwebmap demo assets linked (`run-status-map*.sh`)

## Verify

```bash
cd ~/edgehost && ./scripts/run-status-map-junos.sh
# Browser: /map/  → Dynamic feed HUD shows mode ws
# Select a location on /devices/ → return to /map/ → focus point updates
# curl -sS -b cookies.txt http://127.0.0.1:18080/api/v1/state/map.dynamic
```
