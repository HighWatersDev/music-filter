# Music Filter

A browser extension that removes background music from YouTube videos while they play and keeps the voices. Everything runs on your device. Nothing is uploaded, and no account is needed.

## Where it runs

| Browser | How it filters |
|---|---|
| Chrome, Edge, Brave, Firefox on desktop | Live, with about 0.1 s of delay |
| Safari on iPhone, iPad and Mac | Ahead of playback. The video pauses briefly while the first seconds are filtered. |
| Firefox for Android | Ahead of playback, same as Safari |

Chrome on phones does not support extensions.

## Using it

Open a YouTube video and press **Music filter: OFF** in the top-left corner to turn it on. Press it again to hear the original audio.

## What to expect

- Speech comes through clearly. Most music is removed, including music under speech. Some can remain at a low level.
- Sound effects and ambient sound are removed too. It keeps voices only.
- Singing is a voice, so sung vocals still come through.
- On Safari and Firefox for Android the filter works at normal speed only. At other speeds the video is muted.
- If filtering fails, the video is muted with a message. The original music never plays while the filter is on.

## How it works

YouTube streams audio to the page through Media Source Extensions. The extension copies that audio, decodes it, and runs [DPDFNet](https://huggingface.co/Ceva-IP/DPDFNet), a speech enhancement model, in WebAssembly.

- On desktop it filters live in an AudioWorklet.
- On Safari and Firefox for Android it filters in a Worker, a few seconds ahead of the playhead, and plays the result in sync with the video.

Design notes and test results are in [docs/](docs).

## Building from source

Requirements:
- Node 24
- For the WebAssembly engine: Rust (the version is pinned in `native/dpdf/rust-toolchain.toml`) and wasm-pack 0.15.0

```bash
npm ci
npm run fetch:models   # DPDFNet ONNX files from Hugging Face, checked by SHA-256
npm run build:dpdf     # Rust → extension/assets/dpdf_bg.wasm and vendor/dpdf/dpdf.js
npm run build          # bundles src/ into extension/dist
npm test
```

Load `extension/` as an unpacked extension for development. `npm run package` builds the store packages into `build/store/`.

## Privacy

Music Filter collects no data. See [PRIVACY.md](PRIVACY.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party components, including the DPDFNet models by Ceva.
