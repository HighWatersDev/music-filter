# Mobile spike: iPhone Safari and Firefox for Android

## Summary

| | iPhone Safari (simulator) | Firefox for Android (emulator) |
|---|---|---|
| Extension runs on m.youtube.com | Yes | Yes |
| YouTube streams with | ManagedMediaSource | MediaSource |
| Tap the video's audio (`createMediaElementSource`) | **Silence** | **Works** (peak 0.72) |
| Copy audio chunks from the player | Works (Opus/WebM) | Works (Opus/WebM, 331 chunks, 1.36 MB) |
| Decode copied chunks (`decodeAudioData`) | Works (50 s) | Works (10 s, see note) |
| WebCodecs `AudioDecoder` | Yes, Opus supported | Missing |
| WebGPU | Yes | No |
| WASM SIMD / AudioWorklet | Yes / Yes | Yes / Yes |
| Live speech-only filter possible | **No** | **Yes** |
| Read-ahead keep-effects pipeline possible | Yes | Yes, CPU only |

Firefox note: `decodeAudioData` returned only the first 10 s of a 1.36 MB stream, probably because it stops at a second init segment or a discontinuity. A production pipeline needs its own WebM demuxer on Firefox, since it has no WebCodecs to fall back on.

## Firefox for Android details

Date: 2026-10-25
Device: Android 17 emulator (API 37, arm64), Firefox 158.0.2 from archive.mozilla.org (signed by Mozilla Release Engineering).
Build: `scripts/build-firefox.sh` copies `extension/` to `build/firefox` and adds `browser_specific_settings.gecko`. Loaded as a temporary add-on with `web-ext run -t firefox-android` (web-ext 10.7.0), after enabling "Remote debugging via USB" in Firefox settings.

- The MAIN-world chunk tap installed on the first page load. No timing miss seen in one run.
- MV3 host permission was granted at install for the temporary add-on. A store install would show the permission prompt.
- Screenshot: `2026-10-25-android-firefox-diagnose.png`.

## iPhone Safari details

Date: 2026-10-25
Device: iPhone 17 simulator, iOS 27.0, Safari 27 (Xcode 27.1). Not yet confirmed on a real iPhone.
Build: `scripts/build-safari.sh` wraps `extension/` with `safari-web-extension-converter`. The app is built for the simulator with ad-hoc signing.

## Result

| Question | Answer |
|---|---|
| Does the extension run in iPhone Safari? | **Yes.** Both panels render on m.youtube.com after enabling the extension and allowing the site. |
| What does YouTube stream with? | **ManagedMediaSource** (`video.src` is a `blob:`), not native HLS. `MediaSource` is absent, `ManagedMediaSource` is present. |
| Does tapping the video's audio work (`createMediaElementSource`)? | **No.** It returns silence (peak 0.0000) for YouTube's ManagedMediaSource video. A plain MP4 on a local page gives real audio (peak 0.13), so the silence is specific to ManagedMediaSource. |
| Can we copy YouTube's audio chunks? | **Yes.** A MAIN-world script wrapping `ManagedSourceBuffer.prototype.appendBuffer` captured `audio/webm; codecs="opus"`, 361 chunks, 837 KB. |
| Can we decode them? | **Yes.** `decodeAudioData` on the chunks in order gave 50.0 s of stereo 48 kHz audio, peak 0.75. WebCodecs `AudioDecoder` also reports Opus as supported. |
| Other capabilities | AudioWorklet, WebGPU and WASM SIMD are available. Not cross-origin isolated, so WASM runs single-threaded. |

Screenshots: `2026-10-25-iphone-silence.png` (element tap silent) and `2026-10-25-iphone-diagnose.png` (chunk copy and decode working).

## What it means

- **The live speech-only filter (DeepFilterNet3 on the element's audio) cannot work on iPhone.** It depends on `createMediaElementSource`, which returns silence for YouTube there.
- **The read-ahead design works on iPhone.** Copy the audio chunks, decode them, separate them ahead of the playhead, then play the result from our own AudioContext while the video element is muted. This is the same design planned for the desktop keep-effects mode, so one pipeline can serve desktop and iPhone.
- YouTube had about 50 s of audio buffered ahead, which gives the separation model a large time budget.

## Risks found

1. **Install timing race.** On one of three page loads the MAIN-world script ran after YouTube had created its ManagedMediaSource, and captured nothing. A reload fixed it. v1 needs a fallback: detect the miss and reload the player, or re-hook on the next source.
2. **Speed on a phone is unmeasured.** MRX runs at 0.76x real time single-threaded on an M2 Pro. An iPhone CPU is slower, and the simulator uses the Mac's CPU, so it proves nothing about speed. WebGPU is available and needs measuring on a real device.
3. **Simulator vs real device.** Media behaviour in the simulator usually matches iOS, but the silent tap and the chunk decode both need confirming on a real iPhone.
4. **YouTube's audio format can vary.** Here it was Opus in WebM. Other videos or clients may get AAC in MP4. Both `decodeAudioData` and WebCodecs should be tested on both.
5. **Enabling the extension in the simulator** needed a drag gesture on the toggle in Safari's Manage Extensions sheet. Taps did not register. This is a test harness quirk, not a user issue.

## Next steps

1. Repeat on a real iPhone, with a free Apple developer account and the Xcode project in `build/safari`.
2. Measure MRX on a real iPhone (WASM and WebGPU) on 30 s of decoded audio.
3. Same checks on the iPad simulator (desktop-class site, likely `MediaSource`).
4. Measure MRX speed on a mid-range Android phone in Firefox, CPU only.
