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

## Newer detectors (2026-11-05)

The first bake-off only tried mn05 and YAMNet. This rerun adds the larger EfficientAT models and CED (Dinkel et al., ICASSP 2024), the strongest small AudioSet taggers found in a November 2026 search. inaVAMOS (INA, September 2026) was left out because its license is research only. LiteCASS still has no released weights.

Same scenes, DPDFNet residual, "Music" class, same gate rule. Thresholds were swept from 0.01 to 0.6 in steps of 0.005, because each model's scores sit at a different level. Each cell is the most effects any threshold keeps while letting at most that much music through. Cost is PyTorch, one thread, M2 Pro. The shipped mn05 costs about twice its PyTorch figure in wasm.

| Detector | AudioSet mAP | Params | ms per s of audio | ≤5 s let through | ≤10 s | ≤20 s | ≤30 s | ≤45 s |
|---|---|---|---|---|---|---|---|---|
| **mn05, 2 s (shipped)** | 44.3 | 1.4 M | 25 | 10% | 25% | 38% | **47%** | 56% |
| mn05, 4 s | 44.3 | 1.4 M | 46 | 12% | 28% | 33% | 44% | 54% |
| mn10, 4 s | 47.1 | 4.9 M | 114 | 20% | 33% | 38% | 45% | 59% |
| dymn10, 2 s | 47.7 | 10.5 M | 65 | 13% | 14% | 38% | 45% | 61% |
| dymn10, 4 s | 47.7 | 10.5 M | 105 | 9% | 26% | 57% | 60% | 64% |
| CED-Tiny, 2 s | 48.1 | 5.5 M | 6 | 10% | 13% | 20% | 28% | 35% |
| CED-Mini, 2 s | 49.0 | 9.7 M | 8 | 14% | 19% | 27% | 32% | 37% |
| CED-Mini, 4 s | 49.0 | 9.7 M | 17 | 20% | 35% | 39% | 42% | 46% |

- A higher AudioSet mAP does not mean a better music gate. Both CED models keep fewer effects than mn05 at the shipped leak level, even though they score higher on AudioSet.
- mn10 gives nonsense on 2 s windows ("Hammer", "Sawing" and "Clickety-clack" at 1.0 on a guitar clip). It needs at least 4 s.
- dymn10 with 4 s windows is the only clear gain: 60% of effects against 47% at the same leak level. It costs about 4 times mn05's compute. The Galaxy A56 is already slightly slower than real time with mn05, so it cannot afford that.
- CED-Mini with 4 s windows is best at tight leak budgets (35% against 25% at 10 s let through) and costs less than mn05. It would suit a stricter setting, not more effects.
- The threshold moves effects kept far more than the choice of detector. mn05 keeps 56% at 45 s let through.

Decision: keep mn05. Revisit dymn10 with 4 s windows if a desktop-only setting is ever wanted. Reproduce with `tools/detector-bakeoff/compare.py`.

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

## Listening

Tested on 2026-11-04 and 2026-11-05 with the switch on. Desktop runs used Chromium with the unpacked extension. Phone runs used a Galaxy A56 with Firefox for Android through `web-ext run`. O means original sound and F means filtered, read from the panel each second.

| Video | Where | Result |
|---|---|---|
| [Arctic Geese Chicks, Hostile Planet](https://www.youtube.com/watch?v=H1S6UCX4RAA) | Desktop and phone | Filtered throughout. Orchestral score under every scene, scores 0.18 to 0.92. Correct. |
| [Fine Dining Kitchen ASMR, no music](https://www.youtube.com/watch?v=cKCoTkzLHa0) | Desktop | O for 2 of about 70 s. Most frames score 0.01 to 0.05, but chops and sizzles spike to 0.1 to 0.57 every few seconds, and each spike keeps 3.5 s filtered. |
| [Finding beauty in the ordinary, silent vlog](https://www.youtube.com/watch?v=0saslFui3fI) | Desktop | O at 3 to 12, 14 to 15, 24 to 25 and 41 to 43 s. |
| Same vlog | Phone | O at 13 to 16, 25 to 29, 39 to 45, 51 to 72 and 80 to 86 s. Quiet stretches score 0.004 to 0.03. The user heard the room sounds and found the changes fine. |
| [The T. rex Escapes the Paddock](https://www.youtube.com/watch?v=Rc_i5TKdmhs) | Desktop | First 44 s, before the score starts: mostly O, scores about 0.01, short F gaps where single frames reach 0.1 to 0.15. |
| [Sound Effects for Movies & Video Games](https://www.youtube.com/watch?v=ktPMqOGXYsY) | Desktop | Music-heavy start scores 0.5 to 0.8 and stays F to 32 s. O at 33 to 35 and 43 s. |
| Same video | Phone | O at 31 to 32, 86 to 87, 92 to 95 and 100 to 109 s, F elsewhere in the first 2 minutes. The effects are played on timpani, cymbals and drums, which the detector mostly hears as music. The user heard some effects and found others filtered. |

- Dense effects often stay filtered even with no music. That is the cost of the 0.05 threshold and the ±3 frame reach.
- The phone took 10.9 to 11.4 s per 10 s window with DPDFNet-2 while gating, slightly slower than real time. The sound effects video paused for about 7 s at 6 s while the filter caught up.
- `web-ext run` starts the add-on with the switch off, so turn it on and reload YouTube after every new run.
- Not yet checked: a long video with clear speech under no music. The T. rex clip likely has dialogue in its first 44 s, but nobody listened to confirm it, so the LibriSpeech caveat is still open.

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
5. `python compare.py cache <detector>` for each name in `DETECTORS`, then `python compare.py report`. It needs a `CED` clone (github.com/RicherMans/CED at `4b2149dc9ba1ed25c6348083f82dba03f00a5022`, code GPL-3.0, weights CC-BY-4.0 from Zenodo record 8275319) beside `EfficientAT`, plus torchaudio 2.5.1, einops 0.8.1 and loguru 0.7.3. Weights download on first use.

The scenes with residuals take about 1.2 GB.
