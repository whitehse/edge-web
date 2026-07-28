#!/usr/bin/env bash
# Symlink libwebmap / libanim demo assets into public/ (not vendored in git).
#
# Usage:
#   ./scripts/link-demo-assets.sh
#   LIBWEBMAP_DEMO=/path/to/demo LIBANIM_ROOT=/path/to/libanim ./scripts/link-demo-assets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="${EDGE_WEB_ROOT:-$ROOT/public}"
DEMO="${LIBWEBMAP_DEMO:-$HOME/libwebmap/demo}"
ANIM="${LIBANIM_ROOT:-$HOME/libanim}"

link_or_refresh() {
  local target="$1"
  local linkpath="$2"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    echo "  skip (missing): $target"
    return 0
  fi
  if [[ -L "$linkpath" || -e "$linkpath" ]]; then
    rm -rf "$linkpath"
  fi
  ln -s "$target" "$linkpath"
  echo "  linked $linkpath → $target"
}

echo "==> edge-web demo assets"
echo "    public: $PUBLIC"
echo "    libwebmap demo: $DEMO"
echo "    libanim: $ANIM"

MAP_DIR="$PUBLIC/map"
EXPLAIN_DIR="$PUBLIC/explain"
mkdir -p "$MAP_DIR" "$EXPLAIN_DIR/player" "$EXPLAIN_DIR/fixtures" \
  "$EXPLAIN_DIR/templates" "$PUBLIC/documentation/lessons"

if [[ -d "$DEMO" ]]; then
  echo "==> linking libwebmap demo into public/map/"
  link_or_refresh "$DEMO/main.js" "$MAP_DIR/main.js"
  link_or_refresh "$DEMO/display" "$MAP_DIR/display"
  link_or_refresh "$DEMO/webmap.wasm" "$MAP_DIR/webmap.wasm"
  link_or_refresh "$DEMO/basemap" "$MAP_DIR/basemap"
  link_or_refresh "$DEMO/fiber_data" "$MAP_DIR/fiber_data"
  link_or_refresh "$DEMO/tiles_fiber" "$MAP_DIR/tiles_fiber"
  [[ -d "$DEMO/weather" ]] && link_or_refresh "$DEMO/weather" "$MAP_DIR/weather"
  [[ -d "$DEMO/dynamic" ]] && link_or_refresh "$DEMO/dynamic" "$MAP_DIR/dynamic"
  [[ -d "$DEMO/splice_diagrams" ]] && link_or_refresh "$DEMO/splice_diagrams" "$MAP_DIR/splice_diagrams"
else
  echo "warning: libwebmap demo not found at $DEMO (set LIBWEBMAP_DEMO)"
fi

if [[ -d "$ANIM" ]]; then
  echo "==> linking libanim demo into public/explain/"
  [[ -f "$ANIM/demo/demo.js" ]] && link_or_refresh "$ANIM/demo/demo.js" "$EXPLAIN_DIR/player/demo.js"
  [[ -f "$ANIM/demo/index.html" ]] && link_or_refresh "$ANIM/demo/index.html" "$EXPLAIN_DIR/player/index.html"
  for f in optical_path.anim outage_story.anim two_port_tap.anim; do
    [[ -f "$ANIM/fixtures/$f" ]] && link_or_refresh "$ANIM/fixtures/$f" "$EXPLAIN_DIR/fixtures/$f"
  done
  [[ -f "$ANIM/fixtures/two_port_tap.anim" ]] && \
    link_or_refresh "$ANIM/fixtures/two_port_tap.anim" \
      "$PUBLIC/documentation/lessons/two_port_tap.anim"
  [[ -f "$ANIM/demo/templates/two_port_tap.tmpl" ]] && \
    link_or_refresh "$ANIM/demo/templates/two_port_tap.tmpl" \
      "$EXPLAIN_DIR/templates/two_port_tap.tmpl" || true
else
  echo "warning: libanim not found at $ANIM (set LIBANIM_ROOT)"
fi

echo "==> done"
