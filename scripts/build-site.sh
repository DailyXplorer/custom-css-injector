#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT_DIR="${1:-dist/site}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/fonts"
cp -R site/. "$OUT_DIR/"
cp -R assets/fonts/telegraf "$OUT_DIR/fonts/telegraf"
cp icons/icon48.png "$OUT_DIR/icon48.png"

echo "Built $OUT_DIR"
