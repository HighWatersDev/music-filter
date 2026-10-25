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
ls -la "$ROOT/test/fixtures" "$ROOT/test-page/fixtures"
