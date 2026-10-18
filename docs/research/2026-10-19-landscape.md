# Landscape: real-time music removal, October 2026

Checked 2026-10-19. Store numbers, prices and model claims come from the linked sources. Items marked **unverified** come from snippets or secondary sources only. Re-check before relying on them, since this field changes monthly.

## Summary

- **The approach works on YouTube today.** A live probe in Chrome 148 confirmed it: the worklet loads from a `chrome-extension://` URL despite YouTube's CSP, WASM compiles in the content script and in the worklet, and `createMediaElementSource` works on the page's video. Blob URLs are blocked.
- **DeepFilterNet3 in an AudioWorklet is already proven in production.** WorkAdventure measured 2.7% of one M4 core and 41 to 71 ms of delay. Its algorithmic latency is about 40 ms, not the 30 ms assumed in the design.
- **The market is crowded at the low end.** At least 6 extensions launched in 2026. The leader, HaramMute, has 30k Chrome users and paid tiers, and processes on a server ahead of playback. The in-browser tools use speech denoisers (FastEnhancer, RNNoise, DeepFilterNet). None publishes quality numbers.
- **The biggest threat is OS-level.** Samsung Audio Eraser on the Galaxy S26 filters music live inside the YouTube app for free.
- **The singing problem has a likely root cause.** DNS Challenge clean speech, which DFN3 trained on, includes singing from VocalSet. The model learned that singing is speech.
- **Policy favours local processing.** YouTube's API policy bans isolating audio and caching content, and the ToS bans modifying the service and restreaming. Processing tab audio on the user's device is the lowest-risk design. Server and restream modes carry real platform risk.

## 1. Models

### Speech enhancement (v1 candidates)

