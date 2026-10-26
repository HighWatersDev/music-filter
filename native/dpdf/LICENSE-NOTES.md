# Licence notes

## DPDFNet models

`scripts/fetch-models.sh` downloads two files from the Hugging Face repo [Ceva-IP/DPDFNet](https://huggingface.co/Ceva-IP/DPDFNet) at revision `dd6818d00f50c836fed43a6243ebe49116de5964` (last modified 2026-07-05).

| File | Bytes | SHA-256 |
|---|---|---|
| `onnx/dpdfnet4.onnx` | 11633337 | `42a386d3601922f474c4309927e1f471cce422e9bd8e3fd3967bb943bac36c01` |
| `onnx/dpdfnet2.onnx` | 10178747 | `4f0ee28935b4a32abecc717d745416976565834d839601acf43031094b4dc94c` |

Both are the 16 kHz wideband variants. Their metadata says `sample_rate 16000`, `n_fft 320`, `hop_length 160`, and the `spec` input is `[1,1,161,2]`.

Licence, checked 2026-10-26:

- Model card front matter at that revision: `license: apache-2.0`, and its License section says Apache-2.0.
- Code repo [github.com/ceva-ip/DPDFNet](https://github.com/ceva-ip/DPDFNet) (linked from the model card): GitHub reports `Apache-2.0` from its `LICENSE` file. The repo has no `NOTICE` file, so Apache-2.0 section 4(d) adds nothing to ship.

Shipping the models requires a copy of the Apache-2.0 licence and attribution to Ceva in the distributed extension.

## Rust dependencies

`tract-onnx` and its tract crates, `rustfft` and `wasm-bindgen` are each dual-licensed MIT or Apache-2.0. Versions are pinned in `Cargo.lock`. The rest of the tree (`cargo metadata`) is MIT, Apache-2.0, Zlib, Unlicense, BSD-2-Clause or Unicode-3.0, all permissive.
