# Read-ahead pipeline results

Dates: 2026-10-25 to 2026-10-26
Plan: `docs/plans/2026-10-25-read-ahead-pipeline.md`
Build: voice only with DeepFilterNet3, pause until filtered audio is ready, original track never audible while the filter is on.

## Summary

| Platform | Result | Time to first filtered audio | Speed (10 s window) | Notes |
|---|---|---|---|---|
| Chrome desktop, local MSE page (headless) | **Pass** | 0.56 s fake model, 0.98 s real model | 0.5 s | e2e covers hold, resume, seek back past keep-behind, 1.5x mute, user pause, toggle off |
| Chrome desktop, real YouTube (headless) | **Pass** | 1.0 to 1.9 s | 0.6 to 1.3 s | 25 to 38 s ready ahead. Rewinds resume in 0.24 to 0.57 s after the fix. Forward seeks past 60 s untestable headless. |
| Safari, iPhone 17 simulator, m.youtube.com | **Pass** (after a tap fix) | 2.8 to 6.3 s | 1.4 to 3.0 s on the Mac CPU | Element muted the whole time, YouTube UI not shown muted. Seeks, 1.5x and toggle off all correct. |
| Firefox for Android, emulator | **Partial** | about 10 s | 7 to 31 s, typically 13 s | Slower than real time, so playback pauses 2 to 6 s every 9 s or so. Turning the filter on before the first play stalled YouTube (fix landed, unverified). |
| Firefox desktop | Not tested | | | |
| Real iPhone or Android phone | Not tested | | | |

Nobody has listened yet. Every run used headless Chrome or simulators with no audible check.

## Bugs found by running it, all fixed

| Bug | Found by | Fix |
|---|---|---|
| Planner re-planned the first window forever | Running the plan's code | Planner tolerates the pre-skip gap |
| Gap in decoded audio (every quality switch) stalled the planner | Review | Small holes are bridged and zero-filled |
| Demuxer wedged after a callback error, false resyncs on Opus payload | Review | Offset advanced first, resync validated by a following Timecode |
| Original audio could leak when re-attaching to a video element | Review | One original-audio control per element, fail closed |
| Separator retried a new iframe and Worker on every tick after a failure | Review | Failure latched until the user re-enables |
| Window boundaries mismatched (cold model state) | Engine check | Model warmed up on the 2 s before each window. Worst boundary -1.4 dB to -9.1 dB. |
| Rewinding more than 10 s held for 30 s then went silent | Real YouTube | Engine reports starvation, content replays retained bytes |
| iPhone: tap captured nothing | iPhone simulator | Wrap the prototype that owns each method. `ManagedMediaSource` inherits it. |
| Firefox reused a cached old copy during `web-ext run` | Android emulator | Version bumped to 0.1.0 |
| Firefox Android: filter on before first play stalled YouTube | Android emulator | Graph attach deferred until the video has metadata. Not re-verified. |

## Open issues

1. **Android speed.** DeepFilterNet3 runs about 26x slower in Firefox on the emulator than in Chrome on the same Mac (13 s vs 0.5 s per 10 s). It is unclear whether this is the emulator, Firefox's WebAssembly on Android, or both. A real mid-range Android phone in Firefox is the next measurement. If it is still slower than real time, options are smaller windows with a lower model cost, a faster model (GTCRN), or Firefox WebAssembly threads where available.
2. **iOS `video.volume` is read-only.** Mute mode relies on `video.muted` alone on iPhone. That works, but the plan's "volume 0" note does not apply on iOS.
3. **Forward seeks past what YouTube has buffered** were only tested on iPhone (held 1 to 2.5 s, then resumed). Headless Chrome on YouTube cannot buffer past 60 s.
4. **Ads** never played in any run, so filtering ads is untested.
5. **The tap can miss the first MediaSource** if the MAIN-world script installs late. It was seen once in the mobile spike, not in these runs. A reload recovers.
6. **Worker keeps processing an old stream** after the user navigates away, until its lookahead fills. CPU only, output ignored.

## Listening checklist

On Chrome desktop with the unpacked extension (`npm run build`, load `extension/`):

| Clip | Speech kept 1-5 | Music left 1-5 (1 = none) | Clicks at boundaries? | Lip-sync OK? | Notes |
|---|---|---|---|---|---|
| Documentary with a score | | | | | |
| Gaming video with music | | | | | |
| Cartoon | | | | | |
| Music video (singing expected to leak) | | | | | |

Also note how often the video pauses to filter, and whether turning the filter on and off ever plays a moment of the original music.

## Next steps

1. Listening test on Chrome desktop (checklist above).
2. Real iPhone: install the Safari build with a free developer account and repeat the simulator checks.
3. Real Android phone in Firefox: measure window speed and re-check the first-play stall.
4. Firefox desktop smoke test.
5. Then v1.1: singing removal (fine-tune), and v2: keep effects.
