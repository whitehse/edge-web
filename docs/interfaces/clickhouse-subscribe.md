# Interface: ClickHouse → browser (subscribe / periodic)

ClickHouse stores **high-frequency and historical** series (host CPU, Wi‑Fi,
flows, E7 events). The browser does not run SQL. edgehost queries CH and
delivers results over **WebSocket** (preferred) or REST (bootstrap / one-shot).

## Path

```text
ClickHouse tables (cpe_host_stats, cpe_wifi_stats, flows, …)
  ▲
  │ batch INSERT from CPE / E7
  │
edgehost (direct CH client)
  │  on WS watch timer (~1–2 s) or REST request
  │  SELECT … WHERE router_id = ? ORDER BY ts DESC LIMIT N
  ▼
WebSocket mux channel push  (or REST JSON)
  ▼
edge-web page adapters (merge-by-timestamp into client buffers)
```

## Product preference

| Preference | Detail |
|------------|--------|
| Transport | **WebSocket** mux (`ch` = `host` \| `wifi` \| `flows` \| …) |
| Live interval | Target **~1 second** for host/wifi-style series (implementation may be 1–2 s; document per channel) |
| Bootstrap | REST GET of recent window so the chart is not empty before first push |
| Reconnect | Re-issue `watch` + REST bootstrap (server watches are connection-scoped) |
| Merge rule | Client **merges by timestamp**; a short tip must not wipe a long buffer (`public/live_feed.js`) |

## Subscribe model (mux)

Client → server:

```json
{ "v": 1, "ch": "host", "op": "watch", "id": "corr-1", "body": { "router_id": "router", "limit": 120 } }
```

Server → client (periodic while watched):

```json
{ "v": 1, "ch": "host", "op": "push", "id": "push", "body": { "ok": true, "points": [ … ] } }
```

Exact `body` shapes are channel-specific; see [browser-api.md](browser-api.md)
and edgehost `docs/guides/ws-mux.md`.

## REST bootstrap (examples)

| Purpose | Method (lab) |
|---------|----------------|
| Host series | `GET /api/v1/cpe/host?router_id=&minutes=&limit=` |
| Wi‑Fi radio | `GET /api/v1/cpe/wifi?router_id=&minutes=` |
| Stations | `GET /api/v1/cpe/wifi/stations` · `/stations/series` |
| Flows | `GET /api/v1/flows` · `/api/v1/flows/series` |

REST responses are snapshots. Live mode should not rely on REST polling when a
WS watch is available.

## What belongs in CH vs Postgres

| In ClickHouse | In Postgres |
|---------------|-------------|
| 1 Hz host/wifi tips and multi-hour history | Current ONT oper-state |
| Flow chunks / TCP window series | CA / config inventory (as designed) |
| E7 event history | Discrete keys for map NOTIFY |

## Related

- edgehost `docs/guides/cpe-host-wifi-ui.md`
- edgehost `docs/guides/cpe-flows-ui.md`
- edgehost `docs/guides/graphs-workspace.md`
- [postgres-notify.md](postgres-notify.md)
