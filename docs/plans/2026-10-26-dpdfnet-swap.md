# DPDFNet swap

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. TDD wherever the logic is pure.

**Goal:** Replace DeepFilterNet3 with DPDFNet at 16 kHz in both paths.
- **Live mode** (desktop Chrome, Edge, Firefox): a speed check picks DPDFNet-4 or DPDFNet-2.
- **Read-ahead** (Safari everywhere, Firefox for Android): DPDFNet-4.

**Why:** DeepFilterNet3 chops speech whenever music sits under it. This is model behaviour, confirmed by offline renders with no browser involved. In a blind A/B on 2026-10-26 the user picked DPDFNet-4 16k (and DBS-TIGER, which only runs offline).
- Evidence: `listening/README.md`, `listening/metrics-v2.json`.
- Spike, 2026-10-26: tract 0.23.8 runs both DPDFNet 16 kHz models in a real AudioWorklet and matches onnxruntime to about 130 dB SNR. DPDFNet-4 takes 2.16 ms per 10 ms hop (p99 2.49) on an M2 Pro and DPDFNet-2 takes 1.34 ms. The audio quantum is 2.67 ms.
- Spike code: scratchpad `dpdf-tract/`. Its key fix is `reseed_recurrences_every_call`, without which tract ignores GRU `initial_h` after the first call.

**Product rules (unchanged):** while the filter is on, the original track is never audible. Failures mute with a message. Read-ahead pauses until filtered audio is ready. Live mode never pauses.

## Facts to carry over

| Item | Value |
|---|---|
| Models | `dpdfnet4` and `dpdfnet2` 16 kHz ONNX from huggingface.co/Ceva-IP/DPDFNet (Apache-2.0, confirm the repo license too). 11.6 MB and 10.2 MB. Pin the revision and SHA-256. |
| I/O | `spec [1,1,161,2]` plus a flat `state_in`, giving `spec_e` and `state_out`. Hop 160 samples at 16 kHz (10 ms). STFT, vorbis window and initial state come from the model metadata. |
| Delay | 2400 samples at 48 kHz (50 ms) measured end to end, plus any resampler delay |
| Engine | Rust crate on `tract-onnx =0.23.8` (default features off, plus `getrandom-js`), `rustfft =6.2.0`, `wasm-bindgen =0.2.129`. Built with wasm-pack `--target web`, SIMD flags passed through `CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS`, opt-level 3. The wasm is 13.6 MB (2 MB brotli). |
| Cold start | About 420 ms (DPDFNet-4) or 280 ms (DPDFNet-2) to create. The first hop takes about 15 ms and the next 10 take 2.6 to 3.4 ms. |

## T1: Engine crate, build, model fetch, resampler

- `native/dpdf/` holds the spike crate, cleaned up.
  - API: `new Dpdf(modelBytes)`, `hop`, `process_hop(in160, out160)`, and a new `reset()` that restores the initial state.
  - Keep the GRU reseed fix and add a Rust test for it.
- `scripts/build-dpdf.sh` builds into `vendor/dpdf/` (JS glue, git-ignored) and `extension/assets/dpdf_bg.wasm` (git-ignored). It records versions and SHA-256 in `vendor/dpdf/SOURCE`, which is committed.
- `scripts/fetch-models.sh` downloads the two ONNX files at a pinned HF revision into `extension/assets/`, checks their SHA-256 and fails on mismatch.
- `src/pipeline/resampler.js`: a polyphase 48k↔16k resampler with a windowed-sinc FIR. It is streaming (keeps state across calls) and has a fixed, known delay.
  - Tests: passband flat within 0.5 dB to 7 kHz, at least 60 dB stopband rejection above 8 kHz on downsampling, a round-trip delay that is reported and constant, and no clicks at block boundaries.
- `src/pipeline/dpdf-filter.js`: a JS wrapper that streams 48 kHz mono through resample → 160-sample hops → resample and reports its total delay.
  - It runs in Node for tests and in the worklet and Worker.
  - Node test, skipped if the artifacts are missing: render `listening/synth-6db-original.wav` and compare with `listening/synth-6db-dpdfnet4-16.wav`. Target SNR is 35 dB or better. Small differences from the JS resampler are expected.

## T2: Live mode (desktop)

- The worklet processor moves to an engine interface `{ create(bytes), hop, processHop, reset, free }`. DeepFilterNet3 stays available behind it for the clip-test spike only.
- **Model choice in the processor constructor:**
  1. Create DPDFNet-4 and run 50 silent warm-up hops.
  2. Time the last 40 with `Date.now()` and divide the total by 40.
  3. If the mean is under 1.7 ms, keep DPDFNet-4, call `reset()` and report ready with `model: 'dpdfnet4'`.
  4. Otherwise free it, create DPDFNet-2, warm it up the same way, `reset()` it, and report `model: 'dpdfnet2'`.
  5. If DPDFNet-2's mean is 2.2 ms or more, report `too-slow`. Live mode then mutes with "This device is too slow to filter live".
- **Runtime overload** (existing monitor): when the overload policy trips on DPDFNet-4, the content script asks the processor to switch to DPDFNet-2. Output is muted during the switch, about 300 ms. If it trips on DPDFNet-2, show the existing too-slow message.
- **Bytes:** the content script passes both model bytes and the compiled `WebAssembly.Module`, with the Firefox `cloneInto` and bytes fallback that already exists.
- **Mode selection** (`selectFilterMode`): Safari uses read-ahead, Firefox for Android uses read-ahead, everything else uses live. The localhost `mf_mode` override stays.
- **Panel detail:** "live, DPDFNet-4" or "DPDFNet-2", plus the total delay.
- **Tests:** model-choice policy (pure), processor with a fake engine (warm-up, reset, switch, silence fail mode), and an updated live e2e that asserts the model reported and filtered audio.

## T3: Read-ahead (Safari, Firefox for Android)

- In the worker, the voice filter uses the DPDFNet-4 engine through `dpdf-filter.js` (the same wasm, loaded with `import.meta.url` like the DFN assets).
  - Per window: `reset()`, warm up on `contextBefore`, then process the window. Output is aligned by the reported total delay.
  - Keep the `separate(left, right, rate, { contextBefore })` contract.
- Keep the fake model for the e2e.
- **Tests:** voice-filter alignment with a fake engine and a delay, and a real-model smoke test that is skipped if the artifacts are missing. Run the engine check on `listening/synth-6db-original.wav` and compare with the reference.

## T4: Packaging, review, platform checks

- Manifest `web_accessible_resources` gets the new assets. `build-firefox.sh` and `build-safari.sh` include them, and the version is bumped to 0.2.0.
- Code review of T1 to T3.
- Platform checks:
  - Headless Chrome on real YouTube: live mode, model reported, worklet stats, no pauses.
  - Desktop Firefox through web-ext: live.
  - iPhone simulator: read-ahead.
- User listening test in Chrome.

## Out of scope

- DBS-TIGER, which is offline only.
- Singing removal.
- Splitting hops across quanta.
- The worker plus worklet bridge for slow desktops.
