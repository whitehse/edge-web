# Data plane overview

## Principles

1. **CPE never opens** Postgres `5432` or ClickHouse `8123`/`9000` on the
   private host. CPE uses **proxies** only (lab: **18081** pqproxy, **18082**
   CH telemetry proxy).
2. **Browser never opens** databases. Browser uses edgehost **HTTP** +
   **WebSocket** only (lab: **18080**).
3. **edgehost never uses CPE proxies** for its own DB I/O (direct UDS / loopback).
4. **WebSockets first** for subscribe and notify:
   - Discrete state (often Postgres-backed) → `STATE_CHANGED`
   - Continuous series (ClickHouse-backed) → mux channel `push` on a timer
5. **REST** for login, one-shot queries, historical bootstrap, and control RPCs.

## Port map (lab defaults)

| Port | Process | Client | Backend |
|------|---------|--------|---------|
| **18080** | edgehost HTTP/WS | Operators / browser | spa.root = edge-web `public/` |
| **18081** | pqproxy | **CPE only** | Postgres Unix socket |
| **18082** | edgehost CH proxy | **CPE only** | ClickHouse batcher → UDS or `127.0.0.1:8123` |

See edgehost `docs/guides/cpe-proxies.md`.

## Two database roles

```text
                    ┌─────────────────────┐
   high-frequency   │     ClickHouse      │  history, analytics, ~1 Hz samples
   append + query   │  cpe_* / e7_* …     │  SPA: subscribe series via edgehost
                    └─────────────────────┘

                    ┌─────────────────────┐
   current state    │      Postgres       │  ONT status, CA, config inventory
   + NOTIFY         │  edgehost.*         │  SPA: STATE_CHANGED via edgehost
                    └─────────────────────┘
```

| Store | Write path | Read path to browser |
|-------|------------|----------------------|
| ClickHouse | CPE → `:18082` NDJSON → batch insert; E7 path enqueues events | edgehost SELECT → REST and/or WS mux push (~1–2 s) |
| Postgres | CPE → `:18081` pqproxy SQL; edgehost/CA UDS writers | Trigger `NOTIFY` → edgehost apply → WS `STATE_CHANGED` |

## Lifecycle sketch

```text
CPE samples (1 Hz host/wifi, …)
  → POST NDJSON /api/v1/telemetry/events  (:18082)
  → edgehost dual-write typed CH tables
  → browser EdgeMux.watch("host"|"wifi"|…)
  → edgehost tick queries CH → WS push

E7 / inventory / ONT current status
  → UPSERT Postgres edgehost.ont_status (or peer tables)
  → NOTIFY payload (edge_notify_apply schema)
  → edgehost state put → WS STATE_CHANGED
  → browser topic "state" handler updates map / panels

Browser open page
  → REST bootstrap (last N minutes of series / list)
  → WS connect topics=mux,state
  → watch filters (router_id, …)
  → merge push samples by timestamp (never wipe history with a tip-only frame)
```

## Ownership

| Artifact | Repo |
|----------|------|
| Static UI | **edge-web** |
| WS/REST handlers, CH client, NOTIFY apply | **edgehost** |
| SQL DDL | **edgehost** `sql/clickhouse`, `sql/postgres` |
| Agent emit types | **netforensics** `cpe_agent` |
| Product contract text (this tree) | **edge-web** `docs/interfaces` |
| Server mirror + implementation notes | **edgehost** `docs/interfaces` |
