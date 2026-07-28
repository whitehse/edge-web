# edge-web

Operator and lab **web frontend** for the Edge Platform.

Static HTML/CSS/JS (and small WASM helpers) served by **[edgehost](https://github.com/whitehse/edgehost)**
via `spa.root`. This repo owns browser UX, page structure, and the **consumer
view** of live data contracts. edgehost owns HTTP/WebSocket serving, auth,
CPE ingest, ClickHouse batching, and Postgres NOTIFY apply.

## Quick start (lab)

Sibling layout expected under `$HOME` (or set env vars):

```text
~/edgehost/     # API + static file server
~/edge-web/     # this repo (spa.root → public/)
~/libwebmap/    # map demo assets (optional, linked at run time)
~/libanim/      # explain player demo assets (optional)
```

```bash
# From edgehost — links map/explain demo assets into this tree, starts server:
cd ~/edgehost
EDGE_WEB_ROOT=$HOME/edge-web/public ./scripts/run-status-map.sh

# Browser
#   http://127.0.0.1:18080/      login (password: lab)
#   http://127.0.0.1:18080/map/  status map
#   http://127.0.0.1:18080/graphs/
```

edgehost YAML:

```yaml
spa:
  root: ../edge-web/public   # or absolute path to this repo's public/
  max_file_bytes: 33554432   # map tiles / path_index
```

## Layout

```text
public/                 # Document root served by edgehost (was edgehost/spa)
  index.html            # Home / login shell
  shell.js, app.css     # Shared chrome
  ws_mux.js             # Multiplexed WebSocket client (EdgeMux)
  map/ graphs/ host/ …  # Feature pages
docs/
  decisions/            # Browser / product ADRs (flesh out as the site evolves)
  interfaces/           # Data-exchange contracts (browser consumer view)
  guides/               # How-tos for UI features
scripts/
  link-demo-assets.sh   # Symlink libwebmap / libanim demos into public/
```

## Docs

| Doc | Role |
|-----|------|
| [AGENTS.md](AGENTS.md) | Agent entry: identity, rules, commands |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, serving model, data plane overview |
| [TODO.md](TODO.md) | Living redesign checklist |
| [docs/interfaces/](docs/interfaces/) | CPE / DB / browser exchange contracts |
| [docs/decisions/](docs/decisions/) | UI and product decisions |
| [docs/DOMAIN.md](docs/DOMAIN.md) | Glossary |

Authoritative **server** schemas and ingest implementation live in edgehost
(`sql/`, `src/host/`, `docs/guides/clickhouse.md`). CPE agent emit formats live
in netforensics (`docs/guides/cpe-agent-*.md`). This repo documents the **wires
the browser depends on** and keeps room for site-level product decisions.

## License

MIT (same family as edgehost / sibling libraries).
