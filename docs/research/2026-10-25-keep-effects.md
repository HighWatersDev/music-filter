# Keep effects, remove only music: models, prior art and plan

Checked 2026-10-25. This replaces the v2 section of `2026-10-19-landscape.md`. That pass looked only at real-time speech enhancement and wrongly dismissed dialogue / music / effects separators as offline only. Downloadable weights, ONNX exports and a browser runtime already exist. No training is needed to start.

## Summary

- **The model category is "cinematic" or DnR separation**: dialogue, music and effects as three outputs. Play the mix minus the music estimate, so speech and effects pass through untouched. Music-stem models (vocals / drums / bass / other) are the wrong split, because effects land in the wrong stems.
- **Two models run in the browser today** through one MIT npm package, [`@audio/neural-separate`](https://github.com/audiojs/neural/tree/main/packages/neural-separate) (0.7.0, onnxruntime-web, WASM or WebGPU):
  - **MRX** is faster than real time but leaves audible music.
  - **TIGER-DnR** is much better but about 3x too slow.
- **The delay problem has a known fix: read ahead.** YouTube's player downloads audio up to a minute ahead of the playhead. A page script can copy those chunks as the player appends them, separate them ahead of time and play the result in sync. [easysubs](https://github.com/Nitrino/easysubs) (MIT, 303 stars) already copies MSE audio this way. DJ apps hide separation latency the same way.
- **Forking NoMusic does not help this mode much.** Its tab-capture pipeline only ever sees audio at the current playhead, so a seconds-long model makes audio lag the video. The read-ahead pipeline is a different design. NoMusic's popup, model handling and speech-only mode could still be reused.

## Models with downloadable weights

D / M / E = dialogue / music / effects quality, higher is better. The numbers come from different test sets, so compare within a row family, not across rows.

| Model | Weights | License (code / weights) | Size | Quality | Speed | Browser |
|---|---|---|---|---|---|---|
| **MRX** (MERL) | [repo](https://github.com/merlresearch/cocktail-fork-separation), [ONNX int8](https://huggingface.co/audiojs/mrx) | MIT / MIT | 31 MB int8 | SI-SDR DnR v2: 12.3 / **4.2** / 5.7 | CPU RTF ~0.05 (M2 Pro, measured). Browser RTF 0.31 WASM, 0.75 WebGPU (M4 Max, loaded). | Yes |
| **TIGER-DnR** (ICLR 2025) | [HF](https://huggingface.co/JusperLee/TIGER-DnR), [ONNX int8](https://huggingface.co/audiojs/tiger-dnr) | MIT / Apache-2.0 | 7.3 MB int8 | SI-SDR DnR: 15.5 / **7.4** / 6.5. Beats MRX on 28 of 30 DnR v3 clips. | CPU RTF 1.8 (no overlap). Browser RTF 3.1 WebGPU, 9.2 WASM. | Yes, too slow for live |
| **DBS-TIGER** (Oct 2026) | [HF](https://huggingface.co/JusperLee/DBS-TIGER-DnR) | Apache-2.0 / Apache-2.0 | 4.1 MB, 1.0 M params, one network | SI-SDR DnR v2: 15.9 / **7.8** / 6.7 | Not reported. TIGER runs 3 networks, so likely ~3x cheaper. | No export yet |
| **Bandit v2** (DnR v3, multilingual) | [Zenodo](https://zenodo.org/records/12701995), [UVR repack 149 MB](https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/checkpoint-multi_fixed.ckpt) | Apache-2.0 / **CC BY-SA 4.0** | ~37 M params | SNR DnR v3: 15.3 / **10.4** / 9.9. Best open weights. | GPU RTF 0.025, CPU RTF 1.34 | No export |
| HTDemucs on DnR (ZFTurbo, CDX23) | [releases](https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing/releases/tag/v.1.0.0) | MIT / unstated | 54 MB each | SDR DnR: 14.2 / 6.8 / 7.9 | Not reported. HTDemucs fp16 runs 22x real time on a desktop GPU in onnxruntime-web. | HTDemucs ONNX path exists, untested with these weights |
| BandIt Plus, Demucs/UMX on DnR | Zenodo 10160698 | **CC BY-NC 4.0** | | | | Non-commercial, skip |

Notes:

- Every released DnR model is non-causal. Each needs chunks of 3 to 12 s, which read-ahead absorbs.
- Text-queried separators (SAM Audio, AudioSep, CLAPSep, FlowSep) can "remove music, keep the rest", but they are 1 to 15 GB and untested on film mixes. Useful only for labelling data.
- No source reports the metric we care about: quality of (mix minus music) against true speech plus effects. We have to measure that on our own clips.
- Better models without weights: LiteCASS (1 M params, CPU RTF 0.012), MVSep's SCNet and Mel-RoFormer DnR models (hosted only), and AudioShake (closed SDK). Licensing AudioShake is the fallback if open models can't reach quality.

## Prior art for hiding the delay

| Approach | Who | Fit |
|---|---|---|
| Copy MSE audio as the player appends it (MAIN-world wrapper on `SourceBuffer.appendBuffer` at `document_start`) | easysubs ([mseTap.js](https://github.com/Nitrino/easysubs/blob/main/public/assets/js/mseTap.js)) | **Best.** Zero lag, works on most sites. Fails on DRM audio, or if a site moves MSE into a worker. |
| Prepare audio before playback (cloud or local helper app) | HaramMute, musicremover.org | Works, but the user waits, and it needs a server or a desktop app |
| Delay the video picture to match | Frame Sync, Bluetooth Video Sync | ~750 MB per 3 s of 1080p, breaks YouTube controls and fullscreen, fails on DRM |
| Tab capture plus a small real-time model | NoMusic | Real time only for speech enhancement, which removes effects |

## Proposed architecture (v2)

```
YouTube page (MAIN world)          hidden extension iframe             content script
SourceBuffer.appendBuffer tap  →   decode (WebCodecs / decodeAudioData)
                                   → separation Worker (onnxruntime-web, WebGPU)
                                   → mix − music, overlap-add          →  AudioContext
                                                                           schedules chunks
                                                                           against video.currentTime,
                                                                           video element muted
```

- **Why a hidden extension iframe:** our spike found content scripts on YouTube cannot start Workers. A web-accessible extension iframe can start Workers and has WebGPU (probe-verified). It passes PCM to the content script with transferable `postMessage`. This avoids tab capture entirely.
- **Seeks and first play:** play the original audio, ducked, until the first processed chunk is ready (1 to 3 s). musicremover.org ships the same behaviour.
- **Fallback for DRM sites** or anywhere the MSE tap fails: speech-only real-time mode (DeepFilterNet3 or FastEnhancer), as today.

## Plan

| Step | What | Effort | Decides |
|---|---|---|---|
| 1. Offline listening test | Run MRX and TIGER through `@audio/neural-separate` in Node on 5 to 10 local clips (vlog with music, documentary, gaming, cartoon, song with effects). Write `mix − music` WAVs and listen. | 0.5 to 1 day | Is MRX quality acceptable, and is TIGER worth chasing? |
| 2. Browser speed | Same models in a hidden extension iframe on WebGPU. Measure RTF on the M2 Pro and one Intel/AMD integrated-GPU laptop, with 3, 6 and 12 s chunks. | 1 to 2 days | Which model runs live, and on what hardware |
| 3. MSE tap spike | Copy YouTube audio segments, decode, verify gapless PCM mapped to `currentTime`. Cover quality switches, ads, seeks and SPA navigation. | 3 to 4 days | Whether read-ahead works on YouTube |
| 4. DBS-TIGER export | Try the ONNX export of the 1 M-param single-network model. Benchmark if it exports. | 1 to 2 days | Better quality at real-time speed |
| 5. Build v2 | Scheduler, seek and ad handling, popup with "speech only / keep effects", model download and cache, fallback mode | 3 to 4 weeks | — |

Fork decision after step 3. If read-ahead works, build in this repo and borrow NoMusic's UI patterns (ISC, keep the notice). Only fork NoMusic if we decide its tab-capture speech mode is the product's main mode.

## Licenses to respect

- MRX: MIT.
- TIGER-DnR and DBS-TIGER: Apache-2.0.
- Bandit v2 weights: CC BY-SA 4.0. Shipping converted weights keeps them under CC BY-SA with attribution. The extension code can stay MIT or Apache.
- Avoid every CC BY-NC checkpoint.
- NoMusic: ISC, if any code is borrowed.
