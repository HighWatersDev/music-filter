#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/test/fixtures" "$ROOT/test-page/fixtures"

opus() {
  local seconds="$1" out="$2"
  shift 2
  ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=${seconds}:sample_rate=48000" \
    -ac 2 -c:a libopus -b:a 96k -f webm "$@" "$out"
}

opus 12 "$ROOT/test/fixtures/tone-12s.webm"
opus 6 "$ROOT/test/fixtures/tone-live-6s.webm" -live 1
opus 60 "$ROOT/test/fixtures/tone-60s.webm" -b:a 24k
opus 60 "$ROOT/test-page/fixtures/tone-60s.webm"

TMP="$(mktemp -d)"
JOIN_SOURCE="sine=frequency=440:duration=6:sample_rate=48000"
ffmpeg -v error -y -f lavfi -i "$JOIN_SOURCE" -t 3 -ac 2 -c:a libopus -b:a 24k -f webm "$TMP/a.webm"
ffmpeg -v error -y -f lavfi -i "$JOIN_SOURCE" -ss 3 -ac 2 -c:a libopus -b:a 24k -output_ts_offset 3 -f webm "$TMP/b.webm"
cat "$TMP/a.webm" "$TMP/b.webm" > "$ROOT/test/fixtures/tone-join-6s.webm"
rm -r "$TMP"
ls -la "$ROOT/test/fixtures" "$ROOT/test-page/fixtures"
