# Licence notes

## DPDFNet models

`scripts/fetch-models.sh` downloads two files from the Hugging Face repo [Ceva-IP/DPDFNet](https://huggingface.co/Ceva-IP/DPDFNet) at revision `dd6818d00f50c836fed43a6243ebe49116de5964` (last modified 2026-07-05). It tries an unchanged copy in this repo's GitHub release [`dpdfnet-dd6818d`](https://github.com/HighWatersDev/music-filter/releases/tag/dpdfnet-dd6818d) first, so builds still work if the Hugging Face repo goes away. Both sources must match the SHA-256 below.

| File | Bytes | SHA-256 |
|---|---|---|
| `onnx/dpdfnet4.onnx` | 11633337 | `42a386d3601922f474c4309927e1f471cce422e9bd8e3fd3967bb943bac36c01` |
| `onnx/dpdfnet2.onnx` | 10178747 | `4f0ee28935b4a32abecc717d745416976565834d839601acf43031094b4dc94c` |

Both are the 16 kHz wideband variants. Their metadata says `sample_rate 16000`, `n_fft 320`, `hop_length 160`, and the `spec` input is `[1,1,161,2]`.

Licence, checked 2026-10-26:

- Model card front matter at that revision: `license: apache-2.0`, and its License section says Apache-2.0.
- Code repo [github.com/ceva-ip/DPDFNet](https://github.com/ceva-ip/DPDFNet) (linked from the model card): GitHub reports `Apache-2.0` from its `LICENSE` file. The repo has no `NOTICE` file, so Apache-2.0 section 4(d) adds nothing to ship.

Shipping the models requires a copy of the Apache-2.0 licence and attribution to Ceva in the distributed extension.

## Music detector model

`music-detector-mn05.onnx` is EfficientAT `mn05_as` from [fschmid56/EfficientAT](https://github.com/fschmid56/EfficientAT) at commit `a425fdce92572e602a1d5634799bd9f1f2efa806`. `tools/detector-bakeoff/export_onnx.py` exports it from the weights file `mn05_as_mAP_443.pt` in the repo's [v0.0.1 release](https://github.com/fschmid56/EfficientAT/releases/tag/v0.0.1). The graph adds the mel bank, log and normalisation from the repo's `AugmentMelSTFT`. `scripts/fetch-models.sh` downloads the export from this repo's GitHub release [`music-detector-mn05-a425fdc`](https://github.com/HighWatersDev/music-filter/releases/tag/music-detector-mn05-a425fdc). There is no upstream ONNX to fall back on.

| File | Bytes | SHA-256 |
|---|---|---|
| `mn05_as_mAP_443.pt` (source weights) | 5878097 | `97f00bb717ce957dbdf60c26d4de8b161dd7c2593fbe6424859fad7e5569fd7f` |
| `music-detector-mn05.onnx` | 6021478 | `36cec66ebc5c2955fb33e815fb858841f69c273e2b2d290193ee59b80ee9c166` |

Licence, checked 2026-11-02: GitHub reports `MIT` for the repo, from its `LICENSE` file (Copyright 2022 Florian Schmid). The release that holds the weights states no other terms. The export is repeatable: running the script twice gives the same SHA-256.

## Rust dependencies

`tract-onnx` and its tract crates, `rustfft` and `wasm-bindgen` are each dual-licensed MIT or Apache-2.0. Versions are pinned in `Cargo.lock`. The rest of the tree (`cargo metadata`) is MIT, Apache-2.0, Zlib, Unlicense, BSD-2-Clause or Unicode-3.0, all permissive.
