# Graphs ↔ host / flows series parity (G3 / B.5)

Verification checklist for WebGPU graphs workspace vs specialized pages.

## Series (must load without empty hard-fail when CPE has data)

| Graph type id | Host/flows source | Status |
|---------------|-------------------|--------|
| `host.cpu` | `/host/` CPU cores | mux + REST |
| `host.mem` | `/host/` memory | mux + REST |
| `host.net` | `/host/` net rate | mux + REST |
| `host.load` | `/host/` loadavg | mux + REST |
| `wifi.radio` | `/host/` radio health | mux + REST |
| `wifi.band` | `/host/` band filter | derived |
| `wifi.client` | `/host/` client coverage | stations/series REST |
| **`wifi.fw`** | `/host/` QDF fw (`/api/v1/cpe/wifi/fw`) | **REST adapter (G1)** |
| `flow.overlay` | `/flows/` | REST |
| `flow.stream` | `/flows/` single | REST |
| `flow.defects` | `/flows/` defects | REST |

## Interactions (B.5)

- [ ] Wheel zoom; pan exits live
- [ ] Scrub; Live / `L` / double-click
- [ ] Time presets (10m … 48h)
- [ ] Stale chip when push age > threshold
- [ ] WebGPU chip + Canvas2D fallback
- [ ] Layout persistence (`layout_store`)
- [ ] Deep link `?panels=host.cpu,wifi.fw`

## Live pipeline notes

- Host/wifi radio/band use shared mux watch + `ensureFeed` (same as `/host/`).
- `wifi.fw` and flow/client panels use **panel REST poll** on the adapter interval (G2).
- Lead-time morph vs host half-life may differ slightly; overlapping series keys should track midpoints within ε over 60s when both views are open.

## Manual smoke

1. Lab login → Graphs → Apply CPE `cpe-lab` (or live agent id).
2. Add panels: CPU, wifi.radio, **wifi.fw**, flow.overlay.
3. Confirm WebGPU render chip; toggle layout save/reload.
