#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DOC="${1:-$ROOT_DIR/docs/architecture-c4.md}"
OUT_DIR="${2:-$ROOT_DIR/docs/c4}"
SRC_DIR="$OUT_DIR/src"
RENDER_DIR="$OUT_DIR/rendered"

if [[ ! -f "$SOURCE_DOC" ]]; then
  echo "Source file not found: $SOURCE_DOC" >&2
  exit 1
fi

if command -v mmdc >/dev/null 2>&1; then
  RENDER_CMD=(mmdc)
elif command -v npx >/dev/null 2>&1; then
  RENDER_CMD=(npx -y @mermaid-js/mermaid-cli)
else
  echo "Mermaid renderer not found. Install @mermaid-js/mermaid-cli or make npx available." >&2
  exit 1
fi

mkdir -p "$SRC_DIR" "$RENDER_DIR"
find "$SRC_DIR" -type f -name '*.mmd' -delete
find "$RENDER_DIR" -type f \( -name '*.svg' -o -name '*.png' \) -delete

awk '
/```mermaid/ { in_block=1; idx++; next }
/```/ { if (in_block) { in_block=0; next } }
in_block { print > (outdir "/diagram-" idx ".mmd") }
' outdir="$SRC_DIR" "$SOURCE_DOC"

count="$(find "$SRC_DIR" -type f -name '*.mmd' | wc -l | tr -d ' ')"
if [[ "$count" -eq 0 ]]; then
  echo "No Mermaid blocks found in: $SOURCE_DOC" >&2
  exit 1
fi

for file in "$SRC_DIR"/*.mmd; do
  base="$(basename "$file" .mmd)"
  "${RENDER_CMD[@]}" -i "$file" -o "$RENDER_DIR/$base.svg"
  "${RENDER_CMD[@]}" -i "$file" -o "$RENDER_DIR/$base.png" -w 1920 -H 1080
done

{
  echo "# C4 / Mermaid Diagram Renders"
  echo
  echo "Source: \`$SOURCE_DOC\`"
  echo
  echo "## Rendered diagrams"
  echo
  i=1
  for file in "$RENDER_DIR"/diagram-*.svg; do
    base="$(basename "$file" .svg)"
    echo "$i. $base"
    echo "   - SVG: \`$RENDER_DIR/$base.svg\`"
    echo "   - PNG: \`$RENDER_DIR/$base.png\`"
    i=$((i + 1))
  done
} > "$OUT_DIR/README.md"

echo "Rendered $count Mermaid diagrams to: $RENDER_DIR"
