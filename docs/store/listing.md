# Store listings

Copy for each store. Keep the four in sync when the product changes.

Links used everywhere:
- Homepage and support: https://github.com/HighWatersDev/music-filter
- Support (issues): https://github.com/HighWatersDev/music-filter/issues
- Privacy policy: https://github.com/HighWatersDev/music-filter/blob/main/PRIVACY.md

## Shared copy

**Name:** Music Filter

**Short description** (Chrome allows 132 characters, Edge and Firefox 250):
> Removes background music from YouTube videos and keeps the voices. Runs on your device. Nothing is uploaded.

**Long description:**

> Music Filter removes background music from YouTube videos as they play and keeps the voices.
>
> Use it to follow a talk, lecture, podcast or vlog without the soundtrack. It helps with focus, sensory sensitivity, or a personal preference to avoid music.
>
> How to use it
> • Open a YouTube video.
> • Press "Music filter: OFF" in the top-left corner to turn it on.
> • Press it again to hear the original audio.
>
> What to expect
> • Speech comes through clearly. Most music is removed, including music under speech.
> • It keeps voices only, so sound effects and ambient sound are removed too.
> • Singing is a voice, so sung vocals still come through.
> • While the filter is on, the original music never plays. If filtering fails, the video is muted with a message.
>
> Private by design
> • The filtering model runs inside your browser.
> • No account, no analytics, no data collection, no server.
> • Audio is held in memory only while you watch.
>
> Open source under Apache-2.0. Uses the DPDFNet speech enhancement model by Ceva.

## Chrome Web Store

| Field | Value |
|---|---|
| Category | Accessibility |
| Language | English |
| Single purpose | Removes music from the audio of YouTube videos while they play. |
| Host permission justification (`youtube.com`, `m.youtube.com`) | The content scripts read the audio YouTube streams to the page so the extension can filter out music and play the filtered audio in sync with the video. It does nothing on other sites. |
| Remote code | No. All code and the model ship in the package. |
| Data usage | Collects none of the listed data types. Certify all three disclosures. |
| Privacy policy URL | See links above |
| Screenshots | `docs/store/screenshots/chrome-*.png`, 1280×800 |
| Small promo tile | `docs/store/screenshots/promo-440x280.png` |

## Edge Add-ons

Same package and copy as Chrome. Category: Accessibility.

## Firefox Add-ons (desktop and Android)

| Field | Value |
|---|---|
| Add-on ID | `music-filter@highwatersdev` |
| Categories | Desktop: Photos, Music & Videos. Android: Photos & Media. |
| Compatible with | Firefox and Firefox for Android |
| Data collection | None (declared in the manifest) |
| License | Apache License 2.0 |
| Source code | Upload `build/store/music-filter-source-<version>.zip`. Build steps are in README.md. |
| Screenshots | `docs/store/screenshots/chrome-*.png` work here too |

**Notes to reviewer:**
> The bundled JavaScript in dist/ is built with esbuild from src/ (npm run build). It is not minified.
> assets/dpdf_bg.wasm is compiled from the Rust crate in native/dpdf (npm run build:dpdf). The pinned toolchain is in native/dpdf/rust-toolchain.toml, and vendor/dpdf/SOURCE records the expected sha256.
> assets/dpdfnet4.onnx and dpdfnet2.onnx are the Apache-2.0 DPDFNet models from huggingface.co/Ceva-IP/DPDFNet at a pinned revision. scripts/fetch-models.sh downloads them and checks their sha256.
> To test: open any YouTube video with talking over background music, then press "Music filter: OFF" at the top left.

## Apple App Store (iPhone, iPad, Mac)

| Field | Value |
|---|---|
| App name | Music Filter |
| Subtitle (30 chars) | Voices on, music off |
| Bundle ID | `io.github.highwatersdev.musicfilter` (extension: `.extension`) |
| Primary category | Utilities |
| Secondary category | Entertainment |
| Price | Free |
| Age rating | 4+ (no objectionable content) |
| App privacy | Data Not Collected |
| Export compliance | Uses no non-exempt encryption (`ITSAppUsesNonExemptEncryption` = NO) |
| Support URL | Issues link above |
| Privacy policy URL | See links above |
| Copyright | 2026 Rinat Kirimov |
| Screenshots | iPhone 6.9": `docs/store/screenshots/iphone-*.png`. iPad 13": `ipad-*.png`. Mac: not made yet (see checklist.md). |

**Promotional text** (170 chars):
> Watch YouTube without the background music. Music Filter keeps the voices and removes the soundtrack, right in Safari, on your device.

**Keywords** (100 chars):
> no music,remove music,music remover,voice only,speech,youtube,safari extension,focus,lecture,podcast

**Description:** the shared long description, with this paragraph added after "How to use it":
> Turn on the extension first: open Settings › Apps › Safari › Extensions › Music Filter, turn it on, and allow it on youtube.com. On Mac: Safari › Settings › Extensions.

**App Review notes:**
> Music Filter is a Safari Web Extension. The app only explains how to turn the extension on.
> To test: enable Music Filter in Settings › Apps › Safari › Extensions and allow it for youtube.com. Open https://m.youtube.com in Safari, play any video with talking over background music, and tap "Music filter: OFF" at the top left. The video pauses for a moment while the first seconds are filtered, then plays with the music removed.
> The extension collects no data and makes no network requests of its own. It is open source: https://github.com/HighWatersDev/music-filter