| Model | Date | License | Size / cost | Latency | Browser-ready | Link |
|---|---|---|---|---|---|---|
| DeepFilterNet3 | 2023 | MIT / Apache-2.0 | RTF 0.19 on i5, 2.7% of M4 core in worklet | ~40 ms | Yes, WASM AudioWorklet (npm, WorkAdventure) | [repo](https://github.com/Rikorose/DeepFilterNet), [WorkAdventure](https://github.com/workadventure/noise-suppression) |
| DPDFNet (Ceva) | Dec 2025 | Apache-2.0 | 2.6M to 3.6M params, 2.4 to 7.2 GMACs | Causal, 20 ms frame / 10 ms hop | ONNX, TFLite, sherpa-onnx | [HF](https://huggingface.co/Ceva-IP/DPDFNet), [paper](https://arxiv.org/abs/2512.16420) |
| GTCRN | 2024, updated Jan 2026 | MIT | 48K params, 33 MMACs/s | Streaming RTF 0.07 | sherpa-onnx WASM | [repo](https://github.com/Xiaobin-Rong/gtcrn) |
| UL-UNAS | Mar 2025 | MIT | unverified | Streaming ONNX since Feb 2026 | ONNX | [repo](https://github.com/Xiaobin-Rong/ul-unas) |
| FastEnhancer | unverified | unverified | unverified | unverified | ONNX in a Worker (used by NoMusic) | [NoMusic](https://github.com/mohamedsadiqaguenaou/NoMusic) |

None of these papers evaluates music or singing as the noise.

### Separation (v2 candidates)

| Model | Date | License | Latency | Browser-ready | Link |
|---|---|---|---|---|---|
| Bandit v2 (dialogue / music / effects, DnR v3) | 2024 | Apache-2.0 | Offline | No | [repo](https://github.com/kwatcharasupat/bandit-v2) |
| HTDemucs | 2022 | MIT | Offline, 172 MB | WebGPU / WASM, whole files | [demucs-web](https://timcsy.github.io/demucs-web/demo/), [demucs-rs](https://github.com/nikhilunni/demucs-rs) |
| Windowed-sink RoFormer (Smule) | Oct 2025 | MIT | 8 s chunks, 44.5x fewer FLOPs than Mel-RoFormer | WebGPU ONNX, patched ORT kernels | [paper](https://arxiv.org/abs/2510.25745), [ONNX](https://huggingface.co/mtsmfm/windowed-roformer-onnx) |
| HS-TasNet | 2024 | MIT reimplementation, no weights | 23 ms | No | [paper](https://arxiv.org/abs/2402.17701) |
| One-hop streaming of offline HT-Demucs / SCNet | Sep 2026 | n/a | 23 ms, real time only on GPU | No | [arXiv 2609.35397](https://arxiv.org/abs/2609.35397) |
| SAM Audio (text-prompted) | Dec 2025 | SAM License, gated | Offline, 1.9B+ params | No. Useful for labelling data. | [HF](https://huggingface.co/facebook/sam-audio-small) |

### Speech vs singing (v1.1)

| Item | What it gives us | Link |
|---|---|---|
| Banquet / Bandit 4-stem (dialogue, music, singing, effects) | The only separator that splits singing from dialogue. Code "will be made available". | [arXiv 2408.03588](https://arxiv.org/abs/2408.03588) |
| SR-SAD (Dec 2025) | Speech activity detection that rejects singing, AUC 0.919. No code. | [arXiv 2512.09713](https://arxiv.org/abs/2512.09713) |
| LoRA adaptation of SE models to singing (Jul 2026) | SE models can be retargeted with 6 to 12% extra params | [arXiv 2607.11630](https://arxiv.org/abs/2607.11630) |
| NHSS | Parallel spoken and sung versions of the same lyrics, ~7 h | [arXiv 2012.00337](https://arxiv.org/abs/2012.00337) |
| DnR v3 | Dialogue / music / effects stems, 32 GB | [Zenodo](https://zenodo.org/records/12659875) |

## 2. Products

### Browser extensions

| Name | How it works | Users / rating | Price | Updated |
|---|---|---|---|---|
| [HaramMute](https://chromewebstore.google.com/detail/harammute-remove-backgrou/bbkbpldbnkoncockinoapcmbiijejgpn) | Prepares audio ahead of playback, apparently on a server. Reviews report "YouTube is blocking requests". No live streams. | 30k, 4.2 | Free 60 min/week, paid tiers | Aug 2026 |
| [Haram Music Remover](https://chromewebstore.google.com/detail/musicremover-mute-remove/pljjgbebgcpplkcmggdemopekpennmfc) | Extension + local desktop app separating on CPU, 5 to 25 s startup | 3k, 4.8 | Free | Oct 2026 |
| [NoMusic](https://chromewebstore.google.com/detail/nomusic-watch-any-video-w/fepfnjijcojaoihcekfhonohejglmdbc) ([source](https://github.com/mohamedsadiqaguenaou/NoMusic)) | tabCapture + offscreen doc, FastEnhancer ONNX + RNNoise, ISC license | 1k, 4.8 | Free | Oct 2026 |
| [Music Remover](https://chromewebstore.google.com/detail/music-remover/aoigalcpojgijmaclbmicnhejndafkbj) | Processes and shares results through a shared database, 272 MiB package | 1k, 4.9 | Free | Aug 2026 |
| [nomus](https://github.com/by-sabbir/nomus-extension) | Rust/WASM AudioWorklet, ~20 ms. Keeps singing. Weights CC BY-NC-SA. | unknown | Free | unknown |
| Muteify, NoMusic (anuarkhanov) | Detect music and mute or duck it | under 250 | n/a | 2025 to 2026 |

### Mobile and OS

| Name | What it does | Link |
|---|---|---|
| Samsung Audio Eraser (One UI 8.5, S26) | Live filtering in YouTube, Netflix, Instagram and TikTok with a strength slider. Only in listed apps. | [Samsung](https://www.samsung.com/us/support/answer/ANS10004604/), [9to5Google](https://9to5google.com/2026/02/25/samsung-galaxy-audio-eraser-youtube/) |
| HaramMute app | Paste a YouTube link, plays prepared audio in sync. 50K+ Android downloads (unverified). About $5.50 to $13.70/month. | [App Store](https://apps.apple.com/qa/app/harammute-watch-without-music/id6787372614) |
| Pixel Audio Magic Eraser, Apple Audio Mix | Edit recorded video only, not playback | [Android Authority](https://www.androidauthority.com/audio-magic-eraser-upgrade-pixel-8-3490500/) |

### B2B and offline tools

| Name | Notes | Link |
|---|---|---|
| AudioShake SDK | On-device, under 50 ms claimed, launched live-broadcast music removal Dec 2025. Enterprise pricing. | [SDK](https://www.audioshake.ai/sdk) |
| ElevenLabs Voice Isolator | Cloud, files only, $0.12/min | [pricing](https://elevenlabs.io/pricing/api) |
| LALAL.AI, Moises, Adobe Podcast | File-based separation or enhancement | — |

No desktop tool strips music from system playback out of the box. EasyEffects can run DeepFilterNet on all outputs, but only as a speech denoiser.

## 3. Browser platform facts

From the live probe (Chrome 148, YouTube watch page) and docs:

| Question | Answer |
|---|---|
| Worklet from `chrome-extension://` web_accessible_resource | Works. Chrome skips page CSP for extension-scheme resources. |
| Worklet from `blob:` | Blocked. The blob takes the page origin and YouTube's allowlist has no `blob:`. |
| `WebAssembly.compile` in content script | Works, under the extension CSP |
| `new WebAssembly.Module` in the worklet | Works only because YouTube allows `'unsafe-eval'`. Passing a precompiled Module avoids that dependency. |
| `performance.now` in AudioWorkletGlobalScope | **Missing** in Chrome 148. Use `Date.now` or `currentFrame`. |
| Worker from content script | Blocked both ways (cross-origin and page CSP) |
| SharedArrayBuffer / Wasm threads on YouTube | No. The page is not cross-origin isolated. |
| onnxruntime-web in AudioWorklet | Does not work ([#13072](https://github.com/microsoft/onnxruntime/issues/13072), open since 2022) |
| Heavier models (v2) | A hidden web-accessible extension iframe can run a Worker and has WebGPU. Bridge to the worklet with a transferred MessagePort. |
| WebNN | Origin trial from M147, desktop only |
| Firefox | `moz-extension://` worklets load despite page CSP. Untested on YouTube. |
| A/V sync for multi-second delay | Prior art: [Frame Sync](https://github.com/maggch97/Frame-Sync) buffers frames via `requestVideoFrameCallback` into a canvas ring. 3 s of 1080p30 is about 750 MB. A second look-ahead `<video>` cannot share YouTube's MSE source. |
| Android AudioPlaybackCapture | Copies audio without muting the source app, so it cannot replace YouTube app audio. Firefox for Android with extensions is the realistic mobile path. |
| iOS | Safari has AudioWorklet but `createMediaElementSource` has regressions. Untested on m.youtube.com. |

## 4. Policy

- **YouTube ToS:** no modifying the service or content, personal non-commercial use only. Restreaming conflicts directly. [ToS](https://www.youtube.com/static?template=terms)
- **YouTube API Developer Policies (2026-10-15):** III.I.7 bans separating or modifying audio and video components. III.E.1 bans caching. A product built on the IFrame or Data API breaks these. [policies](https://developers.google.com/youtube/terms/developer-policies)
- **Chrome Web Store:** no facilitating unauthorized download or streaming of copyrighted content. Server tools that fetch and re-serve audio are riskier than local tab processing. [policy](https://developer.chrome.com/docs/webstore/program-policies/policies)
- **Precedent:** Vanced (cease-and-desist 2022), Streamus (API key revoked). YouTube blocks datacenter IPs from downloading. No takedown of a music-removal tool found. Not legal advice.

## 5. Where we can win

- **Quality, measured and published.** Nobody publishes leak rates or latency. A public benchmark on a fixed clip set is cheap marketing and keeps us honest.
- **A singing choice.** Speech enhancers keep sung vocals, which suits nasheeds and recitation but fails for pop songs. Offering "keep vocals" vs "remove all singing" is a real feature no one has.
- **Live streams and sites beyond YouTube.** HaramMute excludes live streams. In-page processing works on any `<video>`.
- **Instant start, no account, no server.** Server-based competitors make people wait and break when YouTube blocks them.

Threats: Samsung Audio Eraser and a likely Google or Apple equivalent, AudioShake licensing to a well-funded competitor, HaramMute's lead, and a low barrier to clones.
