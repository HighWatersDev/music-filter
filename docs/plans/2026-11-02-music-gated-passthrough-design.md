# Music-gated passthrough

**Status:** built on branch `music-gated-passthrough`, from the plan in `2026-11-02-music-gated-passthrough.md`. Listening results are in `spikes/2026-11-02-music-detector-bakeoff.md`.

**Goal:** keep sound effects and ambient sound in the parts of a video that have no music.

**Why:** DPDFNet keeps voices only, so effects disappear everywhere, even where there is no music to remove. The user noticed this on desktop Chrome on 2026-11-02. A real dialogue / music / effects model is still out of reach. DBS-TIGER is too slow (`spikes/2026-10-30-tiger-browser.md`), and LiteCASS (arXiv 2609.23453), the one fast enough, has no released code or weights. NoNoiseYT gates its speech model on a music detector, and this design does the same.

## Decisions

| Question | Choice | Reason |
|---|---|---|
| Default | Off. A popup switch, "Keep other sounds when there's no music". | Voice-only stays unchanged for users who want no music at all. A missed detection plays music. |
| When it applies | On the next page load. The content script reads the switch once at start. | Switching modes mid-video would mean tearing down a running pipeline. The popup says "Reload YouTube to apply". |
| Mode | When the switch is on, every browser uses read-ahead, desktop included | Detection needs about 1 s of audio. Live mode has about 0.1 s of delay, so music would play for about 1 s at every onset. Read-ahead sees 10 s ahead and switches before music starts. |
| Detector | EfficientAT mn05_as, 2 s window, "Music" class, threshold 0.05, run on the DPDFNet residual | Bake-off in `spikes/2026-11-02-music-detector-bakeoff.md`. It let 2% of music time through, nearly all of it quiet, and kept 47% of effects. |

## How it works

For each read-ahead window the filter worker has the original audio and the DPDFNet output. It runs the music detector on the residual (original minus filtered) and mixes the two. Speech is mostly gone from the residual, so it no longer hides quiet music from the detector.

- Music detected, or unsure: filtered audio, as before.
- Confidently no music: original audio.

**Rule.** The detector gives a music probability every 0.5 s. A frame plays the original only if it and the 3 frames on each side, 3.5 s in all, are below 0.05. A frame the detector cannot score counts as music. Changes fade over 200 ms, and the fades sit inside the open region, so a closed frame always plays fully filtered. DPDFNet still runs on every window, so its recurrent state never jumps.

**Context.** The rule needs 1.5 s of scores on each side, and each score needs 1 s of audio on each side. So each window is filtered together with 2.5 s of audio before and after it (`GATE_CONTEXT` in `src/separator/worker.js`), then trimmed back. The first and last 2.5 s of a video stay filtered. So does the end of a window when the audio after it is not decoded yet.

**Panel.** The worker returns the open ranges in media seconds. The panel shows "Original sound" while the playhead is inside one, and "Filtered" otherwise.

## Detector

EfficientAT mn05_as (github.com/fschmid56/EfficientAT, MIT, weights from its v0.0.1 release). 1.4 M params, 32 kHz mono. It scores a 2 s window centred on each 0.5 s frame. The bake-off also tried YAMNet, which let five times as much music through.

The Rust side resamples 48 kHz to 32 kHz with a Kaiser windowed-sinc filter, applies pre-emphasis 0.97 and computes the STFT power (n_fft 1024, window 800, hop 320). The ONNX file takes that power and holds the mel bank, log and normalisation. Its metadata records the spectrogram settings, and the engine refuses a model whose settings differ.

## Components

| Piece | As built |
|---|---|
| `tools/detector-bakeoff/export_onnx.py`, `make_detector_ref.py` | Export `music-detector-mn05.onnx` from the PyTorch weights, and write the reference scores the Rust test checks |
| `scripts/fetch-models.sh`, `extension/assets/music-detector-mn05.onnx` | The detector ONNX, pinned by SHA-256, fetched from the GitHub release `music-detector-mn05-a425fdc` |
| `native/dpdf/src/music_detector.rs` | Resampler, spectrogram and tract engine. `MusicDetector` is a wasm-bindgen class beside `Dpdf` in the same `dpdf_bg.wasm`. `frame_probabilities` returns one score per 0.5 s frame, NaN where a full window does not fit. |
| `src/pipeline/music-gate.js` | Pure: scores to open frames, open frames to a 0..1 curve, the mix, and the open ranges |
| `src/pipeline/stream-engine.js` | Reads `contextAfter` audio and maps each window's open ranges to media seconds |
| `src/separator/read-ahead-filters.js`, `filter-worker.js`, `filter-pool.js`, `worker.js` | Load the detector beside DPDFNet, filter the window with its context, detect on the residual, mix, and return the open ranges |
| `src/content/settings.js`, `extension/popup.html`, `src/popup/popup.js` | `keepOtherSounds` in `storage.local`, off by default, and its switch |
| `src/content/live-filter.js` | `selectFilterMode` returns read-ahead when `keepOtherSounds` is on |
| `src/content/read-ahead.js`, `panel.js`, `controls-policy.js` | Read the switch at start, pass it to the worker, track open ranges and show "Original sound" |

## Failure

If the detector fails to load, the window plays filtered and the next window tries again. If it throws, the window plays filtered and the wasm instance is dropped, because a wasm trap leaves it unusable. An error never lets music through.

## Tests

- Unit: `test/music-gate.test.js` covers the rule, NaN and edge frames, the fade shape, the mix and the ranges. `read-ahead-filters`, `stream-engine`, `settings` and `controls-policy` tests cover the wiring.
- Rust: the resampler, parity with PyTorch on the reference clip, NaN frames at the edges, and metadata checks.
- `tools/detector-bakeoff/detect.mjs` with `score.py shipped`: the wasm detector reproduces the bake-off scores.
- e2e: `npm run test:e2e:keep` runs read-ahead with the switch on against the real models and checks the panel reports a passthrough state.

## Listing copy

The "original music never plays" line stays true with the switch off. With it on, very quiet music can slip through.

## Not in scope

- Live mode gating.
- Skipping DPDFNet in music-free sections to save compute.
- A dialogue / music / effects model. Revisit if LiteCASS weights are released.
