# DBS-TIGER in the browser: speed spike

Date: 2026-10-30
Question: can DBS-TIGER (dialogue / music / effects) run in read-ahead fast enough for an optional "keep effects" mode?
Scope: test only. Nothing in `src/` or `extension/` changed. DPDFNet stays the default.

## Verdict

| Target | Viable? | Basis |
|---|---|---|
| Desktop read-ahead, WASM (the extension's case) | **No** | M2 Pro, 3 Workers: 0.66 s of audio per wall second. The limit needs 1.67, before any window overlap. |
| Desktop read-ahead, WebGPU | **No** | Best case 0.96 s of audio per wall second (fp16, 1 Worker). More Workers share one GPU and get slower. |
| Galaxy A56, Firefox | **No** (estimate, phone not measured) | About 10x too slow, and 1.6 GB of wasm heap per Worker |
| iPhone, WebGPU | **No** (estimate only) | Its GPU is about a third of the M2 Pro's, which already falls short |

The model exports and runs correctly in the browser. It is too heavy. It costs about 2.2 s of CPU per second of audio on one native M2 Pro core, and 4.5 s in single-thread WASM. The DBS front and back end run 132 to 264 channels at full STFT resolution, which sets the memory.

## Pinned inputs

| Item | Version |
|---|---|
| DBS code | github.com/JusperLee/Dynamic-Band-Splitting `ff526463a58ee0278e7bd05c4b8bce112b743e34` |
| Weights | HF `JusperLee/DBS-TIGER-DnR` rev `22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b`, `model.safetensors` SHA-256 `3d820574…225cadb`, 4.1 MB |
| TIGER-DnR comparison | HF `audiojs/tiger-dnr` rev `65072a21…`, `tiger.int8.onnx` SHA-256 `2189859a…7bca` |
| Export env | Python 3.12, torch 2.15.0, onnx 1.23.2, onnxruntime 1.31.1, onnxconverter-common 1.16.0. uv venv in the scratch dir, about 0.8 GB. |
| Runtimes | Node 24.8.0, onnxruntime-node 1.30.0, onnxruntime-web 1.30.0 |
| Browsers | Chromium 131.0.6778.33 headless (Playwright 1.49.1, `chromium-1148`). Firefox 157 Nightly headless (`firefox-1555`, started directly because Playwright 1.49 cannot drive it). |
| Mac | M2 Pro, 6P + 4E cores, 16 GB, macOS 26.6.2 |

## Export recipe

Scripts are in `tools/tiger-bench/export/`. The graph takes the STFT and returns three masked spectra. STFT and iSTFT run in JS (`tools/tiger-bench/dsp.mjs`).

| | |
|---|---|
| Input | `spec` [1, 2, 1025, frames]. n_fft 2048, hop 512, Hann, centred with reflect padding. 6 s = 517 frames, 3 s = 259. |
| Output | `out` [1, 3, 2, 1025, frames]: music, sfx, speech, each re and im. Keep effects = iSTFT(sfx + speech). The masks sum to 1, so this equals the mix minus music. |
| Shapes | Fixed. One file per window length. |

Steps:

1. `export.py --seconds 6` traces `SpecCore` with the legacy TorchScript exporter: opset 18, `dynamo=False`, `do_constant_folding=False`.
2. `basic.py` saves the onnxruntime BASIC-optimized graph. This level is provider-independent.
3. `dedupe.py` merges about 840 identical initializers.
4. `variants.py` and `variants2.py` make the int8 and fp16 files. `fixcast.py` repairs Cast nodes the fp16 converter leaves as float.

What had to change in the model code (`dbs_onnx.py`). None of it changes the function:

| Problem | Fix |
|---|---|
| `if boundary_flat.any()` in `PhysicsChunker.pool` stops `torch.export` (the 2026-10-26 failure) | Dropped. Bin 0 is always a boundary, so the branch always runs. |
| Complex tensors (`torch.complex`, `.real`, `angle(exp(1j·d))`) | Real and imaginary tensors, `atan2(sin d, cos d)` |
| `scatter_reduce` amax / amin segment pooling | Dense one-hot [F, 32] matmuls and masked reductions |
| `adaptive_avg_pool1d` over 517 → 33 frames is not exportable (output size not a factor) | A fixed averaging matrix per length |
| Legacy exporter with constant folding was killed (exit 137). Probably the earlier "exited without output". | `do_constant_folding=False`, then onnxruntime folds at step 2. Export takes 35 s. |
| `torch.export` (dynamo) path works after the fixes above, but unrolls the 4 LSTMs into about 1,000 nodes, writes 61 MB and takes 8 minutes | Not used |
| ONNX atan2 is `atan(y / x)`, so digital silence (0/0 bins) gave NaN for the whole window | Guard 0/0 bins to atan2(0, 1) = 0, as torch does |
| WebGPU: a 33-input Concat (token smoothing) exceeds 8 storage buffers per shader and the pipeline is invalid | Stack in groups of 6 |
| WebGPU: `Where` broadcasting [1, K, F] with [1, 1, F] returned wrong values, exp() overflowed, output all NaN | Masked max with arithmetic instead of `Where` |

## Parity

ONNX on onnxruntime CPU against the original PyTorch `DBSTIGER.forward`, one 6 s window. SNR in dB. "Kept" is sfx + speech, the signal we would play.

| Variant | File | gzip | synth-6db kept | synth-0db kept | speech-clean kept | Worst stem |
|---|---|---|---|---|---|---|
| fp32, 6 s | 7.1 MB | 4.0 MB | 95.5 | 93.8 | 126.8 | 85.4 (57 on near-silent stems of clean speech) |
| fp32, 3 s | 6.9 MB | 4.0 MB | 94.6 | | 135.1 | 88.8 |
| fp16 (LSTM, TopK, norms, Resize and trig kept fp32) | 6.5 MB | 2.4 MB | 66.4 | 67.8 | 76.4 | 60.4 |
| int8 dynamic, all ops | 5.9 MB | 1.2 MB | 2.5 | 18.4 | 34.2 | broken |
| int8 dynamic, separator MatMul only | 7.7 MB | 4.1 MB | 51.2 | 52.8 | 111.1 | 45.5 |
| int8 dynamic, separator Conv + MatMul | 7.6 MB | | 26.8 | | | |

- fp32 passes the 40 dB target everywhere.
- int8 fails. The hard top-K band boundaries make the model sensitive: small changes in the router move a boundary and change whole tokens. Dynamic int8 Conv is also slower on CPU (5.9x real time). It gives no speed gain to justify the loss.
- The file is larger than the 4.1 MB of weights because the 9,000-node graph itself is about 2 MB, plus folded constants. gzip brings fp32 back to the weight size.
- JS pipeline (JS STFT, onnxruntime-node, JS iSTFT) against PyTorch: 95.2 dB.
- In the browser, against the onnxruntime-node fp32 output: WASM 67.6 dB (6 s) and 75.7 dB (3 s), WebGPU fp32 91.3 dB (6 s) and 40.2 dB (3 s), WebGPU fp16 38.9 dB.

## Node benchmark (M2 Pro, 1 thread)

onnxruntime-node 1.30, `intraOpNumThreads` 1. Per window, including JS STFT and iSTFT (under 70 ms).

| Model | Window | Time | RTF per window |
|---|---|---|---|
| DBS-TIGER fp32 | 6 s | 13.6 s | 2.27 |
| DBS-TIGER fp32 | 3 s | 6.5 s | 2.17 |
| DBS-TIGER fp16 | 6 s | 22.7 s | 3.79 |
| DBS-TIGER int8, separator MatMul only | 6 s | 13.3 s | 2.22 |
| DBS-TIGER int8, all | 6 s | 35.3 s | 5.89 |
| TIGER-DnR int8 (audiojs) | 12 s | 46.2 s | 3.85 |

Cost is linear in window length. DBS-TIGER is about 1.7x cheaper per second than TIGER-DnR, not the 3x the research doc guessed. CPU profile of one 6 s window: Conv 46%, MatMul 9%, Add 7%, InstanceNormalization 7%, Mul 7%, Resize 5%, LSTM 3%.

## Browser benchmark (M2 Pro)

`tools/tiger-bench/`: each of N Workers loads its own session, runs one warm-up window, then filters windows back to back. "Audio/s" is seconds of audio filtered per wall-clock second across all Workers. "First" is the wall time until every Worker has its first window, which is what a seek waits for. Heap is the Worker's wasm memory after the run.

### Chromium 131, WASM, 1 thread, not cross-origin isolated (the extension's case)

| Window | Workers | RTF per window | Audio/s | First | Heap per Worker |
|---|---|---|---|---|---|
| 3 s | 1 | 4.48 | 0.22 | 13.4 s | 1.6 GB |
| 3 s | 2 | 4.57 | 0.43 | 14.0 s | 1.6 GB |
| 3 s | 3 | 4.54 | 0.66 | 13.8 s | 1.6 GB |
| 6 s | 1 | 4.58 | 0.22 | 27.7 s | 3.2 GB |
| 6 s | 2 | 5.30 | 0.38 | 32.1 s | 3.2 GB |
| 6 s | 3 | 6.92 | 0.43 | 41.7 s | 3.2 GB |

The 6 s runs with 2 and 3 Workers pushed the Mac into swap (3 x 3.2 GB on 16 GB). WASM is about 2x slower than native onnxruntime.

### Firefox 157, WASM, 1 thread

| Window | Workers | RTF per window | Audio/s |
|---|---|---|---|
| 3 s | 1 | 5.24 | 0.19 |
| 3 s | 2 | 5.09 | 0.39 |
| 3 s | 3 | 5.16 | 0.58 |
| 6 s | 1 | 5.20 | 0.19 |

About 15% slower than Chromium. Same heap sizes.

### Chromium 131, WASM, 4 threads, COOP/COEP (information only)

| Window | Workers | RTF per window | Audio/s |
|---|---|---|---|
| 3 s | 1 | 2.30 | 0.44 |
| 3 s | 2 | 3.48 | 0.57 |
| 3 s | 3 | 4.56 | 0.65 |

Threads help one Worker but the total stays at the same ceiling as 3 single-thread Workers.

### Chromium 131, WebGPU (Apple M2 Pro GPU, shader-f16 available)

| Model | Workers | RTF per window | Audio/s | First | Worker heap (CPU side) |
|---|---|---|---|---|---|
| fp32, 3 s | 1 | 1.62 | 0.62 | 4.9 s | 0.48 GB |
| fp32, 3 s | 2 | 2.52 | 0.79 | 8.0 s | 0.48 GB |
| fp32, 3 s | 3 | 5.32 | 0.54 | 18.8 s | 0.48 GB |
| fp32, 6 s | 1 | 1.75 | 0.57 | 10.7 s | 0.91 GB |
| fp32, 6 s | 2 | 6.07 | 0.32 | 41.4 s | 0.91 GB |
| fp16, 6 s | 1 | 1.04 | 0.96 | 6.2 s | 0.57 GB |

- GPU memory was not measured. The first 6 s fp32 WebGPU run stalled for over 12 minutes with the Mac deep in swap after the 6 s WASM runs, and was stopped. The rerun used at most 2 Workers.
- WebGPU fp16 parity (38.9 dB) is just under the 40 dB target. fp32 3 s (40.2 dB) is at it.
- Firefox 157 headless exposes `navigator.gpu` but returns no adapter, so Firefox WebGPU was not measured.
- Session creation: 1.5 to 2.3 s on WASM, 2.6 to 4.1 s on WebGPU.

### TIGER-DnR int8 for comparison (12 s window, 1 Worker)

| Backend | RTF per window | Audio/s | Heap |
|---|---|---|---|
| WASM 1 thread | 6.86 | 0.15 | 2.3 GB |
| WebGPU | 2.23 | 0.45 | 0.29 GB CPU side |

The research doc's 9.2 (WASM) and 3.1 (WebGPU) were measured on an M4 Max, so they are not comparable.

## Memory per Worker

| | 3 s window | 6 s window |
|---|---|---|
| WASM heap, Chromium and Firefox | 1.6 GB | 3.2 GB |
| onnxruntime-node peak RSS | 1.8 GB | 3.5 GB |
| WebGPU, CPU-side wasm heap | 0.48 GB | 0.91 GB (fp16 0.57 GB) |

About 0.53 GB of wasm heap per second of window. Turning off the CPU arena or memory patterns changes nothing (Node RSS within 4%). The largest tensors are full-resolution features: [132 or 264 channels, 1025 bins, frames]. The top region's mask decoder alone holds two 184 MB tensors for a 3 s window. A 6 s window sits close to the 4 GB wasm32 limit.

## Phone (Galaxy A56)

**Not measured.** `adb devices` listed no device at four checks between 19:30 and 21:00. The bench page and server are ready for it (see "Rerunning").

Estimate, clearly not measured:

| | Estimate | How |
|---|---|---|
| RTF per window, 1 Worker | 16 to 21 | Firefox Mac WASM 5.2 x 3 to 4. The repo's standing phone factor, and close to the DPDFNet-4 ratio (0.25 on the M2 Pro vs about 1.0 on the A56). |
| Audio/s, 3 Workers | 0.15 to 0.2 | Before contention |
| Memory, 3 Workers, 3 s windows | 4.9 GB wasm heap in one content process | Likely an out-of-memory kill on an 8 GB phone |
| After a seek | 50 to 60 s to the first 3 s window | |

Needs about 10x less compute and about 5x less memory. Not reachable by tuning.

## iPhone with WebGPU (estimate only)

Not measured. An A17 Pro or A18 GPU has roughly a third of the M2 Pro GPU's fp32 throughput. Scaling the best Mac case (fp16, 6 s, RTF 1.04) gives RTF 3 or more per window and about 0.3 s of audio per second. Safari's WebGPU was not tested with this graph, and onnxruntime-web 1.30 needed two graph workarounds on Chrome's.

## What the limit asks for

Our limit is `RTF per window / Workers` at most 0.6, so at least 1.67 s of audio per wall second. TIGER windows also overlap:

| Windowing | Compute per output second | Audio/s needed |
|---|---|---|
| No overlap (hard cuts at window edges) | 1x | 1.67 |
| 3 s windows, 0.5 s crossfade | 1.2x | 2.0 |
| 6 s windows every 3 s (the offline run the user liked) | 2x | 3.3 |

| Platform | Best measured or estimated | Short by |
|---|---|---|
| M2 Pro, WASM, 3 Workers | 0.66 | 3x to 5x |
| M2 Pro, WebGPU fp16 | 0.96 | 2x to 3.5x |
| Galaxy A56 (estimate) | 0.15 to 0.2 | 10x to 20x |
| iPhone WebGPU (estimate) | about 0.3 | 6x to 11x |

## If it is revisited

What integration would need, for this model or a lighter successor:

- **Chunk size:** 3 s and 6 s windows cost the same per second. Memory grows with length, so 3 s is the most a phone could hold. Quality at 3 s has not been checked by ear. The model was trained on 6 s.
- **Overlap:** a 0.5 to 1 s crossfade (1.1 to 1.2x compute) instead of the 50% overlap used offline. Untested by ear.
- **Download size:** model 4.0 MB (fp32) or 2.4 MB (fp16) gzipped. The extension has no onnxruntime today (DPDFNet runs on tract in `dpdf_bg.wasm`). onnxruntime-web adds 14 MB of wasm (3.7 MB gzip) for WASM only, or 28 MB (6.6 MB gzip) with WebGPU. Whether tract runs this graph (LSTM, TopK, ScatterElements, CumSum) was not checked.
- **Ship or download:** download on demand when the user picks "keep effects". It is an optional mode, and it would add 10 to 35 MB to every install.
- **Shapes:** fixed per window length, one ONNX per length.
- **A lighter model is the real fix.** The separator runs 8 dual-path iterations over 128 tokens, and the DBS ends run 132 to 264 channels at all 1025 bins. Without retraining at lower cost, no runtime setting closes a 3x gap on desktop or a 10x gap on phones.

## Not done

- Phone benchmark and thermal readings: the phone was not connected.
- Firefox WebGPU: no adapter in headless Firefox 157.
- Which WebGPU nodes fall back to the CPU was not checked.
- Static (calibrated) int8 was not tried. Dynamic int8 showed no speed gain on CPU.
- No listening test of the exported model. Parity numbers stand in for it.

## Rerunning

Large files (venv, weights, ONNX, clips) stay outside the repo.

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
cd tools/tiger-bench && npm install
# export (in a venv with torch, onnx, onnxruntime, onnxconverter-common and the DBS repo installed)
python export/export.py --weights <dbs-weights-dir> --clip <44.1k mono wav> --seconds 6 --out dbs6_raw.onnx
python export/basic.py dbs6_raw.onnx dbs6_basic.onnx && python export/dedupe.py dbs6_basic.onnx dbs6_fp32.onnx
# benchmarks
node node-bench.mjs --models <onnx-dir> --clip <44.1k mono wav> dbs6_fp32.onnx:6 dbs3_fp32.onnx:3
node serve.mjs --models <onnx-dir> --clips <clips-dir> --results results.jsonl
node run-mac.mjs "model=dbs3_fp32.onnx&seconds=3&ep=wasm&workers=1,2,3&chunks=3&mftest=tiger"
```

Phone: `adb reverse tcp:8791 tcp:8791`, then open `http://localhost:8791/index.html?model=dbs3_fp32.onnx&seconds=3&workers=1,2,3&chunks=2&mftest=tiger&close=1` with a VIEW intent. The page posts its result to the server's `results.jsonl`.
