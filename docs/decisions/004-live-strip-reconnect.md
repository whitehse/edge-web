# ADR-004: Unified live-strip and reconnect contract

## Status

Accepted (slice 2)

## Date

2026-07-28

## Context

`/host/` and `/graphs/` each reimplemented hospital-strip live scrolling,
feed-stale detection, and WebSocket resubscribe. `/host/` still **replaced**
series buffers with short WS tips, so history collapsed to 2–4 points after a
push. Operators bouncing between pages saw inconsistent “Waiting / Stalled /
Receiving” behavior and lost history on reconnect.

## Decision

1. Ship **`public/live_feed.js`** (`window.LiveFeed`) as the single client
   contract for:
   - `mergeByTimestamp` — always accumulate; never tip-wipe history
   - `LIVE_LEAD_MS` (2.5s) — max live right-edge lead past last sample
   - `FEED_STALE_MS` (15s) — stale = no **push**, not sample bucket age
   - `HOST_SERIES_LIMIT` (120) — match server WS frame cap
   - `liveWindow`, `feedChip`, `onMuxOpen`, `fmtAge`
2. **`/host/`** and **`/graphs/`** both use merge-by-timestamp for host/wifi
   WS **and** REST; REST bootstrap on every watch/subscribe/reconnect.
3. **On every WS `open`:** re-issue mux watches (server drops them) + REST seed.
4. **`/flows/`** keeps full snapshot list/series (not tip merge) but still
   re-watches on every open with the same reconnect rule.
5. Empty CPE: do not start unfiltered host watches; show context empty UI
   (slice 1).

## Consequences

- Live feel and reconnect semantics match across host and graphs.
- New telemetry pages should import/load `live_feed.js` rather than inventing
  merge rules.
- Server push interval remains an edgehost concern (target ~1s product-side).

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep per-page merge logic | Drift already caused history loss on /host/ |
| REST poll only | Fights WS-first ADR-002 |
| ES-module-only shared package | Host pages are classic scripts; `window.LiveFeed` bridges both |
