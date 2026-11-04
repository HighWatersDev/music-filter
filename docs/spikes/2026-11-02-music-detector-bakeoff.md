# Music detector bake-off

Date: 2026-11-02
Question: which detector, input and threshold should gate music-gated passthrough (`plans/2026-11-02-music-gated-passthrough-design.md`)?
Scope: test only. Nothing in `src/` or `extension/` changed.

## Verdict

**EfficientAT mn05_as, 2 s window, run on the DPDFNet residual (original minus filtered), "Music" class, threshold 0.05.**

On 21 minutes of music under speech it let 27.5 s of music through, in 16 separate leaks. Almost all of it was music at least 25 dB quieter than the speech. It played the original for 47% of the sound effects in music-free parts.

- EfficientAT beats YAMNet at every threshold and on every input.
- Running the detector on the residual instead of the full audio roughly halves the leaks. Speech no longer masks quiet music for the detector.
- No setting gives zero leaks while keeping most effects. The threshold sets the trade-off.
- A 4 s window is about the same as 2 s and costs twice as much per frame.

## Results

"Let through" is the share of music time where the gate played the original, split by music level relative to speech. "Effects kept" is the share of effect time in music-free parts where the gate played the original. Gate rule: every 0.5 s frame within ±1.5 s must be below the threshold.

EfficientAT mn05, 2 s window:

| Input | Threshold | ≥-15 dB | -15 to -25 | -25 to -35 | Music let through | Leaks | Effects kept |
|---|---|---|---|---|---|---|---|
| Full mix | 0.05 | 0% | 5.1% | 15.4% | 56 s | 26 | 47% |
| Full mix | 0.1 | 0.3% | 7.1% | 26.4% | 92.5 s | 33 | 64% |
| **DPDFNet residual** | **0.05** | **0%** | **1.8%** | **8.5%** | **27.5 s** | **16** | **47%** |
| DPDFNet residual | 0.1 | 0.3% | 5.6% | 14.8% | 58 s | 27 | 60% |
| Exact effects + music (upper bound) | 0.05 | 0% | 1.1% | 4.1% | 14 s | 9 | 42% |
| Exact effects + music (upper bound) | 0.1 | 0% | 3.0% | 8.1% | 30.5 s | 18 | 60% |

DPDFNet residual, other thresholds:

| Threshold | Music let through | Leaks | Effects kept |
|---|---|---|---|
| 0.02 | 6 s | 4 | 18% |
| 0.05 | 27.5 s | 16 | 47% |
| 0.1 | 58 s | 27 | 60% |
| 0.2 | 83.5 s | 41 | 70% |

**Shipped detector.** The extension's detector (Rust and tract in `dpdf_bg.wasm`, its own 48 to 32 kHz resampler and spectrogram) gave the same result on the DPDFNet residual at 0.05 on 2026-11-04: 27.5 s let through, 16 leaks, 47% of effects kept. Other thresholds differ by at most 1.5 s of leaks. It matches PyTorch to 6 decimals on the reference clip in `native/dpdf/tests/music-detector-ref.txt`. In Node 24 on the M2 Pro it costs 51 ms per second of audio, single thread. With 2.5 s of context on each side of a 10 s window, that is about 77 ms per second of playback, against 250 ms for DPDFNet-4.

YAMNet ("Music" class) on the DPDFNet residual at 0.05 let 154 s through in 51 leaks, with 47% of quiet music (-25 to -35 dB) let through. It is not a candidate.

Full tables for every detector, input and threshold are in `listening/detector/report-*.json` (not committed) and reproduce with the scripts below.

## Test set

40 scenes of 56 s (37 minutes). Each scene has 8 segments of 7 s, chosen at random from speech only, speech + effect, effect only, speech + music, speech + effect + music, music only and effect + music.

| Part | Source | Level |
|---|---|---|
| Speech | LibriSpeech test-clean, one speaker per scene | -26 dBFS active level |
| Effects | ESC-50, all 50 classes | Speech ±6 dB |
| Music | MUSDB18 (150 tracks): accompaniment, the "other" stem alone, or the full song with vocals. A third of clips fade in over 3 s. | 0, -10, -20 or -30 dB relative to speech |

Music seconds per level bucket: 649 (≥-15 dB), 332 (-15 to -25), 253.5 (-25 to -35), 38.5 (-35 to -45).

## Limits

- LibriSpeech is 16 kHz. Real YouTube speech has content above 8 kHz that DPDFNet may leave partly in the residual, which could raise the detector's music score on speech. Recheck on real videos once the gate is built.
- Window edges are not modelled. Each scene is scored as one continuous clip.
- ESC-50 effects are short, isolated clips. Film and game effects are often longer and denser.
- Music-like effects (bells, birds, sirens, insects, crickets, alarms) are kept less often (45% at 0.05). That is expected and safe.

## Pinned inputs

| Item | Version |
|---|---|
| EfficientAT | github.com/fschmid56/EfficientAT `a425fdce92572e602a1d5634799bd9f1f2efa806`, MIT. Weights from its v0.0.1 release, no separate terms. |
| mn05_as weights | `mn05_as_mAP_443.pt` SHA-256 `97f00bb717ce957dbdf60c26d4de8b161dd7c2593fbe6424859fad7e5569fd7f` |
| YAMNet | `yamnet.tflite` SHA-256 `10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de` |
| DPDFNet | `extension/assets/dpdfnet4.onnx` and `dpdf_bg.wasm` as of `af5e74e` |
| Python env | Python 3.11.11, torch 2.5.1, torchvision 0.20.1, numpy 2.4.6, soundfile 0.14.0, soxr 1.1.0, ai-edge-litert 2.3.0 |
| Node | 24 |

## Reproduce

Scripts are in `tools/detector-bakeoff/`. Data, models and output go in `listening/detector/` (gitignored): `data/LibriSpeech`, `data/ESC-50-master`, `data/musdb`, `models/yamnet.tflite`, and an `EfficientAT` clone with `resources/mn05_as_mAP_443.pt`.

1. `python build_mixes.py` writes `scenes/NN.wav`, `NN.json` labels and `NN.residual.wav` (exact effects + music).
2. `node residual.mjs` runs DPDFNet-4 and writes `NN.dpdf-residual.wav`. About 14 s per scene on an M2 Pro.
3. `python score.py mix`, `python score.py residual` and `python score.py dpdf-residual` print the tables and write `report-<input>.json`.
4. `node detect.mjs` runs the extension's wasm detector over the DPDFNet residuals, then `python score.py shipped` scores it.

The scenes with residuals take about 1.2 GB.
