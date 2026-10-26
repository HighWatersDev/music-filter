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

## Still open

- iPhone simulator check of read-ahead with DPDFNet (last checked with DeepFilterNet3).
- Real iPhone and real Android phone: speed and behaviour.
- Sung vocals still come through. That needs v1.1 work (fine-tune, or a speech-vs-singing gate).
- Store packaging: icons, listing, privacy text.
