# Live telemetry interaction

Shared client rules for **host**, **graphs**, and **flows** live data.

Implementation: `public/live_feed.js` → `window.LiveFeed`.

## Series buffer

| Rule | Detail |
|------|--------|
| Merge by timestamp | WS tips (often 2–4 points) **merge into** history; never replace |
| Lookback | From selected range (minutes → ms), soft cap `HOST_SERIES_LIMIT * 3` |
| Limit | Request `limit: 120` for host/wifi (server frame size) |
| CPE change | Clear merge buffers so two routers never mix |

## Live strip window

| Rule | Detail |
|------|--------|
| Scroll | Wall-clock right edge while feed is fresh |
| Lead cap | Right edge ≤ last sample + **2.5s** (`LIVE_LEAD_MS`) |
| Stalled pin | No push for **15s** → pin window to last sample (chart stays full) |
| Stale signal | Based on **last push time**, not CH bucket age |

## Reconnect

```text
WS open
  → re-watch mux channel (host all / flows list|series / …)
  → REST bootstrap recent window into merge buffer
  → UI: Receiving once first push/points land
```

Server drops watches on disconnect; clients must re-arm every open.

## Feed chip (graphs / host status)

| State | Meaning |
|-------|---------|
| Waiting | No CPE or no samples yet |
| Receiving | Push within 15s |
| Stalled | Had a push; none for >15s |
| History | Live mode off (pan/zoom) |

## Page matrix

| Page | Channels | Merge tips | Re-watch on open | REST seed |
|------|----------|------------|------------------|-----------|
| `/host/` | `host` | yes (host/wifi pts) | yes | yes |
| `/graphs/` | `host` (+ REST flows) | yes via adapter hub | yes | yes |
| `/flows/` | `flows` | list/series snapshot | yes | optional |

## Script order

```html
<script src="/live_feed.js"></script>
<script src="/ws_mux.js"></script>
```
