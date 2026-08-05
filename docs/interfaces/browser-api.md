# Interface: browser ↔ edgehost

The SPA talks **only** to edgehost. This is the consumer API surface for
edge-web pages.

## Auth

| Mode | Browser behavior |
|------|------------------|
| `lab_password` | `POST /auth/lab-login` → cookie `edge_session`; `GET /auth/me` |
| `proxy_headers` | Reverse proxy injects signed identity headers |
| `open` | Lab only; no login |

## Static

| Request | Result |
|---------|--------|
| `GET /…` | Files under `spa.root` (`edge-web/public`) |
| Directory URL | `index.html` if present |

## WebSocket entry

```text
ws(s)://<host>/api/v1/stream?topics=mux,state
```

| Topic | Content |
|-------|---------|
| `state` | `STATE_CHANGED` frames (Postgres NOTIFY / state store) |
| `mux` | Versioned channel PDUs (`v`,`ch`,`op`,`id`,`body`) |

Client helper: `public/ws_mux.js` → global **`EdgeMux`**.

### Mux envelope

```json
{ "v": 1, "ch": "<channel>", "op": "<op>", "id": "<corr>", "body": { } }
```

### Channels in use (lab)

| `ch` | Role | Typical ops |
|------|------|-------------|
| `sys` | Hello / capability | `hello` |
| `host` | CPE host series | `watch`, `unwatch`, `push`, REST sibling `/api/v1/cpe/host` |
| `wifi` | Wi‑Fi series / stations | `watch`, `unwatch`, `push`, REST siblings under `/api/v1/cpe/wifi*` |
| `flows` | Flow list + series | `list`, `series`, `watch`, `push` |
| `state` | (via EdgeMux dispatch) | `STATE_CHANGED` legacy frames |

Full PDU notes: edgehost `docs/guides/ws-mux.md` (flows documented first;
host/wifi follow the same envelope).

### Design rules for pages

1. **One** multiplexed socket per browser page (or shared worker later).
2. On open and on reconnect: REST bootstrap + re-`watch`.
3. Prefer WS push for live; use REST for history windows and exports.
4. Correlate with `id` when issuing request/response ops.

## REST map (high level)

| Area | Prefix | Notes |
|------|--------|-------|
| Health | `GET /health` | No auth |
| Auth | `/auth/*` | Lab login / me |
| State | `/api/v1/state/*` | Optional direct state read |
| CPE series | `/api/v1/cpe/host`, `/wifi`, … | CH-backed |
| Flows | `/api/v1/flows` | CH-backed |
| E7 admin | `/api/v1/e7/*` | Call Home control plane |
| Telemetry status | `/api/v1/telemetry/status` | Operator/debug (not CPE path) |
| CPE control WS | `GET /api/v1/cpe/control` | Separate hub (summon/AI); not series data |
| CPE shell WS | `GET /api/v1/cpe/shell?router_id=` | Browser xterm.js ↔ callhome PTY (binary frames) |
| CPE desktop | `/api/v1/cpe/desktop/*` | Remote troubleshooting desktop (REST + VNC WS) |
| CPE callhome | `GET /api/v1/cpe/callhome` | Online routers + staff_port + reverse tunnels |

### CPE shell WebSocket

```text
ws(s)://<host>/api/v1/cpe/shell?router_id=cpe-lab
```

| Direction | Frame | Payload |
|-----------|-------|---------|
| Browser → host | binary | PTY stdin bytes |
| Host → browser | binary | PTY stdout bytes |
| Browser → host | text | `{"op":"resize","cols":N,"rows":M}` |
| Host → browser | text | `{"op":"status","state":"ready\|error","msg":"…"}` |

SPA: `public/terminal/` (xterm.js from CDN). Requires online CPE call-home
session; exclusive with staff reverse-shell SSH face.

### CPE remote desktop (noVNC)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/v1/cpe/desktop` | `{enabled, max_sessions, active, require_ticket}` |
| `POST` | `/api/v1/cpe/desktop/sessions` | Body `{"router_id","ticket_id?"}` → session JSON |
| `GET` | `/api/v1/cpe/desktop/sessions` | List (own / admin all) |
| `GET` | `/api/v1/cpe/desktop/sessions/{id}` | Status (updates idle activity) |
| `DELETE` | `/api/v1/cpe/desktop/sessions/{id}` | Teardown |
| `GET` | `/api/v1/cpe/desktop/vnc/{id}` | **WebSocket** reverse-proxy to loopback websockify |

```text
ws(s)://<host>/api/v1/cpe/desktop/vnc/<session_id>
```

Session JSON fields used by SPA: `id`, `router_id`, `state`, `vnc_ws_path`,
`vnc_port`, `throttled`, `lan_ip`, `idle_timeout_s`, `ticket_id`, `error`.

SPA: `public/desktop/` (noVNC RFB from CDN `@novnc/novnc`; optional vendor under
`public/desktop/novnc/`). Clipboard **disabled** in embed. Deep link:
`/desktop/?router_id=cpe-lab&ticket_id=&auto=1`.

RBAC: `EDGE_RES_CPE_DESKTOP` (employee_admin; employee if
`plugins.cpe_desktop.allow_employee`). Concurrent with shell; exclusive with
staff SFTP/TUN/TAP bridge. Design:
`edgehost/docs/designs/remote-troubleshooting-desktop.md`.

Exact query parameters and JSON fields evolve with edgehost handlers; when the
SPA depends on a field, note it here or in a page guide under `docs/guides/`.

## Packages / map data

Large basemap tiles may be served under `/map/…` (linked demo assets) or
`/packages/`. Auth for map data is currently UI-gated; hardening belongs in
edgehost + an edge-web decision when routes change.

## Inventory (browser-facing)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/inventory/locations.json` | Premise list (`v`, `locations[]`) — ADR-006 |

## Map dynamic state

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/state/map.dynamic` | List keys (`?prefix=`) |
| GET/PUT/DELETE | `/api/v1/state/map.dynamic/{key}` | Feature JSON (geom Point/LineString/…) |
| WS | `/api/v1/stream?topics=state` | `STATE_CHANGED` for `map.dynamic` |

Map boot defaults `?feed=` to that WebSocket URL (libwebmap dynamic_feed).

## Operator context (browser-only)

Not an edgehost API — client state for which premise/CPE the UI is focused on.
See [guides/operator-context.md](../guides/operator-context.md) and ADR-003.

| Query param | Meaning |
|-------------|---------|
| `location` | Premise id (`locationId`) |
| `router_id` | Telemetry CPE key (overrides catalog CPE when both set) |

`EdgeContext` also persists to `localStorage` (`edge-web-context-v1`) and paints
the shell top-bar picker.
