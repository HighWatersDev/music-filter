# Music filter: design

Date: 2026-10-19
Status: validated in brainstorming, not started

## Problem

The previous approach downloaded each video, ran separation on a free-tier GPU, re-encoded with ffmpeg, then played the result. It needed downloads, storage and GPU time per video, so it did not scale.

Goal: remove music from videos as they play, starting with YouTube, with nothing downloaded or stored.

## Decisions

| Question | Decision |
|---|---|
| Where videos play | YouTube first, other sites and restreaming later |
| What remains after filtering | v1 voices only, v2 everything but music |
| Devices | v1: desktop Chrome, Edge, Brave, Firefox and Safari, iPhone/iPad Safari (extension shipped in an App Store app), Firefox for Android. Chrome on phones has no extensions. Android Play Store wrapper app deferred (policy risk). Decided 2026-10-25. |
| Audio access | Read-ahead: copy YouTube's audio appends in a MAIN-world script, decode, filter ahead of the playhead, play in sync. Replaces hooking the `<video>` element, which Safari returns silence for. Decided 2026-10-25. |
| Model (v1) | DeepFilterNet3, voice only. Bundled, about 20x faster than real time, no download. MRX dropped because it leaves music audible. Decided 2026-10-25. |
| When filtered audio is not ready | Pause the video until it is (like buffering). The original track is never played while the filter is on. Speeds other than 1x and unsupported audio are muted with a message. Decided 2026-10-25. |
| Sung vocals | Allowed to leak in v1, fixed by a fine-tune in v1.1 |

Rejected for v1:

- `chrome.tabCapture`: Chrome only, needs a click per tab, harder per-video UI. Possible later fallback for players A cannot hook.
- System virtual audio device: native installer and OS drivers, too heavy for v1.

## Architecture (v1)

Manifest V3 extension for Chrome and Firefox. No backend. All processing runs on the user's machine.

- **Content script**
  - Finds the active `<video>`.
  - Handles YouTube SPA navigation (`yt-navigate-finish`) and new players via MutationObserver.
  - Attaches the audio graph once per element, tracked in a WeakSet.
- **Audio graph:** `MediaElementSource → AudioWorkletNode (denoiser) → GainNode → destination`. `AudioContext` fixed at 48 kHz to match DeepFilterNet3.
- **Denoiser worklet**
  - DeepFilterNet3 compiled to WASM.
  - A ring buffer converts WebAudio's 128-sample blocks into the model's 480-sample (10 ms) frames.
  - The extension loads the model bytes and passes them in, since a worklet cannot fetch.
- **Popup:** on/off, strength slider (blend of original and processed audio), per-site enable list.

Constraints:

- After `createMediaElementSource`, the element's audio only plays through the graph. "Off" means routing the graph to pass-through, not detaching.
- Added delay is about 40 to 70 ms. DeepFilterNet3's algorithmic latency is about 40 ms (20 ms window plus 2 frames of lookahead), plus output buffering. Audio up to 125 ms late is within ITU-R BT.1359 detectability, so no video delay is needed in v1.

CSP risk, resolved by a live probe on 2026-10-19 (Chrome 148, see `docs/research/2026-10-19-landscape.md`):

- Load the worklet from a `chrome-extension://` web_accessible_resource. Blob URLs are blocked by YouTube's CSP.
- Compile the WASM in the content script and pass the `WebAssembly.Module` through `processorOptions`. Compiling inside the worklet also works today, but only because YouTube allows `'unsafe-eval'`.
- `performance.now` does not exist in AudioWorkletGlobalScope. Time frames with `Date.now`.
- No Workers and no SharedArrayBuffer from the content script on YouTube. DeepFilterNet3 must fit a single audio thread with SIMD.

