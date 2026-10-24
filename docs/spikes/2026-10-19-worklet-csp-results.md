# Spike results: DeepFilterNet3 AudioWorklet on YouTube

Date: 2026-10-24
Browser: Chrome for Testing 156.0.8078.4, `--headless=new`, via Playwright 1.49.1
Machine: Apple M2 Pro, macOS 26.6.2
DeepFilterNet commit: d375b2d8309e0935d165700c91da9de862a99c31 (see `vendor/df/SOURCE`)
WASM / model size: 9,013,611 bytes / 7,983,136 bytes
Toolchain: rustc 1.99.1, wasm-pack 0.15.0, wasm-bindgen 0.2.92, Node 24.8.0

All runs below were automated and headless. Headless Chrome uses a fake audio output, so nobody has listened yet. G3's crackle check, G4 and the lip-sync part of G5 still need a person.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| G1 Load | **PASS** | Both `extension-url` strategies reach `ready` on a YouTube watch page. Both `blob-url` strategies are blocked by YouTube's allowlist `script-src`. |
| G2 Speed | **PASS** | Node: mean 0.50 ms per 10 ms frame on synthetic sine plus noise, which probably takes DeepFilterNet's cheap low-SNR path. Browser on real audio: mean 1.09 ms. Both are under the 3 ms limit. Treat the browser figure as the real one. |
| G3 Real time (browser) | **Provisional pass, needs listening** | Control page, 5 min real audio, `interactive`: worst p95 2 ms, overQuantum 0.28%. YouTube real audio was limited to about 33 s per run (see notes). Interactive passed. One playback run failed (p95 3 ms, 2.0%). |
| G4 Sound | **Not run** | Needs a person. Expect music-only stretches to come out as true silence. |
| G5 Delay | **Pass for `interactive` (headless numbers)** | 5.3 + 32.0 + 40 = 77.3 ms. `playback` gives 109 to 117 ms and fails. Lip-sync not checked. |

Measured total processing delay is 1920 samples (40 ms): 480 from the frame adapter plus 1440 inside DeepFilterNet3. Filtered, bypass and every failure path now share that delay, so toggling bypass does not skip or repeat audio.

## Strategy probe

| Loader | Compile in | Control page | YouTube | Error |
|---|---|---|---|---|
| extension-url | content-script | PASS, 438 ms | PASS, 410 ms | |
| extension-url | worklet | PASS, 318 ms | PASS, 282 ms | |
| blob-url | content-script | PASS, 286 ms | FAIL | `Failed to load worklet module script: blob:https://www.youtube.com/… (a dependency or cross-origin script failed to load)` |
| blob-url | worklet | PASS, 286 ms | FAIL | same |

- The blob failures are not AbortErrors, unlike the plan's expectation.
- No `securitypolicyviolation` event reaches the document, so the probe's `csp` arrays are empty. The violation shows only in the worklet's console (CDP source "worker"). It cites the allowlist `script-src`, falling back from `script-src-elem`.
- v1 choice: `extension-url` loader, `content-script` compile. Worklet compile also works, but only because YouTube allows `'unsafe-eval'`.

## YouTube CSP header

A plain `curl -sI` returns 2 policies. With a Chrome user agent, and in the browser, there are 3. All 3 are enforced, and none is report-only.

```
content-security-policy: script-src 'unsafe-eval' 'self' 'unsafe-inline' https://www.google.com https://apis.google.com https://ssl.gstatic.com https://www.gstatic.com https://www.googletagmanager.com https://www.google-analytics.com https://*.youtube.com https://*.google.com https://*.gstatic.com https://youtube.com https://www.youtube.com https://google.com https://*.doubleclick.net https://*.googleapis.com https://www.googleadservices.com https://tpc.googlesyndication.com https://www.youtubekids.com https://www.youtube-nocookie.com https://www.youtubeeducation.com https://www-onepick-opensocial.googleusercontent.com;report-uri https://csp.withgoogle.com/csp/youtube_main/allowlist
content-security-policy: require-trusted-types-for 'script'
content-security-policy: base-uri 'self';object-src 'none';script-src 'report-sample' 'nonce-…' 'unsafe-inline' 'strict-dynamic' https: http: 'unsafe-eval';report-uri https://csp.withgoogle.com/csp/youtube_main/strict
```

