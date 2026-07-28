# AGENTS.md — edge-web

## What this is

**edge-web** is the Edge Platform **operator / lab browser UI**:

- Static multi-page SPA (HTML + JS + CSS), no build step required for lab
- Served by **edgehost** (`spa.root` → this repo’s `public/`)
- Talks to edgehost over **REST** and **WebSockets** only (never opens
  Postgres or ClickHouse directly)
- Owns **browser interaction design** and product decisions for the site

Sibling **edgehost** owns sockets, auth, state store, CPE telemetry proxy,
ClickHouse batching, Postgres NOTIFY apply, and REST/WS handlers.

## Layout

```text
public/              — document root (paths map 1:1 to URLs)
docs/decisions/      — ADRs for UI / product (write when work lands)
docs/interfaces/     — data-exchange contracts (consumer view)
docs/guides/         — feature how-tos
scripts/             — link demo assets (libwebmap, libanim)
```

## Language / toolchain

- Vanilla JS (ES5-compatible lab style in existing pages; evolve deliberately)
- No required bundler for lab; optional tooling may land later with an ADR
- WebGPU preferred for charts/map; Canvas2D fallback where implemented

## Key commands

```bash
# Link optional demo assets (map / explain) into public/
./scripts/link-demo-assets.sh

# Serve via edgehost (preferred lab path)
cd ~/edgehost
EDGE_WEB_ROOT=$HOME/edge-web/public ./scripts/run-status-map.sh
```

## Directives

- **Must** treat edgehost as the only backend the browser talks to.
- **Must** use **WebSockets** for subscribe / notify style transfers
  (Postgres NOTIFY → state → WS; ClickHouse series → periodic WS push).
- **Must not** embed DB credentials or query ClickHouse/Postgres from the browser.
- **Must** keep wire contracts in `docs/interfaces/` in sync when changing
  `ws_mux.js` or page adapters that assume PDU shapes.
- **Must** write ADRs under `docs/decisions/` when a real UI decision lands
  (no empty stub ADRs).
- **Must not** vendor large map/basemap trees; link from `~/libwebmap/demo` via
  `scripts/link-demo-assets.sh`.
- Prefer editing **product/UX** here; change edgehost only when the contract or
  server handler must change.

## Related

| Path | Use |
|------|-----|
| `~/edgehost` | Static server, REST, WS, CH/PG integration |
| `~/netforensics` | `cpe_agent` emit formats |
| `~/libwebmap` | Map demo / WASM / basemap packages |
| `~/libanim` | Explain player demo / templates |
| `~/ecoec-mobile` | Mobile WebView clients (separate track) |
