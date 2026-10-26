#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/native/dpdf"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Homebrew's rustup is keg-only, so its cargo/rustc are not on PATH by default.
for dir in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin"; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH

# Plain RUSTFLAGS would also reach build scripts and proc macros compiled for the host.
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals" \
  wasm-pack build "$CRATE" --target web --release --out-dir "$WORK/pkg" --out-name dpdf -- --locked

test -f "$WORK/pkg/dpdf.js" || { echo "expected dpdf.js, got:"; ls "$WORK/pkg"; exit 1; }

mkdir -p "$ROOT/vendor/dpdf" "$ROOT/extension/assets"
cp "$WORK/pkg/dpdf.js" "$ROOT/vendor/dpdf/dpdf.js"
cp "$WORK/pkg/dpdf_bg.wasm" "$ROOT/extension/assets/dpdf_bg.wasm"

sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
{
  echo "crate: native/dpdf"
  echo "commit: $(git -C "$ROOT" rev-parse HEAD)$([ -z "$(git -C "$ROOT" status --porcelain -- native/dpdf)" ] || echo ' (native/dpdf has uncommitted changes)')"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "rustc: $(rustc --version)"
  echo "cargo: $(cargo --version)"
  echo "wasm-pack: $(wasm-pack --version)"
  echo "tract-onnx: $(grep -A1 '^name = "tract-onnx"$' "$CRATE/Cargo.lock" | sed -n 's/version = "\(.*\)"/\1/p')"
  echo "wasm-bindgen: $(grep -A1 '^name = "wasm-bindgen"$' "$CRATE/Cargo.lock" | sed -n 's/version = "\(.*\)"/\1/p')"
  echo "target features: +simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals"
  echo "wasm bytes: $(wc -c < "$WORK/pkg/dpdf_bg.wasm" | tr -d ' ')"
  echo "wasm sha256: $(sha256 "$WORK/pkg/dpdf_bg.wasm")"
  echo "js sha256: $(sha256 "$WORK/pkg/dpdf.js")"
} > "$ROOT/vendor/dpdf/SOURCE"

cat "$ROOT/vendor/dpdf/SOURCE"
