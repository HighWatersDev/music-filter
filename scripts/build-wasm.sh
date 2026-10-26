#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DF_REF="${DF_REF:-d375b2d8309e0935d165700c91da9de862a99c31}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Homebrew's rustup is keg-only, so its cargo/rustc are not on PATH by default.
for dir in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin"; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH

mkdir "$WORK/DeepFilterNet"
cd "$WORK/DeepFilterNet"
git init --quiet
git remote add origin https://github.com/Rikorose/DeepFilterNet.git
git fetch --depth 1 origin "$DF_REF"
git checkout --quiet FETCH_HEAD
cd libDF

RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals" \
  wasm-pack build --target web --release --features wasm

test -f pkg/df.js || { echo "expected pkg/df.js, got:"; ls pkg; exit 1; }

# DeepFilterNet3 only feeds bench/node-bench.mjs now, so it stays out of the extension package.
mkdir -p "$ROOT/vendor/df"
cp pkg/df.js "$ROOT/vendor/df/df.js"
cp pkg/df_bg.wasm "$ROOT/vendor/df/df_bg.wasm"
cp ../models/DeepFilterNet3_onnx.tar.gz "$ROOT/vendor/df/DeepFilterNet3_onnx.tar.gz"

{
  echo "repo: https://github.com/Rikorose/DeepFilterNet"
  echo "commit: $(git rev-parse HEAD)"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "wasm bytes: $(wc -c < pkg/df_bg.wasm | tr -d ' ')"
  echo "model bytes: $(wc -c < ../models/DeepFilterNet3_onnx.tar.gz | tr -d ' ')"
  echo "rustc: $(rustc --version)"
  echo "wasm-pack: $(wasm-pack --version)"
  echo "wasm sha256: $(shasum -a 256 pkg/df_bg.wasm | cut -d ' ' -f 1)"
  echo "model sha256: $(shasum -a 256 ../models/DeepFilterNet3_onnx.tar.gz | cut -d ' ' -f 1)"
} > "$ROOT/vendor/df/SOURCE"

cat "$ROOT/vendor/df/SOURCE"
