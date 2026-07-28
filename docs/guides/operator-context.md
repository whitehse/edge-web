# Operator context (location → CPE)

## What it is

A **shared focus** for the signed-in operator: which member premise and which
CPE telemetry id (`router_id`) subsequent pages should use.

| Field | Role |
|-------|------|
| `locationId` | Premise id from the catalog / inventory |
| `routerId` | ClickHouse / WS filter (`router_id`) |
| `ontId` | ONT id when known |
| `label` | Human label (address) |

## Where to set it

1. **Shell top bar** — Location select + CPE text field + Clear  
2. **Locations & devices** — Opening a premise sets context  
3. **Home** device cards — same  
4. **Deep link** — `?location=loc-north-12` and/or `?router_id=router`  
5. Page-local CPE fields (host / flows / graphs) — write back into context  

## Lab mapping

| Location | `router_id` | Notes |
|----------|-------------|--------|
| 12 North Ridge Rd (`loc-north-12`) | `router` | Typical live lab agent id |
| Other demo premises | `cpe-elm`, `cpe-pine`, `cpe-meadow` | Demo only unless agents post under those ids |

Override CPE anytime by typing in the shell CPE field.

## Persistence

- `localStorage` key `edge-web-context-v1`
- URL query params updated via `history.replaceState` (other params preserved)

## Scripts

```html
<script src="/app.js"></script>
<script src="/context_catalog.js"></script>
<script src="/context.js"></script>
<script src="/shell.js"></script>
```

API: `window.EdgeContext` — `get`, `set`, `setFromLocation`, `setRouter`,
`clear`, `routerId`, `onChange`, `hrefWithContext`.

## Empty state

Telemetry pages show a banner when no `routerId` is set, instead of a silent
“Waiting for samples” with no CPE chosen.
