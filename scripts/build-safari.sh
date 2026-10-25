#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/safari"

rm -rf "$OUT"
mkdir -p "$OUT"
xcrun safari-web-extension-converter "$ROOT/extension" \
  --project-location "$OUT" \
  --app-name "Music Filter" \
  --bundle-identifier "dev.musicfilter.spike" \
  --swift \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force
