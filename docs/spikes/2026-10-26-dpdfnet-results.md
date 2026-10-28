# DPDFNet swap results

Date: 2026-10-26
Version: 0.2.0
Plan: `docs/plans/2026-10-26-dpdfnet-swap.md`

## Outcome

The user listened to live mode in Chrome on desktop: **"this sounds much cleaner."** The earlier choppiness came from DeepFilterNet3 itself, which gates speech whenever music sits under it. DPDFNet fixes that.

## How it got here

| Step | Finding |
|---|---|
| Read-ahead build with DeepFilterNet3 | User: choppy, paused often |
| Investigation | A false starvation replay plus a crossfade collision caused dips. Both fixed. Pauses not reproduced. |
| Live mode with DeepFilterNet3 | User: still choppy |
| Offline A/B, no browser involved | DeepFilterNet3 itself chops speech under music: 57 dropouts/min at 0 dB vs a baseline of 12 |
| Light-model sweep (15 variants, browser timings) | DPDFNet 16 kHz is the only light family close to TIGER. User picked DPDFNet-4 16k and DBS-TIGER by ear. |
| tract spike | Both DPDFNet 16 kHz models run in an AudioWorklet and match onnxruntime to about 130 dB |
| Swap | Live mode: DPDFNet-4 or DPDFNet-2 chosen by a warm-up check. Read-ahead: DPDFNet-4, dropping to DPDFNet-2 above RTF 0.6. |

## Measurements (M2 Pro)

| Item | Value |
|---|---|
| Live model chosen in Chrome and Firefox | DPDFNet-2. DPDFNet-4 costs 3.4 to 3.5 ms per 10 ms hop on real audio, which leaves too little headroom. |
| DPDFNet-2 real-audio cost | Mean 2.65 to 2.81 ms, p99 4.5 to 4.7 ms. Chrome renders 256 frames per callback (5.33 ms), so a hop over one quantum does not glitch. 0 glitches in traces. |
| End-to-end delay, live | 98 ms in Chrome (66 ms engine plus 32 ms output), 89 ms in Firefox. A 165 ms hidden buffer bloat from the blocking worklet start was fixed by building the node while the context is suspended. |
| Read-ahead RTF | DPDFNet-4 about 0.25 including a 1 s context warm-up |
| Memory | Live ArrayBuffers 57 MB down to 2 MB. Worklet wasm memory about 51 MB. |
| Tests | 331 unit, live e2e with a latency trace assertion, read-ahead e2e, 5 Rust tests |

## Mode by platform

| Platform | Mode | Model |
|---|---|---|
| Desktop Chrome, Edge, Firefox | Live | DPDFNet-4 if the warm-up is under 2 ms per hop, else DPDFNet-2. Read-ahead if both are too slow. |
| Safari (iPhone, iPad, Mac) | Read-ahead | DPDFNet-4, DPDFNet-2 if the first window runs slower than RTF 0.6 |
| Phones and tablets in other browsers (Firefox Android, Chrome Android) | Read-ahead | Same |

## iPhone simulator, read-ahead with DPDFNet-4

| Check | Result |
|---|---|
| Loading | `dpdf_bg.wasm` and `dpdfnet4.onnx` load in Safari's extension Worker. No CSP errors. |
| Speed | 10 s windows in 2.4 to 2.8 s on the Mac CPU. The DPDFNet-2 switch never triggered. |
| 3 min playback, speech and Big Buck Bunny | Always filtered, no holds after the start |
| Ads | Filtered. YouTube unmutes on each source swap and the extension re-mutes in the same event turn. |
| Seek back 15 s, 1.5x mute, toggle off | Correct |
| Seek forward 60 s, before the fix | Reload loop: 24 replays in 4 min, 31% of samples held |
| Seek forward 60 s, after the fix | 1 replay and 1 hold per seek (1.2 s and 2.0 s), 0.4% and 1.8% of samples held |

The loop had two causes. A replay resends the retained bytes oldest first, and the engine reported "starved" after the first stale chunks, before the audio near the playhead arrived. The worker also runs up to 10 s behind while it filters back-to-back windows, so a starved report from a replaced engine could start another replay. Now each replay ends with a `stream-replay-end` marker, the engine stays quiet until it arrives, and the content script ignores starved reports whose `resetId` is not the latest.

## Android emulator, Firefox 158, read-ahead with DPDFNet-4 (2026-10-27)

| Check | Result |
|---|---|
| Emulator | arm64 under Hypervisor.framework, 4 vCPU (the 2026-10-25 DeepFilterNet3 run had 1) |
| Loading | wasm with SIMD and dpdfnet4.onnx load in the Worker. No errors. |
| 10 s window | Speech 4.2 to 9.6 s (median 5.9), Big Buck Bunny median 4.7. DeepFilterNet3 took 7 to 31 s. |
| Playback | 2 holds at the start, then none in 3 minutes per video. Up to 35 s ready ahead. |
| Seeks, 1.5x, toggle off, mute safety | Correct. One replay per seek past YouTube's buffer, no loop. |
| Filter on before first play | **Stuck at 0:00 in 4 of 5 starts.** YouTube's first source failed to decode, and the extension had already paused the element, so YouTube never resumed after swapping in a new one. |

Fix: the hold policy no longer pauses a video below `HAVE_FUTURE_DATA`, since it is not advancing yet. The original audio stays at level 0 either way. Re-verified on the 1.0.0 store build: 7 of 7 starts with the filter on before play now play, plus an autoplay-next case. YouTube itself takes about 10 s and two decode errors to start on this emulator, the same with the filter off. First filtered audio arrives 2.6 to 3.8 s after YouTube starts playing.

## Still open

- Real iPhone and real Android phone: speed and behaviour.
- Read-ahead decodes Opus only. An AAC stream fails with "unsupported audio type". Seen once on the iPad simulator.
- The worker's message lag (p95 5.4 s on the simulator) comes from filtering a whole window without yielding. Only the 5 s replay throttle stops a starved report at the end of a replay from starting another one.
- The panel names no model in read-ahead until a drop to DPDFNet-2.
- A pointless replay fires when a video ends.
- Sung vocals still come through. That needs v1.1 work (fine-tune, or a speech-vs-singing gate).
- Store packaging: icons, listing, privacy text.
