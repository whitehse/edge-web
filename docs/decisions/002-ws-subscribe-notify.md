# ADR-002: WebSocket-first subscribe and notify

## Status

Accepted

## Date

2026-07-28

## Context

Two data shapes reach the UI:

1. **Discrete current state** (e.g. ONT up/down) originating in Postgres
   `NOTIFY`.
2. **Continuous series** (e.g. 1 Hz host CPU) stored in ClickHouse.

Polling REST for both confuses loading states, wastes bandwidth, and caused
fragile client buffer logic during the graphs workspace work. Operators expect
hospital-strip live charts and instant map updates.

## Decision

1. Prefer **WebSockets** for all subscribe/notify transfers between edgehost
   and the browser.
2. **Postgres path:** `NOTIFY` → `edge_notify_apply` → state store → WS
   `STATE_CHANGED` (event-driven, not polled).
3. **ClickHouse path:** browser `watch` on mux channels → edgehost queries CH
   on a short interval (target **~1 s** for host/wifi-class series) → WS
   `push`; REST remains for **bootstrap** and historical windows.
4. One multiplexed socket per page (`EdgeMux`, `topics=mux,state`) unless a
   dedicated control hub is required (`/api/v1/cpe/control`).
5. Clients **merge series by timestamp** and re-watch + REST-bootstrap on
   reconnect.

## Consequences

- edge-web pages must not open DB ports or long-poll CH.
- Interval and channel matrix should be documented in
  `docs/interfaces/clickhouse-subscribe.md` as channels stabilize.
- Server may temporarily use 2 s ticks (flows); product target remains 1 s
  where live feel matters — track gaps in TODO.

## Alternatives considered

| Option | Why not |
|--------|---------|
| REST poll every 1 s | Higher overhead; harder merge; worse reconnect UX |
| SSE only | We already have WS hub + mux; dual stacks unneeded |
| Browser → ClickHouse HTTP | Breaks auth topology and CPE proxy rules |