Reference implementation: [WorkAdventure noise-suppression](https://github.com/workadventure/noise-suppression) runs libDF compiled to WASM in an AudioWorklet at 2.7% of an M4 core.

Fallback if YouTube tightens its CSP: `chrome.tabCapture` with an offscreen document, as the NoMusic extension does.

## Model

| Option | Size / cost | Music removal |
|---|---|---|
| DeepFilterNet3 (chosen) | Few MB, 10 to 20% of one core | Good on background music under speech |
| RNNoise | ~100 KB | Weak, passes melodic music |
| Small separation model | 10 to 30 MB, WebGPU | Better, deferred to v2 |

DeepFilterNet is MIT/Apache licensed. Its Rust core (`libDF`, `tract` backend) compiles to WASM. The spike confirms real-time performance inside an AudioWorklet.

Known weakness: speech enhancement keeps singing because it sounds like a voice.

- Vlog or podcast with background music: works well.
- Instrumental intro or outro: removed.
- Song with lyrics: the vocals come through, with the instruments mostly gone.

Likely root cause: DNS Challenge clean speech, which DeepFilterNet3 trained on, includes singing from VocalSet. The model was taught that singing is speech.

v1.1 fix: retrain or fine-tune DeepFilterNet with singing moved to the noise side. Drop VocalSet from the clean set and add sung vocals (MUSDB18, MoisesDB, DnR v3) as noise. One rented-GPU job, about 1 to 2 days on an A100. Same model size, so no extension changes. Candidate upgrade if quality needs it: DPDFNet (Apache-2.0, causal, ONNX), which needs a WASM CPU benchmark first.

Product angle: keeping sung vocals suits nasheeds and recitation, and removing them suits pop songs. Shipping both weights as a "keep vocals / remove all singing" toggle is a feature no competitor has.

## Failure handling

Rule: the extension must never leave the user with silent video.

| Failure | Handling |
|---|---|
| `AudioContext` suspended by autoplay policy | Attach only when `state === 'running'`. `resume()` on the `play` event. |
| CPU cannot keep up | Time each frame in the worklet. After N overruns in a row, switch to pass-through and show a badge. |
| DRM site gives silence | Silence for about 2 s while `!video.muted && volume > 0` → pass-through, mark site unsupported. |
| Extension reloaded or updated | On disconnect, reload the tab or show a "reload to restore audio" banner. |
| CSP blocks worklet | Offscreen-document graph for that site, or mark unsupported. |
| Player swaps elements (ads, PiP, next episode) | WeakSet plus MutationObserver attaches to replacements. |
| Playback speed, seek | No special handling needed. |

## Testing

- Unit: block-to-frame ring buffer, silence detector, overrun detector.
- Golden: `OfflineAudioContext` renders a fixture clip through the real worklet. Output compared to native `libDF` within an SNR tolerance.
- Performance: each 10 ms frame under 3 ms on a low-end laptop, measured in the worklet.
- End-to-end: Playwright Chromium with the unpacked extension on a local `<video>` page. Checks the graph attaches, audio is not silent, and pass-through works. YouTube gets a manual smoke checklist.
- Quality: 20 fixed clips (vlog with background music, podcast with music bed, talk with live singing, music video). Score 1 to 5 by ear for speech clarity and music left over, plus DNSMOS. Rerun whenever weights change.

## Roadmap

| Stage | Scope |
|---|---|
| Spike (½ to 1 day) | Worklet and WASM load on YouTube despite its CSP. DeepFilterNet3 runs in real time in the worklet. |
| v1 | Chrome and Firefox extension, voices only, stock weights |
| v1.1 | Singing-as-noise fine-tune, swap weights |
| v2, everything but music | Candidates: Bandit v2 (Apache-2.0, dialogue / music / effects) streamed with the one-hop method from arXiv 2609.35397, or a distilled causal student. The model runs in a hidden web-accessible extension iframe, which has Workers and WebGPU, bridged to the worklet with a transferred MessagePort. If a 1 to 3 s buffer is needed, delay the picture with a `requestVideoFrameCallback` canvas ring buffer (prior art: Frame Sync). A second look-ahead `<video>` cannot share YouTube's MSE source. |
| Restream mode | Deprioritised. YouTube's ToS bans modifying content and anything beyond personal viewing, and its API policy bans isolating audio and caching. Only viable for content we have rights to. |
| Mobile | Decided 2026-10-25: browser extensions only. **iPhone/iPad:** Safari Web Extension shipped in an App Store app, using the read-ahead pipeline. Safari returns silence to `createMediaElementSource` for YouTube, so the live tap cannot work there. Add a share-sheet action that opens a YouTube app link in Safari. **Android:** Firefox for Android extension. Both the live tap and read-ahead work there, CPU only. Rejected: downloading YouTube audio in an app (ToS, App Store 5.2.3, YouTube blocking) and an in-app web view wrapper (App Review 5.2.2 risk). Evidence: `docs/spikes/2026-10-25-mobile-results.md`. |

Competitors, policy and model options are in `docs/research/2026-10-19-landscape.md`.
