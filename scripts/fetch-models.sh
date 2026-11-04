#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASES="https://github.com/HighWatersDev/music-filter/releases/download"
DPDFNET_HF="https://huggingface.co/Ceva-IP/DPDFNet/resolve/dd6818d00f50c836fed43a6243ebe49116de5964/onnx"
DEST="$ROOT/extension/assets"
# file, sha256, then sources in order of preference
MODELS="
dpdfnet4.onnx 42a386d3601922f474c4309927e1f471cce422e9bd8e3fd3967bb943bac36c01 $RELEASES/dpdfnet-dd6818d/dpdfnet4.onnx $DPDFNET_HF/dpdfnet4.onnx
dpdfnet2.onnx 4f0ee28935b4a32abecc717d745416976565834d839601acf43031094b4dc94c $RELEASES/dpdfnet-dd6818d/dpdfnet2.onnx $DPDFNET_HF/dpdfnet2.onnx
music-detector-mn05.onnx 36cec66ebc5c2955fb33e815fb858841f69c273e2b2d290193ee59b80ee9c166 $RELEASES/music-detector-mn05-a425fdc/music-detector-mn05.onnx
"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"

sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }

echo "$MODELS" | while read -r file expected urls; do
  [ -n "$file" ] || continue
  target="$DEST/$file"
  if [ -f "$target" ] && [ "$(sha256 "$target")" = "$expected" ]; then
    echo "$file: present, sha256 ok"
    continue
  fi
  fetched=""
  for url in $urls; do
    rm -f "$WORK/$file"
    if ! curl --fail --location --silent --show-error --proto '=https' --max-filesize 67108864 \
      --output "$WORK/$file" "$url"; then
      echo "$file: download failed from $url" >&2
      continue
    fi
    actual="$(sha256 "$WORK/$file")"
    if [ "$actual" != "$expected" ]; then
      echo "$file: sha256 mismatch from $url, expected $expected, got $actual" >&2
      continue
    fi
    fetched="$url"
    break
  done
  if [ -z "$fetched" ]; then
    echo "$file: no source had a matching file" >&2
    exit 1
  fi
  mv "$WORK/$file" "$target"
  echo "$file: $(wc -c < "$target" | tr -d ' ') bytes, sha256 ok, from $fetched"
done