- There is no `worker-src`, no `blob:` and no `'wasm-unsafe-eval'`.
- The plan's curl misses the allowlist policy, which is the one that blocks blob worklets.

## Frame timing

Worklet timing uses `Date.now`, because `performance` does not exist in AudioWorkletGlobalScope. Browser p95 and max are in whole milliseconds, so `overQuantum` effectively counts frames of 3 ms or more.

Node bench (60 s, 440 Hz sine plus noise):

```json
{ "frameLength": 480, "realtimeFactor": 0.0503, "count": 6000, "meanMs": 0.503, "p95Ms": 0.581, "maxMs": 17.12, "overBudget": 1, "overQuantum": 2, "budgetMs": 10, "quantumMs": 2.667 }
```

Browser runs (stats windows are 100 frames, about 1 s each):

| Run | Frames | Mean ms | Worst p95 | Max | overQuantum % | G3 |
|---|---|---|---|---|---|---|
| Control page, interactive, 5 min real audio | 30000 | 1.09 | 2 | 7 | 0.28% | PASS |
| Control page, playback, 2 min real audio | 12000 | 1.10 | 2 | 5 | 0.34% | PASS |
| YouTube, interactive, first 33 s real audio | 3400 | 0.75 | 2 | 2 | 0.00% | PASS |
| YouTube, playback, first 35 s real audio | 3600 | 1.09 | 3 | 4 | 2.00% | FAIL |
| YouTube, interactive, 30 s smoke run | 3000 | n/a | 3 | 6 | 3.33% | FAIL |

- Variance between runs is large. The failing YouTube windows fall 12 to 35 s after a page load, when YouTube's own scripts are busy.
- YouTube's player stops by itself 33 to 45 s into every headless playback ("Something went wrong"). It also does this with the extension loaded but not attached, so it looks like YouTube's automation detection, not our filter. Real YouTube timing therefore needs a headed run by a person.

## Behaviour found during the spike

- **Music-only frames become true silence.** DeepFilterNet zeroes whole frames it judges as pure noise: 90 of 106 frames on a steady sine. This is the intended effect, but it bears on how bypass is presented in the UI.
- **One NaN input poisons the model for good.** The processor now detects any non-finite output and falls back to delay-matched pass-through permanently.
- **`df_create` takes about 400 ms on the audio thread.** The media element is connected only after `ready`, so playback isn't affected, but any other node in that context would glitch.
- **Every node leaks about 10 MB of wasm memory.** v1 needs one node per context and a dispose path.
- **Bypass keeps running the model** so switching back has no stale lookahead. Bypass therefore saves no CPU.
- **Chrome logs "Unsafe attempt to load URL chrome-extension://…"** for each asset fetch on YouTube. The fetches still succeed.

## Listening scores

To be filled in by a person, on wired headphones or speakers. Bluetooth adds its own delay.

1. Run `npm run build:worklet`.
2. Load `extension/` unpacked in Chrome.
3. Open a watch page and start playback.
4. Click **Attach** in the panel at the bottom left. The status line should say `video=main-player`.
5. Click **Bypass** to compare filtered and original audio.
6. Copy the `totals` overlay line at the end for G3. It only counts time while the video is playing.

Bypass has the same 40 ms delay as filtering, so judge lip-sync against a fresh reload with nothing attached.

| Clip | Speech clarity 1-5 | Music left 1-5 | Crackles? | Lip-sync OK? | Notes |
|---|---|---|---|---|---|
| Vlog with background music | | | | | |
| Podcast with music intro | | | | | |
| Music video | | | | | |

## Decision

**Provisional go for approach A**, using the `extension-url` loader with content-script compile and `latencyHint: 'interactive'`.

- Loading and per-frame speed are proven on YouTube.
- Real-time stability on YouTube, sound quality and lip-sync need a 10-minute headed listening session before v1 planning.
- If YouTube playback crackles under load, try `playback` latency first. If that still fails, the next step is moving inference off the audio thread into a hidden extension iframe with a Worker.

Changes for the v1 plan:

- Fix the delay at 1920 samples.
- One node per AudioContext, with a dispose message.
- Design the bypass UI around music becoming silence.
- Do not rely on `securitypolicyviolation` events for diagnostics.
