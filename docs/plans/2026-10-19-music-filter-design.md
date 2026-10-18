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
| Devices | v1 desktop browsers, v2 mobile |
| Audio access | Hook the page's `<video>` element (approach A) |
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
- Added delay is about 30 to 40 ms, below noticeable lip-sync drift. No video delay is needed in v1.

Main risk: YouTube's Content Security Policy may block loading the worklet module or WASM from a content script. Fallbacks are a Blob URL worklet or running the graph in an offscreen document. The spike settles this first.

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

v1.1 fix: fine-tune DeepFilterNet with singing labelled as noise. Mix clean speech (DNS Challenge, LibriSpeech) with full songs including vocals (MUSDB18, FMA), and train it to output speech only. One rented-GPU job, about 1 to 2 days on an A100. Same model size, so no extension changes.

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
| v2, everything but music | Evaluate low-latency separation (e.g. HS-TasNet) first. If a 1 to 3 s buffer is still needed, sync with a hidden look-ahead `<video>` that plays D seconds ahead and feeds the model while the visible one plays muted with processed audio. |
| Restream mode | Same model natively in a relay: ffmpeg in → libDF → HLS out. Voices only needs about 1 CPU core per stream, no GPU. Settle copyright and terms-of-service questions for third-party content first. |
| Mobile | The YouTube app cannot be filtered and the cross-origin iframe player blocks audio access. Likely needs our own player backed by restream mode. |
