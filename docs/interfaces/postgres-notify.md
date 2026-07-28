# Interface: Postgres → browser (NOTIFY / state)

Postgres holds **current** operational state that the UI should learn about
immediately (not by polling ClickHouse history).

## Path

```text
Writer (E7 apply, CA, CPE via pqproxy, admin SQL, …)
  → INSERT/UPDATE/DELETE on Postgres table
  → TRIGGER → pg_notify(channel, json_payload)
  → edgehost LISTEN (or inject path) → edge_notify_apply
  → state store put/delete
  → WebSocket fan-out  type=STATE_CHANGED
  → browser (topics=state or mux legacy dispatch)
```

## NOTIFY payload schema (`edge_notify_apply`)

Enforced by edgehost (max payload ~8000 bytes):

```json
{
  "ns": "net.pon",
  "key": "e7/00-02-5d-…/ont/1-1-3-12",
  "op": "put",
  "value": { },
  "request_id": "optional-correlation"
}
```

| Field | Meaning |
|-------|---------|
| `ns` | State namespace (`net.pon`, `map.dynamic`, `inventory`, …) |
| `key` | Key within namespace |
| `op` | `put` or `delete` |
| `value` | JSON object for `put` (omit/ignore on delete) |
| `request_id` | Optional; echoed for debugging |

## Example: ONT status

DDL: `edgehost/sql/postgres/001_ont_status.sql`

- Table `edgehost.ont_status` (PK `shelf_id`, `ont_id`)
- Trigger builds NOTIFY on channel `ont_status` with `ns=net.pon` keys
- History of events remains in ClickHouse `e7_netconf_events`

## Browser contract

| Item | Detail |
|------|--------|
| Socket | `GET /api/v1/stream?topics=state` (or `topics=mux,state`) |
| Frame | `{ "type": "STATE_CHANGED", "ns", "key", "op", "value", … }` |
| Client | Prefer one shared connection via `EdgeMux` (`ws_mux.js`); legacy pages may open a dedicated state socket |
| Semantics | **Event-driven** — no periodic poll of Postgres from the browser |

On `STATE_CHANGED`, UI updates the relevant model (map feature, ONT row, …).
Do not treat these frames as time-series tips; use ClickHouse subscribe for that.

## Related

- edgehost ADR-015 (pqproxy + NOTIFY apply)
- edgehost ADR-019 (CH history vs PG current ONT status)
- [clickhouse-subscribe.md](clickhouse-subscribe.md)
