# Status map — live feed and location highlight

## Default live feed

When you open `/map/` without a `feed` query param, **map_boot.js** sets:

```text
?feed=ws://<host>/api/v1/stream?topics=state
```

(or `wss://` on HTTPS). libwebmap’s `dynamic_feed.js` consumes edgehost
`STATE_CHANGED` frames for namespace **`map.dynamic`**.

| Query | Effect |
|-------|--------|
| (omit `feed`) | Live WS to edgehost state stream |
| `?feed=0` | Dynamic layer off |
| `?feed=./dynamic/sample_events.jsonl` | Offline fixture replay |
| `?feed=ws://…` | Custom WebSocket |

## Inventory seed

On map load, catalog premises with `lon`/`lat` are **PUT** into:

```text
map.dynamic / feature/premise/{locationId}
```

as Point features (`class: premise`). The selected EdgeContext location is
also written to:

```text
map.dynamic / feature/focus/selected
```

(`class: focus`, status `degraded` for visibility). Changing location in the
shell (or devices) re-PUTs the focus key; WS fans out to the open map.

## Basemap: Shortbread vs Google Satellite

The map sidebar **Basemap** panel (and `basemap_config.js`) selects:

| Choice | What you see |
|--------|----------------|
| **Shortbread vector** | Local Oklahoma Shortbread `.wmap` package (no API key) |
| **Google Satellite** | Google Map Tiles API orthophoto (API key required) |
| **Google + Shortbread** | Aerial under vector roads + fiber |
| **Esri imagery** | Lab fallback without a Google key |

1. Enable **Map Tiles API** on a Google Cloud API key.
2. Paste the key in the sidebar → **Apply basemap** (optional: remember in browser).
3. Or use query: `?basemap=google_satellite` with key stored via the panel, or
   one-shot `?gmaps_key=AIza…` (prefer not to bookmark keys).

## Satellite basemap + Calix subscribers (libwebmap ADR-028)

libwebmap supports aerial imagery and full-territory subscriber markers without
stuffing every premise into `map.dynamic` (~1k key budget):

| Query | Effect |
|-------|--------|
| `?basemap=shortbread` | Shortbread `.wmap` (default) |
| `?basemap=google_satellite` | Google Satellite only |
| `?basemap=google_hybrid` | Google under + Shortbread + fiber |
| `?basemap=esri` | Esri World Imagery |
| `?subscribers=0` | Hide Calix premise markers |
| `?subscribers=./subscribers/sample_package.json` | Small fixture |

Full package: `map/subscribers/package.json` (linked from libwebmap demo;
build with `libwebmap/tools/calix_subscribers_package.py` from the anonymized
Calix extract). Marker color = ONT state: **green** connected, **red**
disconnected, **orange** dying gasp.

### Live ONT status from edgehost (FSAN join)

edgehost puts/updates:

```text
map.dynamic / feature/ont/{fsan}     # fsan lowercase in key (state rules)
```

with JSON like:

```json
{
  "id": "CXNK00A1B2C3",
  "class": "fiber_cpe",
  "status": "ok",
  "fsan": "CXNK00A1B2C3",
  "ont_id": "1/1/3/12",
  "shelf_id": "00:02:5d:…",
  "rx_dbm": "-19.0",
  "tx_dbm": "2.0",
  "ne_rx_dbm": "-21.0",
  "bip_us": "0",
  "bip_ds": "0",
  "source": "show-ont"
}
```

Soft ONT errors (Calix **`ont-us-sdber`**, `ont-ds-sdber`, BIP/missed-burst
alarms) add `error_event` + `flash_until` (epoch ms, 60s from the raise). The
subscriber marker **pulses for one minute** on `/map/` without painting the
ONT down. Clears write `flash_until: "0"`. Show-ont rewrites preserve an
unexpired `flash_until`.

Popup **Optical (dB)** / **Errors** come from show-ont fields on this key
(or from `GET /api/v1/map/ont-status` hydrate / Postgres `details`). Compact
status-only writers (link events, older NOTIFY) must not strip those fields.

| Source | When |
|--------|------|
| **show-ont** baseline | Each ONT with a FSAN after Call Home open |
| **lab.v1 / notification** | ONT events with `<fsan>` (or vendor+serial), or FSAN looked up from prior `net.pon` |
| **Postgres later** | `ont_status` NOTIFY → same key shape |

libwebmap `subscriber_layer` matches `fsan` / key `feature/ont/{FSAN}` and
recolors the premise marker. GPS stays in the static package.

See libwebmap [satellite-subscribers guide](../../../libwebmap/docs/guides/satellite-subscribers.md).

## Context chrome

Map top bar shows the active location/CPE label and deep-links to Graphs /
Host / Devices with context query params.

## Requirements

- edgehost serving `spa.root` = edge-web `public/`
- `map.dynamic` namespace **enabled** in YAML
- Session (or `auth.mode: open`) so state PUT and WS stream work
- libwebmap demo assets linked (`run-status-map*.sh`)

## Verify

```bash
cd ~/edgehost && ./scripts/run-status-map-junos.sh
# Browser: /map/  → Dynamic feed HUD shows mode ws
# Select a location on /devices/ → return to /map/ → focus point updates
# curl -sS -b cookies.txt http://127.0.0.1:18080/api/v1/state/map.dynamic
```
