# DOMAIN.md — edge-web glossary

| Term | Meaning |
|------|---------|
| **edge-web** | This repo: browser UI static assets + product decisions |
| **edgehost** | io_uring multi-plugin host: serves SPA, REST, WS; brokers DB I/O |
| **cpe_agent** | OpenWrt agent (netforensics) that emits NDJSON telemetry and may use pqproxy |
| **spa.root** | edgehost config path to this repo’s `public/` directory |
| **router_id** | CPE identity string used as the primary filter for host/wifi/flow series |
| **STATE_CHANGED** | WS frame type for discrete state store updates (often from PG NOTIFY) |
| **WS mux** | Versioned envelope on `/api/v1/stream?topics=mux,state` (`v`,`ch`,`op`,`id`,`body`) |
| **ClickHouse** | Columnar store for time-series and event history (browser never queries it) |
| **Postgres** | Current-state store + `NOTIFY` for just-in-time map/SPA updates |
| **NOTIFY apply** | edgehost validates PG notify JSON → state put/delete → WS fan-out |
| **telemetry proxy** | edgehost listen (lab **18082**) for CPE `POST /api/v1/telemetry/events` |
| **pqproxy** | L7 Postgres proxy for CPE (lab **18081**); operators do not use it from the browser |
| **subscribe** | Browser asks edgehost to push a channel on an interval or on events |
| **notify** | Server-initiated WS frame (state change or series push) |
| **inventory** | Premise list (`/inventory/locations.json`) feeding EdgeContext + map |
| **map.dynamic** | State ns for live map overlays (WS STATE_CHANGED + REST) |
| **focus feature** | `feature/focus/selected` highlight for the active location |
