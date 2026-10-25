#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/firefox"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$ROOT/extension/." "$OUT/"
python3 - "$OUT/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest["browser_specific_settings"] = {
    "gecko": {"id": "music-filter-spike@local", "strict_min_version": "128.0"},
    "gecko_android": {"strict_min_version": "128.0"},
}
json.dump(manifest, open(path, "w"), indent=2)
PY
echo "$OUT"
