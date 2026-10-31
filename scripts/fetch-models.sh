#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="Ceva-IP/DPDFNet"
REVISION="dd6818d00f50c836fed43a6243ebe49116de5964"
MIRROR="https://github.com/HighWatersDev/music-filter/releases/download/dpdfnet-dd6818d"
DEST="$ROOT/extension/assets"
MODELS="
dpdfnet4 42a386d3601922f474c4309927e1f471cce422e9bd8e3fd3967bb943bac36c01
dpdfnet2 4f0ee28935b4a32abecc717d745416976565834d839601acf43031094b4dc94c
"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"

sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }

echo "$MODELS" | while read -r name expected; do
  [ -n "$name" ] || continue
  target="$DEST/$name.onnx"
  if [ -f "$target" ] && [ "$(sha256 "$target")" = "$expected" ]; then
    echo "$name.onnx: present, sha256 ok"
    continue
  fi
  fetched=""
  for url in "$MIRROR/$name.onnx" "https://huggingface.co/$REPO/resolve/$REVISION/onnx/$name.onnx"; do
    rm -f "$WORK/$name.onnx"
    if ! curl --fail --location --silent --show-error --proto '=https' --max-filesize 67108864 \
      --output "$WORK/$name.onnx" "$url"; then
      echo "$name.onnx: download failed from $url" >&2
      continue
    fi
    actual="$(sha256 "$WORK/$name.onnx")"
    if [ "$actual" != "$expected" ]; then
      echo "$name.onnx: sha256 mismatch from $url, expected $expected, got $actual" >&2
      continue
    fi
    fetched="$url"
    break
  done
  if [ -z "$fetched" ]; then
    echo "$name.onnx: no source had a matching file" >&2
    exit 1
  fi
  mv "$WORK/$name.onnx" "$target"
  echo "$name.onnx: $(wc -c < "$target" | tr -d ' ') bytes, sha256 ok, from $fetched"
done
