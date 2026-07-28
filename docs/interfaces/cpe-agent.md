# Interface: CPE agent ↔ ClickHouse / Postgres

The **cpe_agent** (OpenWrt, netforensics tree) does not speak to the browser.
It speaks to **edgehost proxies** that land data in the two databases.

## ClickHouse path (telemetry)

```text
cpe_agent
  → HTTP POST NDJSON  edgehost:18082  /api/v1/telemetry/events
  → edgehost clickhouse-async batcher
  → INSERT JSONEachRow  ClickHouse (direct backend, not the CPE port)
```

| Item | Contract |
|------|----------|
| Method / path | `POST /api/v1/telemetry/events` |
| Body | One JSON object, NDJSON lines, or JSON array of objects |
| Success | `202` when rows queued |
| Auth | Basic (ingest user), device token, or lab open mode |

### Common `type` values (NDJSON)

| `type` | Typical interval | Primary CH tables |
|--------|------------------|-------------------|
| `cpe_host` | ~1 s | `edgehost.cpe_host_stats` |
| `cpe_proc` | ~2 s | `edgehost.cpe_proc_stats` |
| `cpe_wifi` | ~1 s | `cpe_wifi_stats`, `cpe_wifi_fw_stats`, events |
| `cpe_arp` | on change | `cpe_arp_events` |
| `cpe_tcp` / flow / nss / … | config | typed `cpe_*` tables + optional event wrap |

Identity field: **`router_id`** (string). All browser filters for CPE series
use this id (lab often `router`).

Event envelope fields commonly include `ts` (ISO or CH DateTime), metrics
payload, and for wifi `subtype` (`sample` | `station` | `fw` | `event` | `error`).

Authoritative emit docs:  
`~/netforensics/docs/guides/cpe-agent-edgehost-pipeline.md`,  
`~/netforensics/docs/guides/cpe-agent-host-wifi.md`.  
DDL: `~/edgehost/sql/clickhouse/`.

## Postgres path (CPE)

```text
cpe_agent (or site tooling)
  → Postgres wire protocol via pqproxy :18081
  → Unix socket → Postgres
  → tables under edgehost.* (and site schemas)
  → optional NOTIFY triggers for SPA fan-out
```

| Item | Contract |
|------|----------|
| Proxy | **pqproxy** (not edgehost HTTP) |
| Lab port | **18081** |
| Backend | Postgres UDS only from pqproxy’s view |
| Browser impact | Only if a trigger emits `edge_notify_apply` JSON on a LISTEN channel edgehost applies |

CPE does **not** use browser sessions. Operator SPA never connects to 18081.

## What this is not

- Not a WebSocket from CPE to the browser
- Not direct CH native protocol from CPE
- Not edgehost reading back CPE state through the CPE proxies
