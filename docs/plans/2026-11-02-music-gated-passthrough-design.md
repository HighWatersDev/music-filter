# Music-gated passthrough

**Goal:** keep sound effects and ambient sound in the parts of a video that have no music.

**Why:** DPDFNet keeps voices only, so effects disappear everywhere, even where there is no music to remove. The user noticed this on desktop Chrome on 2026-11-02. A real dialogue / music / effects model is still out of reach. DBS-TIGER is too slow (`spikes/2026-10-30-tiger-browser.md`), and LiteCASS (arXiv 2609.23453), the one fast enough, has no released code or weights. NoNoiseYT gates its speech model on a music detector, and this design does the same.

## Decisions

| Question | Choice | Reason |
|---|---|---|
| Default | Off. A popup switch, "Keep other sounds when there's no music". | Voice-only stays unchanged for users who want no music at all. A missed detection plays music. |
| Mode | When the switch is on, every browser uses read-ahead, desktop included | Detection needs about 1 s of audio. Live mode has about 0.1 s of delay, so music would play for about 1 s at every onset. Read-ahead sees 10 s ahead and switches before music starts. |
| Detector | Test YAMNet and EfficientAT mn05, keep the one that lets less music through | See below |

## How it works

For each read-ahead window the worker already has the original audio and the DPDFNet output. It also runs a music detector on the window and mixes the two:

- Music detected, or unsure: filtered audio, as today.
- Confidently no music: original audio.

**Rule.** The detector gives a music probability every 0.5 s. A moment plays the original only if every frame from 1.5 s before it to 1.5 s after it is below a low threshold. Changes use a 200 ms crossfade. The rule leans toward filtering. DPDFNet still runs on every window, so its recurrent state never jumps.

**Window edges.** The rule needs 1.5 s on each side. The detector also reads the `contextBefore` audio the planner already passes, plus the first 1.5 s of the next window. When the next window isn't decoded yet, the end of the window counts as music and stays filtered.

## Detector candidates

| | YAMNet | EfficientAT mn05 |
|---|---|---|
| Source | Google, tensorflow/models | fschmid56/EfficientAT |
| License | Apache-2.0 | MIT code. The weights' terms need checking. |
| Size and input | 3.7 M params, 16 kHz mono, 0.96 s frames | About 1 M params, 32 kHz mono |
| AudioSet mAP | 0.31 | About 0.43 |

Both cost a small fraction of DPDFNet. Pick by a listening score on clips with quiet music under speech: seconds of music let through first, seconds of effects kept second.

## Components

| Piece | Change |
|---|---|
| `native/dpdf` | A `MusicDetector` wasm-bindgen class beside `Dpdf`, on tract, in the same `dpdf_bg.wasm` |
| `extension/assets`, `scripts/fetch-models.sh` | The detector ONNX, pinned by SHA-256, mirrored to the GitHub release |
| `src/pipeline/music-gate.js` (new, pure) | Frame probabilities to a 0..1 mix curve: the ±1.5 s rule and the crossfades |
| `src/separator/filter-worker.js` | After DPDFNet: downmix, resample to the detector rate with the existing resampler, detect, then output = curve × original + (1 − curve) × filtered |
| `src/content/settings.js`, popup | `keepOtherSounds`, off by default, and its switch |
| `selectFilterMode` | Returns read-ahead when `keepOtherSounds` is on. Changing it restarts filtering on open YouTube tabs. |
| Panel and player icon status | "Filtered" or "Original sound" for the current moment |

## Failure

If the detector fails to load or throws, the worker skips the mix and plays the filtered audio. An error never lets music through.

## Tests

- Unit: `music-gate.js` thresholds, window edges with and without the next window, and the crossfade shape.
- Rust: the detector matches onnxruntime on a fixed clip.
- `tools/listen`: score each candidate on local clips for music let through and effects kept.
- e2e: read-ahead with `keepOtherSounds` on, the curve follows a clip with a known music section.

## Listing copy

The "original music never plays" line stays true with the switch off. With it on, add that detection can miss very quiet music.

## Not in scope

- Live mode gating.
- Skipping DPDFNet in music-free sections to save compute.
- A dialogue / music / effects model. Revisit if LiteCASS weights are released.
