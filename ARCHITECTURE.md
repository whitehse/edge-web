# ARCHITECTURE.md — edge-web

## Role

Browser-facing **document root** and interaction model for Edge Platform
operators. edgehost serves files from `public/` and brokers all live data.

```text
┌──────────────────────────────────────────────────────────────────┐
│  Browser (edge-web/public)                                       │
│    pages · EdgeMux (ws_mux.js) · charts · map shell              │
└────────────────────────────┬─────────────────────────────────────┘
                             │  HTTPS/HTTP + WebSocket
                             │  REST bootstrap · WS subscribe/notify
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  edgehost                                                        │
│    static spa.root · auth · state store · WS hub · WS mux        │
│    CH query for series · NOTIFY apply · CPE control hub          │
└───────────────┬─────────────────────────────┬────────────────────┘
                │                             │
       direct UDS/HTTP                 LISTEN / SQL
                ▼                             ▼
        ┌──────────────┐              ┌──────────────┐
        │  ClickHouse  │              │   Postgres   │
        │  history /   │              │  current     │
        │  1 Hz series │              │  state +     │
        └──────▲───────┘              │  NOTIFY      │
               │                      └──────▲───────┘
               │ POST NDJSON                 │ SQL (via pqproxy)
               │ (proxy :18082)              │ (:18081)
        ┌──────┴─────────────────────────────┴──────┐
        │              cpe_agent (OpenWrt)            │
        └───────────────────────────────────────────┘
```

## Serving model

| Concern | Owner |
|---------|--------|
| Files under `public/` | **edge-web** |
| `spa.root` config, MIME, max file size | **edgehost** |
| Session cookie / lab login | **edgehost** (ADR-013) |
| URL paths | 1:1 with `public/` (`/graphs/` → `public/graphs/index.html`) |

Lab sibling default: `spa.root: ../edge-web/public` from the edgehost cwd.

## Data plane (summary)

Two complementary paths reach the browser. Prefer **WebSockets** for both.

| Source system | Semantics | Browser delivery |
|---------------|-----------|------------------|
| **Postgres** | Current / discrete state (ONT status, inventory-ish keys) | `NOTIFY` → edgehost `edge_notify_apply` → state store → WS **`STATE_CHANGED`** (topic `state`) |
| **ClickHouse** | Time-series history + live tips (~1 s samples) | edgehost queries CH on interval or on demand → WS **mux channels** (`host`, `wifi`, `flows`, …) and/or REST bootstrap |

Full contracts: [docs/interfaces/](docs/interfaces/).

## Page map (current)

| URL | Purpose |
|-----|---------|
| `/` | Home + lab login |
| `/map/` | Status map (libwebmap) — live `map.dynamic` WS + inventory seed |
| `/graphs/` | Composable live charts workspace |
| `/host/` | CPE host + Wi‑Fi forensics |
| `/flows/` | Flow list / series |
| `/e7/`, `/junos/` | Call Home admin |
| `/lab/` | API console |
| `/ca/`, `/devices/`, `/explain/`, `/documentation/` | Supporting tools |

Redesign may reorganize routes; record decisions under `docs/decisions/`.

## Client libraries (in-tree)

| File | Role |
|------|------|
| `public/ws_mux.js` | Single shared WS (`EdgeMux`) to `/api/v1/stream?topics=mux,state` |
| `public/shell.js` | Shared nav / chrome + location-first context picker |
| `public/context.js` | `EdgeContext` persistence + URL sync |
| `public/context_catalog.js` | Locations from `/inventory/locations.json` |
| `public/live_feed.js` | Live-strip merge / reconnect contract |
| `public/charts/*` | WebGPU + Canvas2D time-series views |

## Absences (by design)

- No direct browser → ClickHouse or Postgres
- No server-side rendering framework (static files + client JS)
- No CPE control plane in this repo (`/api/v1/cpe/control` is edgehost)
