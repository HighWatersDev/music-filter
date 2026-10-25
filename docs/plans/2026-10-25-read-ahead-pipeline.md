# Read-Ahead Voice Filter Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove music from YouTube by keeping only voices, in Chrome, Safari (iPhone/iPad/Mac) and Firefox (desktop/Android). The extension filters audio that the player has already downloaded, ahead of the playhead, with DeepFilterNet3, and plays the result in sync with the video. The original track never plays while the filter is on. When filtered audio is not ready, the video pauses until it is.

**Architecture:**
- A MAIN-world script (`mse-tap.js`) copies the bytes YouTube appends to its audio `SourceBuffer` and streams them to the content script over a `MessagePort`.
- The content script forwards the active stream to a separator Worker inside a hidden extension iframe. The Worker demuxes WebM, decodes Opus, keeps a PCM timeline, plans windows ahead of the playhead, runs DeepFilterNet3 on each window (voice only, mono) and returns processed windows.
- The content script schedules those windows with Web Audio against `video.currentTime`, crossfading overlapping windows. The original audio stays at level 0 while the filter is on. If the video plays without filtered audio under the playhead, the content script pauses it and resumes it once enough filtered audio is ready.

**Tech Stack:** plain JavaScript ES modules, esbuild, `node:test`, `opus-decoder` 0.7.12 (libopus WASM, MIT), DeepFilterNet3 WASM (`vendor/df/df.js`, `extension/assets/df_bg.wasm` and `extension/assets/DeepFilterNet3_onnx.tar.gz`, git-ignored outputs of `npm run build:wasm`), Playwright 1.49.1 for the browser test, Xcode `safari-web-extension-converter`, `web-ext` 10.7.0.

**Read first:**
- `docs/plans/2026-10-19-music-filter-design.md`, Decisions table: v1 is voice only with DeepFilterNet3, and the video pauses instead of playing the original track.
- `docs/research/2026-10-25-keep-effects.md`: why read-ahead. Its MRX recommendation is superseded by the design doc.
- `docs/spikes/2026-10-25-mobile-results.md`: Safari returns silence to `createMediaElementSource` for YouTube, and the MSE tap and decode work on iPhone and Firefox for Android.
- `src/worklet/processor.js` and `bench/node-bench.mjs`: how the DeepFilterNet3 WASM is loaded and called (`initSync(module)`, `df_create(modelBytes, attenLimDb)`, `df_get_frame_length`, `df_process_frame(handle, Float32Array)`, mono, 48 kHz, 480-sample frames, 1440 samples of delay).
- `src/separator/worker.js` and `src/separator/frame.js`: the existing separator Worker and iframe this plan extends.

---

## Decisions this plan bakes in

| Decision | Value | Why |
|---|---|---|
| Codec support | Opus in WebM only. Anything else mutes everything and shows "Can't filter this video". | That is what YouTube served on Chrome, Safari iPhone and Firefox Android in the spikes. AAC/MP4 is a later task. |
| Opus decoding | `opus-decoder` WASM in the Worker, on every browser | Firefox for Android has no WebCodecs. One path everywhere keeps the code and tests the same. |
| Model | DeepFilterNet3, voice only, `attenLimDb` 100, bundled in `extension/assets` | About 20x faster than real time (a 10 s window takes about 0.5 s on an M2 Pro), nothing to download. MRX left music audible. See the design doc. |
| Voice filter | Mono downmix, warm-up on up to 2 s of audio before the window (or the window's first 0.25 s when none is decoded), output shifted back by DeepFilterNet3's 1440-sample delay | One DeepFilterNet3 state serves every window and seek. Running preceding audio through it first hides the jump from the previous window (see Task 12). The shift makes output line up with input sample for sample. |
| Windows | First window 2 s, then 10 s, 1 s overlap, minimum 1 s | A short first window means a held video resumes sooner. DeepFilterNet3 is fast enough that window size does not matter for speed. |
| Lookahead | Up to 30 s ahead of the playhead | YouTube buffered about 50 s ahead in the spikes. |
| Original audio control | Chrome and Firefox: `createMediaElementSource` into a GainNode. Safari: `video.muted`. Level 0 whenever the filter is on, back to 1 only when the user turns it off. | Safari's element tap is silent for YouTube, so the graph route would lose the original audio there. |
| Filtered audio not ready | Pause the video when it plays at 1x without filtered audio covering `[now, now + 0.3 s]`. Resume once `min(2 s, rest of video)` is ready. Only pauses the extension made are resumed. | Design decision: the original track is never played while the filter is on. Works like buffering. |
| Speed other than 1x | Processed and original audio both muted, panel says "Filter works at Normal speed" | Windows are scheduled for 1x playback. |
| Errors | Everything muted, panel says "Can't filter this video: …", a held video is resumed. A hold longer than 30 s becomes an error. | The video must not stay paused forever. |
| Ads | No special case | The extension follows whichever MediaSource the player is showing. |
| Spike scripts | `content.js` (DeepFilterNet panel) and `clip-test.js` are removed from the manifest. The files stay, and the clip test keeps its own MRX/TIGER code in the Worker. | Both call `createMediaElementSource`, which can only happen once per element. |

Constants live in `src/pipeline/stream-engine.js` (`DEFAULT_CONFIG`), `src/pipeline/hold-policy.js` (`HOLD_CONFIG`), `src/pipeline/voice-filter.js` and `src/content/playback-scheduler.js`.

## File map

| File | Status | Role |
|---|---|---|
| `src/pipeline/ebml.js` | new | EBML vint and value readers |
| `src/pipeline/webm-demuxer.js` | new | Streaming WebM demuxer, tolerant of arbitrary chunk boundaries, re-init and abort |
| `src/pipeline/opus-head.js` | new | Parse the OpusHead codec private data |
| `src/pipeline/frame-decoder.js` | new | Opus frames to timestamped PCM, with continuity and pre-roll handling |
| `src/pipeline/ranges.js` | new | Merged half-open interval helpers |
| `src/pipeline/pcm-timeline.js` | new | Paged PCM store keyed by sample position |
| `src/pipeline/window-planner.js` | new | Chooses the next window to filter |
| `src/pipeline/stream-engine.js` | new | Ties demux, decode, timeline, planner and the window filter together (Worker side) |
| `src/pipeline/voice-filter.js` | new | Runs DeepFilterNet3 over a window: mono, warm-up, delay compensation |
| `src/pipeline/playback-math.js` | new | Pure scheduling math for the content script |
| `src/pipeline/hold-policy.js` | new | Pure pause, resume and panel-state decisions for the content script |
| `src/separator/worker.js` | modify | Adds `stream-*` and `playhead` messages, with DeepFilterNet3 as the window filter |
| `src/separator/frame.js` | modify | Transfers `bytes` buffers too |
| `extension/mse-tap.js` | rewrite | MessagePort tap with buffering until the content script connects |
| `src/content/separator-client.js` | new | Hidden iframe + MessageChannel connection |
| `src/content/original-audio.js` | new | Original audio control, graph and mute modes |
| `src/content/playback-scheduler.js` | new | Web Audio scheduling, crossfades, drift, coverage |
| `src/content/panel.js` | new | On/off button and status line |
| `src/content/read-ahead.js` | new | Content script orchestrator, including the hold controller |
| `scripts/build-separator.mjs` | modify | Also bundles `dist/read-ahead.js` |
| `scripts/make-fixtures.sh` | new | Generates WebM Opus fixtures with ffmpeg |
| `extension/manifest.json` | modify | New content scripts, spike scripts removed |
| `test-page/mse.html` | new | Local page that plays a WebM file through MediaSource in random chunks |
| `test/e2e/read-ahead.e2e.mjs` | new | Headless Chrome test with the extension |
| `tools/listen/engine-check.mjs` | new | Runs the engine with real DeepFilterNet3 in Node, writes a WAV |

Prefix every node/npm command with `export PATH="/opt/homebrew/opt/node@24/bin:$PATH" &&`. Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 0: Dependency and fixtures

**Files:**
- Modify: `package.json`
- Create: `scripts/make-fixtures.sh`
- Create: `test/fixtures/tone-12s.webm`, `test/fixtures/tone-live-6s.webm` (generated, committed)

**Step 1: Install opus-decoder**

```bash
npm install --save-exact opus-decoder@0.7.12
```

Expected: `package.json` dependencies gain `"opus-decoder": "0.7.12"`.

**Step 2: Write `scripts/make-fixtures.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/test/fixtures" "$ROOT/test-page/fixtures"

opus() {
  local seconds="$1" out="$2"
  shift 2
  ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=${seconds}:sample_rate=48000" \
    -ac 2 -c:a libopus -b:a 96k -f webm "$@" "$out"
}

opus 12 "$ROOT/test/fixtures/tone-12s.webm"
opus 6 "$ROOT/test/fixtures/tone-live-6s.webm" -live 1
opus 60 "$ROOT/test-page/fixtures/tone-60s.webm"
ls -la "$ROOT/test/fixtures" "$ROOT/test-page/fixtures"
```

`-live 1` writes unknown-size Segment and Cluster elements, the layout live streams use.

**Step 3: Generate and ignore the large one**

```bash
bash scripts/make-fixtures.sh
printf 'test-page/fixtures/\n' >> .gitignore
```

Expected: `tone-12s.webm` about 176 KB, `tone-live-6s.webm` about 89 KB, `tone-60s.webm` about 0.9 MB.

**Step 4: Commit**

```bash
git add package.json package-lock.json scripts/make-fixtures.sh test/fixtures .gitignore
git commit -m "chore: opus-decoder and WebM Opus fixtures"
```

---

### Task 1: EBML readers

**Files:**
- Create: `src/pipeline/ebml.js`
- Test: `test/ebml.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFloat, readString, readUint, readVint } from '../src/pipeline/ebml.js';

test('readVint decodes sizes and keeps the marker for ids', () => {
  assert.deepEqual(readVint(Uint8Array.of(0x81), 0), { value: 1, length: 1, isUnknown: false });
  assert.deepEqual(readVint(Uint8Array.of(0x40, 0x02), 0), { value: 2, length: 2, isUnknown: false });
  assert.deepEqual(readVint(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), 0, { keepMarker: true }), {
    value: 0x1a45dfa3,
    length: 4,
    isUnknown: false,
  });
});

test('readVint flags unknown sizes, incomplete input and invalid bytes', () => {
  assert.equal(readVint(Uint8Array.of(0xff), 0).isUnknown, true);
  assert.equal(readVint(Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0).isUnknown, true);
  assert.equal(readVint(Uint8Array.of(0x40), 0), null);
  assert.equal(readVint(Uint8Array.of(), 0), null);
  assert.ok(readVint(Uint8Array.of(0x00), 0).error);
});

test('value readers', () => {
  assert.equal(readUint(Uint8Array.of(0x0f, 0x42, 0x40)), 1_000_000);
  assert.equal(readString(Uint8Array.of(0x41, 0x5f, 0x4f, 0x50, 0x55, 0x53, 0x00)), 'A_OPUS');
  assert.equal(readFloat(Uint8Array.of(0x47, 0x3b, 0x80, 0x00)), 48000);
});
```

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/ebml.js'`

**Step 3: Implement `src/pipeline/ebml.js`**

```js
export const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CODEC_DELAY: 0x56aa,
  SEEK_PRE_ROLL: 0x56bb,
  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  CHANNELS: 0x9f,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
};

export const MAX_ID_LENGTH = 4;

export function readVint(bytes, offset, { keepMarker = false } = {}) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return { error: 'vint has no length marker' };
  const length = Math.clz32(first) - 23;
  if (offset + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let isAllOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i];
    value = value * 256 + byte;
    if (byte !== 0xff) isAllOnes = false;
  }
  return { value, length, isUnknown: !keepMarker && isAllOnes };
}

export function readUint(bytes) {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

export function readFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength === 4) return view.getFloat32(0);
  if (bytes.byteLength === 8) return view.getFloat64(0);
  return 0;
}

export function readString(bytes) {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}
```

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 28 tests (25 existing + 3)

**Step 5: Commit**

```bash
git add src/pipeline/ebml.js test/ebml.test.js
git commit -m "feat(pipeline): EBML readers"
```

---

### Task 2: Streaming WebM demuxer

**Files:**
- Create: `src/pipeline/webm-demuxer.js`
- Test: `test/webm-demuxer.test.js`

This code was prototyped against both fixtures on 2026-10-25. It produced identical frames for one-shot and randomly chunked input, and the decoded audio measured 440 Hz.

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebmDemuxer } from '../src/pipeline/webm-demuxer.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function demux(chunks) {
  const result = { inits: [], frames: [], warnings: [] };
  const demuxer = new WebmDemuxer({
    onInit: (init) => result.inits.push(init),
    onFrame: (frame) => result.frames.push(frame),
    onWarning: (warning) => result.warnings.push(warning),
  });
  for (const chunk of chunks) demuxer.push(chunk);
  return { ...result, demuxer };
}

function randomChunks(bytes, seed) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; ) {
    const size = 1 + Math.floor(random() * 5000);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

const clusterOffsets = (bytes) => {
  const offsets = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) offsets.push(i);
  }
  return offsets;
};

test('reads the Opus track and every frame', () => {
  const { inits, frames, warnings } = demux([fixture('tone-12s.webm')]);
  assert.equal(inits.length, 1);
  assert.equal(inits[0].codecId, 'A_OPUS');
  assert.equal(inits[0].channels, 2);
  assert.equal(inits[0].sampleRate, 48000);
  assert.equal(inits[0].codecPrivate.length, 19);
  assert.equal(frames.length, 601);
  assert.equal(frames[0].timeSeconds, 0);
  assert.ok(Math.abs(frames[1].timeSeconds - 0.02) < 0.002);
  assert.deepEqual(warnings, []);
});

test('random chunk boundaries give the same frames', () => {
  const bytes = fixture('tone-12s.webm');
  const whole = demux([bytes]).frames;
  for (const seed of [1, 7, 99]) {
    const chunked = demux(randomChunks(bytes, seed)).frames;
    assert.equal(chunked.length, whole.length);
    chunked.forEach((frame, i) => {
      assert.equal(frame.timeSeconds, whole[i].timeSeconds);
      assert.deepEqual(frame.data, whole[i].data);
    });
  }
});

test('handles live-style unknown-size elements', () => {
  const { inits, frames, warnings } = demux(randomChunks(fixture('tone-live-6s.webm'), 3));
  assert.equal(inits.length, 1);
  assert.equal(frames.length, 301);
  assert.deepEqual(warnings, []);
});

test('a second init segment starts a new stream', () => {
  const bytes = fixture('tone-12s.webm');
  const { inits, frames } = demux([bytes, bytes]);
  assert.equal(inits.length, 2);
  assert.equal(frames.length, 1202);
});

test('after abort, parsing resumes at the next cluster', () => {
  const bytes = fixture('tone-12s.webm');
  const [, second, third] = clusterOffsets(bytes);
  const { frames, demuxer } = demux([bytes.subarray(0, second + 500)]);
  const before = frames.length;
  demuxer.abort();
  demuxer.push(bytes.subarray(third));
  const resumed = frames.slice(before);
  const reference = demux([bytes]).frames.filter((f) => f.timeSeconds >= resumed[0].timeSeconds);
  assert.ok(resumed.length > 50);
  assert.equal(resumed.length, reference.length);
  assert.equal(resumed[0].timeSeconds, reference[0].timeSeconds);
});

test('garbage before a cluster is skipped with a warning', () => {
  const bytes = fixture('tone-12s.webm');
  const [, second] = clusterOffsets(bytes);
  const { frames, demuxer, warnings } = demux([bytes.subarray(0, second)]);
  const before = frames.length;
  demuxer.abort();
  demuxer.push(Uint8Array.of(0x00, 0x00, 0x13, 0x37));
  demuxer.push(bytes.subarray(second));
  assert.ok(frames.length > before);
  assert.ok(warnings.some((w) => w.startsWith('resync')));
});
```

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/webm-demuxer.js'`

**Step 3: Implement `src/pipeline/webm-demuxer.js`**

```js
import { ID, MAX_ID_LENGTH, readFloat, readString, readUint, readVint } from './ebml.js';

const MASTERS = new Set([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.CLUSTER, ID.BLOCK_GROUP]);
const LEAVES = new Set([
  ID.TIMECODE_SCALE,
  ID.TRACK_NUMBER,
  ID.TRACK_TYPE,
  ID.CODEC_ID,
  ID.CODEC_PRIVATE,
  ID.CODEC_DELAY,
  ID.SEEK_PRE_ROLL,
  ID.SAMPLING_FREQUENCY,
  ID.CHANNELS,
  ID.TIMECODE,
  ID.SIMPLE_BLOCK,
  ID.BLOCK,
]);
const RESYNC_IDS = [ID.CLUSTER, ID.EBML];
const MAX_LEAF_BYTES = 16 * 1024 * 1024;
const MAX_SKIP_BYTES = 256 * 1024 * 1024;
const AUDIO_TRACK_TYPE = 2;
const LACING_BITS = 0x06;

export class WebmDemuxer {
  constructor({ onInit, onFrame, onWarning = () => {} }) {
    this.onInit = onInit;
    this.onFrame = onFrame;
    this.onWarning = onWarning;
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.skipRemaining = 0;
    this.resetStream();
  }

  resetStream() {
    this.timecodeScale = 1_000_000;
    this.tracks = [];
    this.currentTrack = null;
    this.audioTrack = null;
    this.hasEmittedInit = false;
    this.clusterTimecode = null;
  }

  push(chunk) {
    const pending = this.buffer.length - this.offset;
    const next = new Uint8Array(pending + chunk.byteLength);
    next.set(this.buffer.subarray(this.offset), 0);
    next.set(chunk, pending);
    this.buffer = next;
    this.offset = 0;
    this.parse();
  }

  abort() {
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.skipRemaining = 0;
    this.clusterTimecode = null;
  }

  parse() {
    const { buffer } = this;
    while (true) {
      if (this.skipRemaining > 0) {
        const skipped = Math.min(this.skipRemaining, buffer.length - this.offset);
        this.offset += skipped;
        this.skipRemaining -= skipped;
        if (this.skipRemaining > 0) return;
      }

      const id = readVint(buffer, this.offset, { keepMarker: true });
      if (!id) return;
      if (id.error || id.length > MAX_ID_LENGTH) {
        if (!this.resync('invalid element id')) return;
        continue;
      }
      const size = readVint(buffer, this.offset + id.length);
      if (!size) return;
      if (size.error) {
        if (!this.resync('invalid element size')) return;
        continue;
      }
      const payloadStart = this.offset + id.length + size.length;

      if (id.value === ID.EBML) {
        this.resetStream();
        this.offset = payloadStart;
        this.skipRemaining = size.isUnknown ? 0 : size.value;
        continue;
      }
      if (MASTERS.has(id.value)) {
        this.offset = payloadStart;
        this.enterMaster(id.value);
        continue;
      }
      if (size.isUnknown || size.value > MAX_SKIP_BYTES) {
        if (!this.resync(`element 0x${id.value.toString(16)} has an unusable size`)) return;
        continue;
      }
      if (LEAVES.has(id.value)) {
        if (size.value > MAX_LEAF_BYTES) {
          if (!this.resync(`element 0x${id.value.toString(16)} is too large`)) return;
          continue;
        }
        const payloadEnd = payloadStart + size.value;
        if (payloadEnd > buffer.length) return;
        this.readLeaf(id.value, buffer.subarray(payloadStart, payloadEnd));
        this.offset = payloadEnd;
        continue;
      }
      this.offset = payloadStart;
      this.skipRemaining = size.value;
    }
  }

  resync(reason) {
    this.onWarning(`resync: ${reason}`);
    const { buffer } = this;
    for (let i = this.offset + 1; i + MAX_ID_LENGTH <= buffer.length; i++) {
      if (RESYNC_IDS.includes(readUint(buffer.subarray(i, i + MAX_ID_LENGTH)))) {
        this.offset = i;
        return true;
      }
    }
    this.offset = Math.max(this.offset, buffer.length - (MAX_ID_LENGTH - 1));
    return false;
  }

  enterMaster(id) {
    if (id === ID.TRACK_ENTRY) {
      this.currentTrack = {};
      this.tracks.push(this.currentTrack);
    }
    if (id === ID.CLUSTER) {
      this.finishInit();
      this.clusterTimecode = null;
    }
  }

  readLeaf(id, payload) {
    const track = this.currentTrack;
    switch (id) {
      case ID.TIMECODE_SCALE:
        this.timecodeScale = readUint(payload);
        break;
      case ID.TRACK_NUMBER:
        if (track) track.number = readUint(payload);
        break;
      case ID.TRACK_TYPE:
        if (track) track.type = readUint(payload);
        break;
      case ID.CODEC_ID:
        if (track) track.codecId = readString(payload);
        break;
      case ID.CODEC_PRIVATE:
        if (track) track.codecPrivate = payload.slice();
        break;
      case ID.CODEC_DELAY:
        if (track) track.codecDelayNs = readUint(payload);
        break;
      case ID.SEEK_PRE_ROLL:
        if (track) track.seekPreRollNs = readUint(payload);
        break;
      case ID.SAMPLING_FREQUENCY:
        if (track) track.sampleRate = readFloat(payload);
        break;
      case ID.CHANNELS:
        if (track) track.channels = readUint(payload);
        break;
      case ID.TIMECODE:
        this.clusterTimecode = readUint(payload);
        break;
      case ID.SIMPLE_BLOCK:
      case ID.BLOCK:
        this.readBlock(payload);
        break;
    }
  }

  finishInit() {
    if (this.hasEmittedInit) return;
    this.hasEmittedInit = true;
    this.audioTrack =
      this.tracks.find((t) => t.codecId === 'A_OPUS') ?? this.tracks.find((t) => t.type === AUDIO_TRACK_TYPE) ?? null;
    if (!this.audioTrack) {
      this.onWarning('no audio track in init segment');
      return;
    }
    const {
      number,
      codecId,
      codecPrivate = null,
      channels = 2,
      sampleRate = 48000,
      codecDelayNs = 0,
      seekPreRollNs = 0,
    } = this.audioTrack;
    this.onInit({
      trackNumber: number,
      codecId,
      codecPrivate,
      channels,
      sampleRate,
      codecDelayNs,
      seekPreRollNs,
      timecodeScale: this.timecodeScale,
    });
  }

  readBlock(payload) {
    if (!this.audioTrack) return;
    const trackNumber = readVint(payload, 0);
    if (!trackNumber || trackNumber.error || trackNumber.value !== this.audioTrack.number) return;
    if (this.clusterTimecode === null) {
      this.onWarning('block before cluster timecode skipped');
      return;
    }
    const headerEnd = trackNumber.length + 3;
    if (payload.length < headerEnd) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const relativeTimecode = view.getInt16(trackNumber.length);
    const flags = payload[trackNumber.length + 2];
    if (flags & LACING_BITS) {
      this.onWarning('laced block skipped');
      return;
    }
    const timeSeconds = ((this.clusterTimecode + relativeTimecode) * this.timecodeScale) / 1e9;
    this.onFrame({ timeSeconds, data: payload.slice(headerEnd) });
  }
}
```

Behaviour to know:
- Master elements are entered by header only. The parser is flat and uses element IDs, not nesting, to decide meaning. That is why unknown-size Segment and Cluster work.
- Elements it does not need (SeekHead, Cues, Tags, Void) are skipped by size, even across `push` calls.
- `abort()` mirrors `SourceBuffer.abort()`. The next bytes are expected to start at an element boundary, and resync finds the next Cluster if they do not.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 34 tests

**Step 5: Commit**

```bash
git add src/pipeline/webm-demuxer.js test/webm-demuxer.test.js
git commit -m "feat(pipeline): streaming WebM demuxer"
```

---

### Task 3: OpusHead parser and frame decoder

**Files:**
- Create: `src/pipeline/opus-head.js`, `src/pipeline/frame-decoder.js`
- Test: `test/frame-decoder.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebmDemuxer } from '../src/pipeline/webm-demuxer.js';
import { parseOpusHead } from '../src/pipeline/opus-head.js';
import { FrameDecoder } from '../src/pipeline/frame-decoder.js';

function demuxFixture() {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tone-12s.webm', import.meta.url)));
  let init;
  const frames = [];
  new WebmDemuxer({ onInit: (i) => (init = i), onFrame: (f) => frames.push(f) }).push(bytes);
  return { init, frames };
}

test('parseOpusHead reads stereo mapping family 0', () => {
  const { init } = demuxFixture();
  const head = parseOpusHead(init.codecPrivate);
  assert.equal(head.channels, 2);
  assert.equal(head.preSkip, 312);
  assert.equal(head.inputSampleRate, 48000);
  assert.equal(head.mappingFamily, 0);
  assert.deepEqual(head.channelMappingTable, [0, 1]);
});

test('parseOpusHead rejects other data', () => {
  assert.throws(() => parseOpusHead(new Uint8Array(19)), /OpusHead/);
});

test('decodes a contiguous run into one gapless span', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  const spans = frames.map((f) => decoder.decode(f)).filter(Boolean);
  for (let i = 1; i < spans.length; i++) {
    assert.equal(spans[i].startSample, spans[i - 1].startSample + spans[i - 1].channelData[0].length);
  }
  assert.equal(spans[0].startSample, 312);
  const left = spans.flatMap((s) => Array.from(s.channelData[0]));
  let crossings = 0;
  for (let i = 1; i < left.length; i++) if (left[i - 1] < 0 && left[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings / (left.length / 48000) - 440) < 2);
  decoder.free();
});

test('a time jump restarts with pre-roll discarded', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  for (const frame of frames.slice(0, 200)) decoder.decode(frame);
  const jumped = frames.slice(400).map((f) => decoder.decode(f)).filter(Boolean);
  const expectedStart = Math.round(frames[400].timeSeconds * 48000) + 3840;
  assert.equal(jumped[0].startSample, expectedStart);
  decoder.free();
});

test('free while configuring is safe', async () => {
  const { init } = demuxFixture();
  const decoder = new FrameDecoder();
  const configuring = decoder.configure(init);
  decoder.free();
  await configuring;
  assert.equal(decoder.isReady, false);
  assert.equal(decoder.decoder, null);
});
```

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/opus-head.js'`

**Step 3: Implement `src/pipeline/opus-head.js`**

```js
const MAGIC = 'OpusHead';
const MIN_LENGTH = 19;

export function parseOpusHead(bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC || bytes.length < MIN_LENGTH) throw new Error('codec private data is not an OpusHead');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = bytes[9];
  const preSkip = view.getUint16(10, true);
  const inputSampleRate = view.getUint32(12, true);
  const mappingFamily = bytes[18];
  if (mappingFamily === 0) {
    return {
      channels,
      preSkip,
      inputSampleRate,
      mappingFamily,
      streamCount: 1,
      coupledStreamCount: channels === 2 ? 1 : 0,
      channelMappingTable: channels === 2 ? [0, 1] : [0],
    };
  }
  return {
    channels,
    preSkip,
    inputSampleRate,
    mappingFamily,
    streamCount: bytes[19],
    coupledStreamCount: bytes[20],
    channelMappingTable: Array.from(bytes.subarray(21, 21 + channels)),
  };
}
```

**Step 4: Implement `src/pipeline/frame-decoder.js`**

```js
import { OpusDecoder } from 'opus-decoder';
import { parseOpusHead } from './opus-head.js';

const CONTINUITY_TOLERANCE_SECONDS = 0.005;
const DEFAULT_PRE_ROLL_SECONDS = 0.08;

export class FrameDecoder {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.decoder = null;
    this.isReady = false;
  }

  async configure(init) {
    this.free();
    const head = init.codecPrivate
      ? parseOpusHead(init.codecPrivate)
      : { channels: init.channels, preSkip: Math.round((init.codecDelayNs / 1e9) * this.sampleRate) };
    const decoder = new OpusDecoder({
      sampleRate: this.sampleRate,
      channels: head.channels,
      streamCount: head.streamCount,
      coupledStreamCount: head.coupledStreamCount,
      channelMappingTable: head.channelMappingTable,
      forceStereo: true,
      preSkip: 0,
    });
    this.decoder = decoder;
    await decoder.ready;
    if (this.decoder !== decoder) {
      decoder.free();
      return;
    }
    this.preRollSamples = Math.round(((init.seekPreRollNs || DEFAULT_PRE_ROLL_SECONDS * 1e9) / 1e9) * this.sampleRate);
    this.toleranceSamples = Math.round(CONTINUITY_TOLERANCE_SECONDS * this.sampleRate);
    this.expectedNext = null;
    this.discard = head.preSkip;
    this.isReady = true;
  }

  decode({ timeSeconds, data }) {
    const frameStart = Math.round(timeSeconds * this.sampleRate);
    let start = frameStart;
    if (this.expectedNext !== null) {
      if (Math.abs(frameStart - this.expectedNext) <= this.toleranceSamples) start = this.expectedNext;
      else this.discard = this.preRollSamples;
    }
    const { channelData, samplesDecoded } = this.decoder.decodeFrame(data);
    if (!samplesDecoded) return null;
    this.expectedNext = start + samplesDecoded;
    const skip = Math.min(this.discard, samplesDecoded);
    this.discard -= skip;
    if (skip === samplesDecoded) return null;
    return { startSample: start + skip, channelData: channelData.map((channel) => channel.slice(skip, samplesDecoded)) };
  }

  free() {
    if (this.isReady) this.decoder.free();
    this.decoder = null;
    this.isReady = false;
  }
}
```

Why it works this way:
- `OpusDecoder.free()` throws until its WASM has loaded. `free()` during `configure()` only drops the reference, and `configure()` frees the orphaned decoder once it is ready. The stream engine hits this when a reset arrives while the decoder is still loading.
- WebM timestamps are whole milliseconds, so consecutive 20 ms frames can land up to 1 sample off. Frames within 5 ms of where the previous frame ended are placed back to back, keeping the PCM gapless.
- A bigger jump (seek, dropped chunks) keeps the decoder state and throws away the next pre-roll (80 ms), which is what libopus needs to converge. No `reset()` call is needed.
- The first output after configure drops the OpusHead pre-skip (312 samples). This leaves a 6.5 ms offset between PCM and video, below anything audible or visible.

**Step 5: Run tests**

Run: `npm test`
Expected: PASS, 39 tests

**Step 6: Commit**

```bash
git add src/pipeline/opus-head.js src/pipeline/frame-decoder.js test/frame-decoder.test.js
git commit -m "feat(pipeline): OpusHead parser and gapless frame decoder"
```

---

### Task 4: Ranges and PCM timeline

**Files:**
- Create: `src/pipeline/ranges.js`, `src/pipeline/pcm-timeline.js`
- Test: `test/ranges.test.js`, `test/pcm-timeline.test.js`

**Step 1: Write the failing tests**

`test/ranges.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRange, contiguousEnd, covers, nextRangeStart, trimBefore } from '../src/pipeline/ranges.js';

test('addRange merges overlapping and touching ranges', () => {
  let ranges = [];
  ranges = addRange(ranges, 10, 20);
  ranges = addRange(ranges, 30, 40);
  ranges = addRange(ranges, 20, 25);
  assert.deepEqual(ranges, [[10, 25], [30, 40]]);
  ranges = addRange(ranges, 24, 31);
  assert.deepEqual(ranges, [[10, 40]]);
  assert.deepEqual(addRange(ranges, 5, 5), [[10, 40]]);
});

test('contiguousEnd, covers and nextRangeStart', () => {
  const ranges = [[10, 25], [30, 40]];
  assert.equal(contiguousEnd(ranges, 12), 25);
  assert.equal(contiguousEnd(ranges, 26), 26);
  assert.equal(covers(ranges, 10, 25), true);
  assert.equal(covers(ranges, 20, 31), false);
  assert.equal(nextRangeStart(ranges, 26), 30);
  assert.equal(nextRangeStart(ranges, 12), 12);
  assert.equal(nextRangeStart(ranges, 41), null);
});

test('trimBefore drops and clips', () => {
  assert.deepEqual(trimBefore([[10, 25], [30, 40]], 32), [[32, 40]]);
});
```

`test/pcm-timeline.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmTimeline } from '../src/pipeline/pcm-timeline.js';

const ramp = (start, length) => Float32Array.from({ length }, (_, i) => start + i);

test('writes across pages and reads back exactly', () => {
  const timeline = new PcmTimeline({ pageSamples: 100 });
  timeline.write(150, [ramp(150, 250), ramp(10150, 250)]);
  assert.deepEqual(timeline.ranges, [[150, 400]]);
  const [left, right] = timeline.read(190, 120);
  assert.deepEqual(Array.from(left), Array.from(ramp(190, 120)));
  assert.deepEqual(Array.from(right), Array.from(ramp(10190, 120)));
});

test('read returns null across a gap and mono input fills both channels', () => {
  const timeline = new PcmTimeline({ pageSamples: 100 });
  timeline.write(0, [ramp(0, 50)]);
  timeline.write(60, [ramp(60, 40)]);
  assert.equal(timeline.read(40, 30), null);
  assert.deepEqual(Array.from(timeline.read(0, 10)[1]), Array.from(ramp(0, 10)));
});

test('evictBefore frees whole pages and trims ranges', () => {
  const timeline = new PcmTimeline({ pageSamples: 100 });
  timeline.write(0, [ramp(0, 350), ramp(0, 350)]);
  timeline.evictBefore(250);
  assert.deepEqual(timeline.ranges, [[200, 350]]);
  assert.equal(timeline.read(150, 10), null);
  assert.equal(timeline.pages.size, 2);
});
```

**Step 2: Run them and see them fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/ranges.js'`

**Step 3: Implement `src/pipeline/ranges.js`**

```js
export function addRange(ranges, start, end) {
  if (end <= start) return ranges;
  const result = [];
  let merged = [start, end];
  for (const [s, e] of ranges) {
    if (e < merged[0] || s > merged[1]) result.push([s, e]);
    else merged = [Math.min(s, merged[0]), Math.max(e, merged[1])];
  }
  result.push(merged);
  return result.sort((a, b) => a[0] - b[0]);
}

export function contiguousEnd(ranges, point) {
  for (const [s, e] of ranges) if (s <= point && point < e) return e;
  return point;
}

export function covers(ranges, start, end) {
  return end > start && contiguousEnd(ranges, start) >= end;
}

export function nextRangeStart(ranges, point) {
  for (const [s, e] of ranges) {
    if (s <= point && point < e) return point;
    if (s > point) return s;
  }
  return null;
}

export function trimBefore(ranges, point) {
  return ranges.filter(([, e]) => e > point).map(([s, e]) => [Math.max(s, point), e]);
}
```

**Step 4: Implement `src/pipeline/pcm-timeline.js`**

```js
import { addRange, covers, trimBefore } from './ranges.js';

export class PcmTimeline {
  constructor({ channels = 2, pageSamples = 48000 } = {}) {
    this.channels = channels;
    this.pageSamples = pageSamples;
    this.pages = new Map();
    this.ranges = [];
  }

  write(start, channelData) {
    const length = channelData[0].length;
    this.forEachSpan(start, length, (page, pageOffset, written, count) => {
      for (let c = 0; c < this.channels; c++) {
        page[c].set((channelData[c] ?? channelData[0]).subarray(written, written + count), pageOffset);
      }
    }, true);
    this.ranges = addRange(this.ranges, start, start + length);
  }

  read(start, length) {
    if (!covers(this.ranges, start, start + length)) return null;
    const out = Array.from({ length: this.channels }, () => new Float32Array(length));
    this.forEachSpan(start, length, (page, pageOffset, written, count) => {
      for (let c = 0; c < this.channels; c++) out[c].set(page[c].subarray(pageOffset, pageOffset + count), written);
    }, false);
    return out;
  }

  evictBefore(point) {
    const firstKept = Math.floor(point / this.pageSamples);
    for (const index of [...this.pages.keys()]) if (index < firstKept) this.pages.delete(index);
    this.ranges = trimBefore(this.ranges, firstKept * this.pageSamples);
  }

  forEachSpan(start, length, visit, create) {
    for (let done = 0; done < length; ) {
      const position = start + done;
      const index = Math.floor(position / this.pageSamples);
      const pageOffset = position - index * this.pageSamples;
      const count = Math.min(this.pageSamples - pageOffset, length - done);
      let page = this.pages.get(index);
      if (!page && create) {
        page = Array.from({ length: this.channels }, () => new Float32Array(this.pageSamples));
        this.pages.set(index, page);
      }
      visit(page, pageOffset, done, count);
      done += count;
    }
  }
}
```

**Step 5: Run tests**

Run: `npm test`
Expected: PASS, 45 tests

**Step 6: Commit**

```bash
git add src/pipeline/ranges.js src/pipeline/pcm-timeline.js test/ranges.test.js test/pcm-timeline.test.js
git commit -m "feat(pipeline): interval helpers and paged PCM timeline"
```

---

### Task 5: Window planner

**Files:**
- Create: `src/pipeline/window-planner.js`
- Test: `test/window-planner.test.js`

Units are samples. `S = 48000`.

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { planNextWindow } from '../src/pipeline/window-planner.js';

const S = 48000;
const base = {
  firstWindow: 4 * S,
  window: 10 * S,
  overlap: 1 * S,
  minWindow: 2 * S,
  lookahead: 30 * S,
  urgency: 5 * S,
  maxStartGap: S / 2,
};

test('first window starts at the playhead and is short', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[0, 60 * S]], processed: [] });
  assert.deepEqual(plan, { start: 0, end: 4 * S });
});

test('a small gap before decoded audio is skipped', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[312, 60 * S]], processed: [] });
  assert.deepEqual(plan, { start: 312, end: 312 + 4 * S });
});

test('next window overlaps the processed end and is full length', () => {
  const plan = planNextWindow({ ...base, playhead: 1 * S, decoded: [[0, 60 * S]], processed: [[0, 4 * S]] });
  assert.deepEqual(plan, { start: 3 * S, end: 13 * S });
});

test('a small gap before processed audio still counts as processed', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[312, 60 * S]], processed: [[312, 312 + 4 * S]] });
  assert.deepEqual(plan, { start: 312 + 3 * S, end: 312 + 13 * S });
});

test('stops when enough is processed ahead', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[0, 60 * S]], processed: [[0, 31 * S]] });
  assert.equal(plan, null);
});

test('waits for more decoded audio unless the window is urgent', () => {
  const notUrgent = planNextWindow({ ...base, playhead: 0, decoded: [[0, 15 * S]], processed: [[0, 10 * S]] });
  assert.equal(notUrgent, null);
  const urgent = planNextWindow({ ...base, playhead: 7 * S, decoded: [[0, 15 * S]], processed: [[0, 10 * S]] });
  assert.deepEqual(urgent, { start: 9 * S, end: 15 * S });
});

test('never plans a window shorter than the minimum', () => {
  const tooShort = planNextWindow({ ...base, playhead: 9 * S, decoded: [[0, 10.5 * S]], processed: [[0, 10 * S]] });
  assert.equal(tooShort, null);
  const exactlyMinimum = planNextWindow({ ...base, playhead: 9 * S, decoded: [[0, 11 * S]], processed: [[0, 10 * S]] });
  assert.deepEqual(exactlyMinimum, { start: 9 * S, end: 11 * S });
});

test('after a seek, plans from the new playhead', () => {
  const plan = planNextWindow({ ...base, playhead: 40 * S, decoded: [[0, 60 * S]], processed: [[0, 14 * S]] });
  assert.deepEqual(plan, { start: 40 * S, end: 44 * S });
});

test('nothing decoded at the playhead means no plan', () => {
  assert.equal(planNextWindow({ ...base, playhead: 40 * S, decoded: [[0, 20 * S]], processed: [] }), null);
});

test('the end of the decoded audio is not planned again when the overlap equals the minimum', () => {
  const plan = planNextWindow({ ...base, minWindow: 1 * S, playhead: 55 * S, decoded: [[0, 60 * S]], processed: [[0, 60 * S]] });
  assert.equal(plan, null);
});
```

The tests pass their own window sizes, so they stay valid when `DEFAULT_CONFIG` changes.

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/window-planner.js'`

**Step 3: Implement `src/pipeline/window-planner.js`**

```js
import { contiguousEnd, nextRangeStart } from './ranges.js';

export function planNextWindow({
  playhead,
  decoded,
  processed,
  firstWindow,
  window,
  overlap,
  minWindow,
  lookahead,
  urgency,
  maxStartGap,
}) {
  const processedStart = nextRangeStart(processed, playhead);
  const processedEnd =
    processedStart !== null && processedStart - playhead <= maxStartGap ? contiguousEnd(processed, processedStart) : playhead;
  if (processedEnd - playhead >= lookahead) return null;

  const continuing = processedEnd > playhead;
  let start = continuing ? processedEnd - overlap : playhead;
  const decodedStart = nextRangeStart(decoded, start);
  if (decodedStart === null || decodedStart - start > maxStartGap) return null;
  start = decodedStart;

  const target = start + (continuing ? window : firstWindow);
  const decodedEnd = contiguousEnd(decoded, start);
  if (decodedEnd >= target) return { start, end: target };
  if (decodedEnd <= processedEnd) return null;

  const isUrgent = (continuing ? processedEnd : start) - playhead <= urgency;
  if (!isUrgent || decodedEnd - start < minWindow) return null;
  return { start, end: decodedEnd };
}
```

The processed run is looked up with the same `maxStartGap` tolerance as the decoded run. Decoded audio starts at the 312-sample pre-skip, so the first processed window starts there too. With a plain `contiguousEnd(processed, 0)` the planner would see nothing processed and plan the first window again, forever.

`decodedEnd <= processedEnd` stops a window that adds no new audio. The engine uses a 1 s minimum with a 1 s overlap, so once processed audio reaches the end of decoded audio, the overlap alone would pass the minimum check. Without the guard the planner returns the last second again and again and the engine never goes idle.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 55 tests

**Step 5: Commit**

```bash
git add src/pipeline/window-planner.js test/window-planner.test.js
git commit -m "feat(pipeline): window planner"
```

---

### Task 6: Stream engine

**Files:**
- Create: `src/pipeline/stream-engine.js`
- Test: `test/stream-engine.test.js`

The engine runs in the Worker. The window filter `separate(left, right, sampleRate)` is injected and returns a promise of `[left, right]`, so tests use a fake. Task 7 passes DeepFilterNet3.

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StreamEngine } from '../src/pipeline/stream-engine.js';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tone-12s.webm', import.meta.url)));
const halve = async (left, right) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
};

function startEngine(options = {}) {
  const windows = [];
  const statuses = [];
  const engine = new StreamEngine({
    separate: options.separate ?? halve,
    onWindow: (w) => windows.push(w),
    onStatus: (s) => statuses.push(s),
  });
  return { engine, windows, statuses };
}

async function settle(engine) {
  await engine.ready;
  for (let i = 0; i < 200 && (engine.inFlight || !engine.isIdle()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('emits a short first window then overlapping windows', async () => {
  const { engine, windows } = startEngine();
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.equal(windows.length, 2);
  assert.ok(Math.abs(windows[0].startSeconds - 0.0065) < 0.001);
  assert.ok(Math.abs(windows[0].left.length / 48000 - 2) < 0.001);
  assert.ok(Math.abs(windows[1].startSeconds - (windows[0].startSeconds + 1)) < 0.001);
  assert.equal(windows[1].sampleRate, 48000);
});

test('separated audio is what the separator returned', async () => {
  const passThrough = startEngine({ separate: async (left, right) => [left.slice(), right.slice()] });
  passThrough.engine.pushChunk(bytes);
  passThrough.engine.setPlayhead(0, true);
  await settle(passThrough.engine);
  const { engine, windows } = startEngine();
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  const input = passThrough.windows[0].left;
  const output = windows[0].left;
  assert.equal(output.length, input.length);
  assert.ok(input.some((sample) => Math.abs(sample) > 0.05));
  assert.ok(output.every((sample, i) => sample === input[i] * 0.5));
});

test('a seek plans from the new playhead', async () => {
  const { engine, windows } = startEngine();
  engine.pushChunk(bytes);
  engine.setPlayhead(8, true);
  await settle(engine);
  assert.ok(Math.abs(windows[0].startSeconds - 8) < 0.001);
});

test('reset discards a window still in flight', async () => {
  let release;
  const slow = (left, right) => new Promise((resolve) => (release = () => resolve([left, right])));
  const { engine, windows } = startEngine({ separate: slow });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await engine.ready;
  assert.ok(engine.inFlight);
  engine.reset();
  release();
  await settle(engine);
  assert.equal(windows.length, 0);
});

test('a separation error halts the engine and reports it', async () => {
  const failing = async () => {
    throw new Error('boom');
  };
  const { engine, windows, statuses } = startEngine({ separate: failing });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.equal(windows.length, 0);
  assert.ok(statuses.some((s) => s.stage === 'error' && s.message === 'boom'));
});

test('a non-Opus track is reported as unsupported', async () => {
  const { engine, statuses } = startEngine();
  await engine.ready;
  engine.handleInit({ codecId: 'A_AAC' });
  assert.ok(statuses.some((s) => s.stage === 'unsupported'));
});

test('a bad OpusHead halts the engine and reports it', async () => {
  const { engine, statuses } = startEngine();
  engine.handleInit({ codecId: 'A_OPUS', codecPrivate: new Uint8Array(19), seekPreRollNs: 0 });
  await engine.ready;
  assert.ok(statuses.some((s) => s.stage === 'error' && /OpusHead/.test(s.message)));
  assert.equal(engine.isIdle(), true);
});
```

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/stream-engine.js'`

**Step 3: Implement `src/pipeline/stream-engine.js`**

```js
import { FrameDecoder } from './frame-decoder.js';
import { PcmTimeline } from './pcm-timeline.js';
import { addRange, contiguousEnd, trimBefore } from './ranges.js';
import { WebmDemuxer } from './webm-demuxer.js';
import { planNextWindow } from './window-planner.js';

export const DEFAULT_CONFIG = {
  sampleRate: 48000,
  firstWindowSeconds: 2,
  windowSeconds: 10,
  overlapSeconds: 1,
  minWindowSeconds: 1,
  lookaheadSeconds: 30,
  urgencySeconds: 5,
  maxStartGapSeconds: 0.5,
  keepBehindSeconds: 10,
};

export class StreamEngine {
  constructor({ separate, onWindow, onStatus = () => {}, onWarning = () => {}, config = {} }) {
    this.separate = separate;
    this.onWindow = onWindow;
    this.onStatus = onStatus;
    this.onWarning = onWarning;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.generation = 0;
    this.reset();
  }

  reset() {
    this.generation += 1;
    this.demuxer = new WebmDemuxer({
      onInit: (init) => this.handleInit(init),
      onFrame: (frame) => this.handleFrame(frame),
      onWarning: (message) => this.onWarning(message),
    });
    this.decoder?.free();
    this.decoder = null;
    this.queuedFrames = [];
    this.timeline = new PcmTimeline({ channels: 2, pageSamples: this.config.sampleRate });
    this.processed = [];
    this.inFlight = null;
    this.halted = null;
    this.playhead = 0;
    this.isPlaying = false;
    this.ready = Promise.resolve();
  }

  pushChunk(bytes) {
    this.demuxer.push(bytes);
  }

  abort() {
    this.demuxer.abort();
  }

  setPlayhead(seconds, isPlaying) {
    this.playhead = Math.max(0, Math.round(seconds * this.config.sampleRate));
    this.isPlaying = isPlaying;
    const keepFrom = this.playhead - this.config.keepBehindSeconds * this.config.sampleRate;
    if (keepFrom > 0) {
      this.timeline.evictBefore(keepFrom);
      this.processed = trimBefore(this.processed, keepFrom);
    }
    this.pump();
  }

  isIdle() {
    return this.halted !== null || this.plan() === null;
  }

  handleInit(init) {
    if (init.codecId !== 'A_OPUS') {
      this.halted = `codec ${init.codecId} is not supported`;
      this.onStatus({ stage: 'unsupported', reason: this.halted });
      return;
    }
    const decoder = new FrameDecoder({ sampleRate: this.config.sampleRate });
    this.decoder?.free();
    this.decoder = decoder;
    this.ready = decoder
      .configure(init)
      .then(() => {
        if (this.decoder !== decoder) return;
        for (const frame of this.queuedFrames.splice(0)) this.decodeFrame(frame);
        this.pump();
      })
      .catch((error) => {
        if (this.decoder !== decoder) return;
        this.halted = error.message;
        this.onStatus({ stage: 'error', message: error.message });
      });
  }

  handleFrame(frame) {
    if (this.halted || !this.decoder) return;
    if (!this.decoder.isReady) {
      this.queuedFrames.push(frame);
      return;
    }
    this.decodeFrame(frame);
    this.pump();
  }

  decodeFrame(frame) {
    const span = this.decoder.decode(frame);
    if (span) this.timeline.write(span.startSample, span.channelData);
  }

  plan() {
    const { sampleRate: rate, ...c } = this.config;
    return planNextWindow({
      playhead: this.playhead,
      decoded: this.timeline.ranges,
      processed: this.processed,
      firstWindow: c.firstWindowSeconds * rate,
      window: c.windowSeconds * rate,
      overlap: c.overlapSeconds * rate,
      minWindow: c.minWindowSeconds * rate,
      lookahead: c.lookaheadSeconds * rate,
      urgency: c.urgencySeconds * rate,
      maxStartGap: c.maxStartGapSeconds * rate,
    });
  }

  pump() {
    if (this.inFlight || this.halted) return;
    const window = this.plan();
    if (!window) return;
    const pcm = this.timeline.read(window.start, window.end - window.start);
    if (!pcm) return;

    const { generation } = this;
    const rate = this.config.sampleRate;
    const startedAt = Date.now();
    this.inFlight = window;
    this.separate(pcm[0], pcm[1], rate)
      .then(([left, right]) => {
        if (generation !== this.generation) return;
        this.processed = addRange(this.processed, window.start, window.end);
        this.onWindow({ startSeconds: window.start / rate, sampleRate: rate, left, right });
        this.onStatus({
          stage: 'window',
          startSeconds: window.start / rate,
          durationSeconds: (window.end - window.start) / rate,
          computeMs: Date.now() - startedAt,
          aheadSeconds: (contiguousEnd(this.processed, this.playhead) - this.playhead) / rate,
        });
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        this.halted = error.message;
        this.onStatus({ stage: 'error', message: error.message });
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.inFlight = null;
        this.pump();
      });
  }
}
```

Behaviour to know:
- `ready` is the decoder's configure promise, and it only exists once `pushChunk` has parsed an init segment. Before that it is an already-resolved promise. The tests' `settle` awaits it after pushing bytes, and the reset test awaits it so a window is really in flight before `reset()`.
- Frames that arrive while the decoder loads are queued and decoded when it is ready, then `pump()` runs with whatever playhead was set meanwhile.
- A configure failure (bad OpusHead) halts the engine with an `error` status instead of becoming an unhandled rejection.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 62 tests

**Step 5: Commit**

```bash
git add src/pipeline/stream-engine.js test/stream-engine.test.js
git commit -m "feat(pipeline): stream engine from WebM bytes to filtered windows"
```

---

### Task 7: DeepFilterNet3 voice filter and separator Worker stream messages

**Files:**
- Create: `src/pipeline/voice-filter.js`
- Test: `test/voice-filter.test.js`
- Modify: `src/separator/worker.js` (add the stream handling next to `handle`, wire it into `self.onmessage`)
- Modify: `src/separator/frame.js:3` (`transferablesOf`)

DeepFilterNet3 works on 480-sample mono frames at 48 kHz and its output lags its input by 1440 samples: output sample `j` of a frame fed at input offset `o` belongs to input sample `o + j - 1440`. The voice filter hides that. It takes a stereo window and returns the voice, aligned sample for sample, as two identical channels.

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createVoiceFilter, DFN_DELAY_SAMPLES } from '../src/pipeline/voice-filter.js';

const FRAME = 480;
const DF_JS = new URL('../vendor/df/df.js', import.meta.url);
const DF_WASM = new URL('../extension/assets/df_bg.wasm', import.meta.url);
const DF_MODEL = new URL('../extension/assets/DeepFilterNet3_onnx.tar.gz', import.meta.url);
const hasDeepFilterNet = [DF_JS, DF_WASM, DF_MODEL].every((url) => existsSync(url));

function delayingFilter(delaySamples, { warmUpFrames = 0 } = {}) {
  const ring = new Float32Array(delaySamples);
  const inputs = [];
  let position = 0;
  const processFrame = (frame) => {
    inputs.push(frame.slice());
    const out = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      out[i] = ring[position];
      ring[position] = frame[i];
      position = (position + 1) % delaySamples;
    }
    return inputs.length <= warmUpFrames ? out.fill(99) : out;
  };
  return { processFrame, inputs };
}

function noise(length, seed) {
  let state = seed;
  return Float32Array.from({ length }, () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
}

function downmix(left, right) {
  return Float32Array.from(left, (sample, i) => 0.5 * (sample + right[i]));
}

function assertSameSamples(actual, expected) {
  assert.equal(actual.length, expected.length);
  const firstMismatch = actual.findIndex((sample, i) => sample !== expected[i]);
  assert.equal(firstMismatch, -1, `first mismatch at sample ${firstMismatch}`);
}

test('output lines up with the mono downmix sample for sample', () => {
  const { processFrame } = delayingFilter(DFN_DELAY_SAMPLES);
  const filter = createVoiceFilter({ processFrame, frameLength: FRAME, delaySamples: DFN_DELAY_SAMPLES });
  const left = noise(48000 + 123, 1);
  const right = noise(48000 + 123, 2);
  const [voice, copy] = filter(left, right);
  assertSameSamples(voice, downmix(left, right));
  assertSameSamples(copy, voice);
  assert.notEqual(copy.buffer, voice.buffer);
});

test('warm-up runs on the start of the window and its output is dropped', () => {
  const warmUpSamples = 4800;
  const { processFrame, inputs } = delayingFilter(DFN_DELAY_SAMPLES, { warmUpFrames: warmUpSamples / FRAME });
  const filter = createVoiceFilter({ processFrame, frameLength: FRAME, delaySamples: DFN_DELAY_SAMPLES, warmUpSamples });
  const left = noise(9600, 3);
  const right = noise(9600, 4);
  const mono = downmix(left, right);
  const [voice] = filter(left, right);
  assert.equal(inputs.length, warmUpSamples / FRAME + Math.ceil((9600 + DFN_DELAY_SAMPLES) / FRAME));
  assertSameSamples(inputs[0], mono.subarray(0, FRAME));
  assertSameSamples(inputs[warmUpSamples / FRAME], mono.subarray(0, FRAME));
  assert.ok(voice.every((sample) => sample !== 99));
  assertSameSamples(voice, mono);
});

test('a window shorter than a frame and the warm-up keeps its length', () => {
  const { processFrame } = delayingFilter(DFN_DELAY_SAMPLES);
  const filter = createVoiceFilter({ processFrame, frameLength: FRAME, delaySamples: DFN_DELAY_SAMPLES });
  const left = noise(100, 5);
  const right = noise(100, 6);
  assertSameSamples(filter(left, right)[0], downmix(left, right));
});

test(
  'real DeepFilterNet3 keeps the length and strongly attenuates a steady tone',
  { skip: !hasDeepFilterNet && 'vendor/df and extension/assets missing, run npm run build:wasm' },
  async () => {
    const { initSync, df_create, df_get_frame_length, df_process_frame } = await import(DF_JS.href);
    initSync(readFileSync(DF_WASM));
    const handle = df_create(new Uint8Array(readFileSync(DF_MODEL)), 100);
    const filter = createVoiceFilter({
      processFrame: (frame) => df_process_frame(handle, frame),
      frameLength: df_get_frame_length(handle),
    });
    const hiss = noise(2 * 48000, 7);
    const input = Float32Array.from(hiss, (n, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 48000) + 0.1 * n);
    const [voice, copy] = filter(input, input);
    const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
    assert.equal(voice.length, input.length);
    assert.equal(copy.length, input.length);
    assert.ok(voice.every(Number.isFinite));
    const dropDb = 20 * Math.log10(rms(input) / rms(voice));
    assert.ok(dropDb > 20, `RMS dropped ${dropDb.toFixed(1)} dB`);
  },
);
```

The fake `processFrame` delays its input by exactly the model delay through a ring buffer, the way DeepFilterNet3 does, so a correct filter returns the mono downmix unchanged. During warm-up it returns 99s, which must never reach the result. The last test runs the real model and skips itself when the git-ignored build outputs are missing.

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/voice-filter.js'`

**Step 3: Implement `src/pipeline/voice-filter.js`**

```js
export const DFN_DELAY_SAMPLES = 1440;
const DEFAULT_WARM_UP_SAMPLES = 12000;

export function createVoiceFilter({
  processFrame,
  frameLength,
  delaySamples = DFN_DELAY_SAMPLES,
  warmUpSamples = DEFAULT_WARM_UP_SAMPLES,
}) {
  const frame = new Float32Array(frameLength);

  const feed = (mono, offset, end) => {
    frame.fill(0);
    if (offset < end) frame.set(mono.subarray(offset, Math.min(offset + frameLength, end)));
    return processFrame(frame);
  };

  return (left, right) => {
    const { length } = left;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) mono[i] = 0.5 * (left[i] + right[i]);

    const warmUpEnd = Math.min(warmUpSamples, length);
    for (let offset = 0; offset < warmUpEnd; offset += frameLength) feed(mono, offset, warmUpEnd);

    const voice = new Float32Array(length);
    for (let offset = 0; offset < length + delaySamples; offset += frameLength) {
      const out = feed(mono, offset, length);
      const first = Math.max(0, delaySamples - offset);
      const last = Math.min(frameLength, length + delaySamples - offset);
      for (let j = first; j < last; j++) voice[offset + j - delaySamples] = out[j];
    }
    return [voice, voice.slice()];
  };
}
```

Why it works this way:
- One DeepFilterNet3 state serves every window, stream and seek, because `df_create` parses the 8 MB model. Its recurrent state and STFT buffers still hold the previous window. Feeding the window's first 0.25 s first, and discarding that output, settles the state on this window's audio before the real pass.
- The real pass feeds `length + delaySamples` samples, zero-padded at the end, so the last input samples come out. Output index `offset + j - delaySamples` puts each sample back where its input was. Output length always equals input length.
- `frame` is reused. `df_process_frame` copies it into WASM memory and returns a new array, so nothing holds on to it.
- Measured on an M2 Pro: a 10 s window takes about 0.5 s, and a 440 Hz tone plus noise drops by about 48 dB.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 66 tests. Without `vendor/df` and the assets, 65 pass and the DeepFilterNet3 test is skipped.

**Step 5: Update `src/separator/frame.js`**

Replace the `transferablesOf` line with:

```js
const transferablesOf = (data) => [
  ...new Set([data?.left?.buffer, data?.right?.buffer, data?.bytes instanceof ArrayBuffer ? data.bytes : null].filter(Boolean)),
];
```

**Step 6: Add stream handling to `src/separator/worker.js`**

Add the imports at the top, below the existing two:

```js
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { StreamEngine } from '../pipeline/stream-engine.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';
```

Add below `runSeparation`:

```js
const STREAM_MESSAGES = new Set(['stream-reset', 'stream-chunk', 'stream-abort', 'playhead']);
const DFN_WASM_URL = new URL('../assets/df_bg.wasm', import.meta.url);
const DFN_MODEL_URL = new URL('../assets/DeepFilterNet3_onnx.tar.gz', import.meta.url);
const DFN_ATTEN_LIM_DB = 100;
let stream = null;
let voiceFilter;

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function loadVoiceFilter(report) {
  if (voiceFilter) return voiceFilter;
  report({ stage: 'loading' });
  voiceFilter = Promise.all([fetchBytes(DFN_WASM_URL), fetchBytes(DFN_MODEL_URL)]).then(async ([wasm, model]) => {
    initSync(await WebAssembly.compile(wasm));
    const handle = df_create(model, DFN_ATTEN_LIM_DB);
    return createVoiceFilter({
      processFrame: (frame) => df_process_frame(handle, frame),
      frameLength: df_get_frame_length(handle),
    });
  });
  voiceFilter.catch(() => {
    voiceFilter = undefined;
  });
  return voiceFilter;
}

function createWindowFilter(model, streamId) {
  if (model === 'fake') return async (left, right) => [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
  if (model !== 'dfn3') throw new Error(`unknown model ${model}`);
  const report = (status) => post({ type: 'stream-status', streamId, ...status });
  loadVoiceFilter(report).catch(() => {});
  return async (left, right) => (await loadVoiceFilter(report))(left, right);
}

function handleStream(data) {
  if (data.type === 'stream-reset') {
    const { streamId, model } = data;
    stream?.engine.reset();
    stream = {
      id: streamId,
      engine: new StreamEngine({
        separate: createWindowFilter(model, streamId),
        onWindow: (window) => {
          const transfer = [...new Set([window.left.buffer, window.right.buffer])];
          post({ type: 'window', streamId, ...window }, transfer);
        },
        onStatus: (status) => post({ type: 'stream-status', streamId, ...status }),
        onWarning: (message) => post({ type: 'stream-status', streamId, stage: 'warning', message }),
      }),
    };
    return;
  }
  if (!stream || data.streamId !== stream.id) return;
  if (data.type === 'stream-chunk') stream.engine.pushChunk(new Uint8Array(data.bytes));
  if (data.type === 'stream-abort') stream.engine.abort();
  if (data.type === 'playhead') stream.engine.setPlayhead(data.seconds, data.isPlaying);
}
```

Behaviour to know:
- The worker bundle is ESM at `extension/dist/separator-worker.js`, so `new URL('../assets/…', import.meta.url)` resolves to `extension/assets/`. The Worker runs in the extension origin, so these are same-origin fetches. `web_accessible_resources` already lists `assets/*`, which only matters for pages.
- `WebAssembly.compile` keeps the 9 MB compile off the synchronous path. The manifest's `extension_pages` CSP already allows `'wasm-unsafe-eval'`. DeepFilterNet3 never reaches wasm-bindgen's `new Function` fallback during `initSync`, `df_create` or `df_process_frame` (checked in Node with and without a `self` global), so no `'unsafe-eval'` is needed.
- The model starts loading on `stream-reset`, so the first window does not wait for it. A failed load is forgotten and retried by the next window, which then halts the engine with an `error` status.
- The voice filter is synchronous, so two streams can never interleave inside one DeepFilterNet3 call. `stream-reset` still resets the old engine, which frees its Opus decoder and bumps its generation, so a window it has in flight is dropped.
- Model `fake` (halves the input) stays for the e2e test. Any other name than `fake` or `dfn3` is an error.
- The `separate` and `prepare` messages and their MRX code stay for the clip-test spike. Nothing in the read-ahead path uses them.

In `self.onmessage`, before `handle(data)…`, add:

```js
  if (STREAM_MESSAGES.has(data.type)) {
    try {
      handleStream(data);
    } catch (error) {
      post({ type: 'stream-status', streamId: data.streamId, stage: 'error', message: error.message });
    }
    return;
  }
```

**Step 7: Build and check the bundle**

Run: `npm run build:separator`
Expected: `extension/dist/separator-worker.js` builds (about 1.1 MB, most of it the clip test's onnxruntime) with opus-decoder, `vendor/df/df.js` and the voice filter inside, and no unresolved imports. Its only external imports are the `node:*` dynamic imports that `@audio/neural-separate` already had. `vendor/df/df.js` must exist first (`npm run build:wasm`), as it already must for `build:worklet`.

`df.js` also has a default `__wbg_init` that builds `new URL('df_bg.wasm', import.meta.url)`. esbuild keeps that function in the bundle, because `__wbg_finalize_init` references it, but esbuild 0.25 does not treat the URL as an asset, so the build does not fail. The worker only calls `initSync`, so the URL is never built and nothing requests `dist/df_bg.wasm`.

Run: `npm test`
Expected: PASS, 66 tests

**Step 8: Commit**

```bash
git add src/pipeline/voice-filter.js test/voice-filter.test.js src/separator/worker.js src/separator/frame.js
git commit -m "feat(separator): DeepFilterNet3 voice filter behind the stream engine messages"
```

---

### Task 8: MSE tap v2

**Files:**
- Rewrite: `extension/mse-tap.js`

This script runs in the page's MAIN world at `document_start`, before YouTube creates its MediaSource. It buffers events until the content script connects, because content scripts run at `document_idle`, after YouTube has already appended its first audio.

**Step 1: Replace `extension/mse-tap.js`**

```js
(() => {
  if (window.__musicFilterTap) return;
  const CONNECT = 'music-filter:tap-connect';
  const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (object) => {
    if (!ids.has(object)) ids.set(object, nextId++);
    return ids.get(object);
  };
  const audioStreamIds = new WeakMap();
  const queue = [];
  let queuedBytes = 0;
  let droppedBytes = 0;
  let port = null;
  window.__musicFilterTap = { isConnected: () => Boolean(port), droppedBytes: () => droppedBytes };

  const copy = (data) =>
    (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)).slice()
      .buffer;

  function emit(event) {
    const transfer = event.bytes ? [event.bytes] : [];
    if (port) {
      port.postMessage(event, transfer);
      return;
    }
    if (event.bytes) {
      if (queuedBytes + event.bytes.byteLength > MAX_QUEUED_BYTES) {
        droppedBytes += event.bytes.byteLength;
        return;
      }
      queuedBytes += event.bytes.byteLength;
    }
    queue.push(event);
  }

  function wrapMediaSource(MediaSourceClass) {
    const proto = MediaSourceClass?.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'addSourceBuffer')) return;
    const addSourceBuffer = proto.addSourceBuffer;
    proto.addSourceBuffer = function (mime) {
      const sourceBuffer = addSourceBuffer.call(this, mime);
      if (String(mime).startsWith('audio/')) {
        const streamId = idOf(sourceBuffer);
        const isManaged = typeof window.ManagedMediaSource === 'function' && this instanceof window.ManagedMediaSource;
        audioStreamIds.set(sourceBuffer, streamId);
        emit({ kind: 'source-buffer', streamId, mediaSourceId: idOf(this), mime: String(mime), isManaged });
      }
      return sourceBuffer;
    };
  }

  function wrapSourceBuffer(SourceBufferClass) {
    const proto = SourceBufferClass?.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'appendBuffer')) return;
    const appendBuffer = proto.appendBuffer;
    const abort = proto.abort;
    proto.appendBuffer = function (data) {
      const streamId = audioStreamIds.get(this);
      if (streamId) emit({ kind: 'append', streamId, bytes: copy(data) });
      return appendBuffer.call(this, data);
    };
    proto.abort = function () {
      const streamId = audioStreamIds.get(this);
      if (streamId) emit({ kind: 'abort', streamId });
      return abort.call(this);
    };
  }

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    const url = createObjectURL.call(URL, object);
    if (object && typeof object.addSourceBuffer === 'function') emit({ kind: 'object-url', mediaSourceId: idOf(object), url });
    return url;
  };

  wrapMediaSource(window.MediaSource);
  wrapMediaSource(window.ManagedMediaSource);
  wrapSourceBuffer(window.SourceBuffer);
  wrapSourceBuffer(window.ManagedSourceBuffer);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== CONNECT || port || !event.ports[0]) return;
    port = event.ports[0];
    for (const queued of queue.splice(0)) port.postMessage(queued, queued.bytes ? [queued.bytes] : []);
    queuedBytes = 0;
  });
})();
```

Notes:
- The `hasOwnProperty` checks stop double-wrapping where `ManagedSourceBuffer` inherits `appendBuffer` from `SourceBuffer`. `ManagedMediaSource` inherits `addSourceBuffer` the same way, so its calls go through the `MediaSource` wrapper and `isManaged` is read from the instance.
- A hostile page could send the connect message first and take the port. That only stops filtering on that page, and the page is the one serving the audio, so it is accepted.

**Step 2: Syntax check**

Run: `node --check extension/mse-tap.js`
Expected: no output

**Step 3: Commit**

```bash
git add extension/mse-tap.js
git commit -m "feat(extension): MSE tap streams audio appends over a MessagePort"
```

---

### Task 9: Playback math and hold policy

**Files:**
- Create: `src/pipeline/playback-math.js`, `src/pipeline/hold-policy.js`
- Test: `test/playback-math.test.js`, `test/hold-policy.test.js`

**Step 1: Write the failing tests**

`test/playback-math.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { crossfadeSpan, measureDrift, scheduleSpan } from '../src/pipeline/playback-math.js';

test('scheduleSpan starts a future window at its start', () => {
  assert.deepEqual(scheduleSpan({ windowStart: 12, windowEnd: 22, mediaNow: 10, ctxNow: 100 }), {
    when: 102,
    offset: 0,
    duration: 10,
    startMedia: 12,
  });
});

test('scheduleSpan joins a window already under the playhead', () => {
  const span = scheduleSpan({ windowStart: 8, windowEnd: 18, mediaNow: 10, ctxNow: 100, lead: 0.05 });
  assert.ok(Math.abs(span.when - 100.05) < 1e-9);
  assert.ok(Math.abs(span.offset - 2.05) < 1e-9);
  assert.ok(Math.abs(span.duration - 7.95) < 1e-9);
});

test('scheduleSpan skips a window that has passed', () => {
  assert.equal(scheduleSpan({ windowStart: 0, windowEnd: 10, mediaNow: 10, ctxNow: 100 }), null);
});

test('crossfadeSpan covers the future part of the overlap', () => {
  assert.deepEqual(crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 5 }), { from: 12, to: 13 });
  const late = crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 12.5, lead: 0.05 });
  assert.ok(Math.abs(late.from - 12.55) < 1e-9);
  assert.equal(crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 13 }), null);
});

test('measureDrift is positive when audio runs ahead of video', () => {
  assert.ok(Math.abs(measureDrift({ anchorCtx: 100, anchorMedia: 10, ctxNow: 105.1, mediaNow: 15 }) - 0.1) < 1e-9);
});
```

`test/hold-policy.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideHold, readyAheadSeconds } from '../src/pipeline/hold-policy.js';

const playing = {
  failure: null,
  hasStream: true,
  playbackRate: 1,
  isPaused: false,
  isHeld: false,
  heldSeconds: 0,
  isAudioRunning: true,
  processed: [],
  now: 40,
  duration: 60,
};

test('readyAheadSeconds counts from the playhead and allows a small gap before the first window', () => {
  const processed = [[0.0065, 2.0065], [5, 9]];
  assert.ok(Math.abs(readyAheadSeconds(processed, 0) - 2.0065) < 1e-9);
  assert.ok(Math.abs(readyAheadSeconds(processed, 1) - 1.0065) < 1e-9);
  assert.equal(readyAheadSeconds(processed, 4), 0);
  assert.ok(Math.abs(readyAheadSeconds(processed, 4.6) - 4.4) < 1e-9);
  assert.equal(readyAheadSeconds(processed, 10), 0);
});

test('playing without filtered audio at the playhead pauses', () => {
  assert.deepEqual(decideHold({ ...playing, processed: [[40, 40.2]] }), { action: 'pause', state: 'filtering' });
  assert.deepEqual(decideHold({ ...playing, processed: [[40, 40.4]] }), { action: 'none', state: 'filtered' });
});

test('a held video resumes once 2 s are ready, or the rest of the video', () => {
  const held = { ...playing, isPaused: true, isHeld: true };
  assert.deepEqual(decideHold({ ...held, processed: [[40, 41.9]] }), { action: 'none', state: 'filtering' });
  assert.deepEqual(decideHold({ ...held, processed: [[40, 42]] }), { action: 'resume', state: 'filtered' });
  assert.deepEqual(decideHold({ ...held, now: 58.8, processed: [[50, 59.98]] }), { action: 'resume', state: 'filtered' });
});

test('pressing play while held and not ready pauses again', () => {
  assert.deepEqual(decideHold({ ...playing, isHeld: true, processed: [[40, 41]] }), { action: 'pause', state: 'filtering' });
});

test('a pause the user made is left alone', () => {
  const paused = { ...playing, isPaused: true };
  assert.deepEqual(decideHold(paused), { action: 'none', state: 'waiting' });
  assert.deepEqual(decideHold({ ...paused, processed: [[40, 50]] }), { action: 'none', state: 'filtered' });
});

test('speeds other than 1x mute instead of holding and release a hold', () => {
  assert.deepEqual(decideHold({ ...playing, playbackRate: 1.5 }), { action: 'none', state: 'muted' });
  assert.deepEqual(decideHold({ ...playing, playbackRate: 1.5, isPaused: true, isHeld: true }), {
    action: 'resume',
    state: 'muted',
  });
});

test('a failure or a hold that lasts too long releases the video', () => {
  const held = { ...playing, isPaused: true, isHeld: true };
  assert.deepEqual(decideHold({ ...held, failure: 'codec A_AAC is not supported' }), { action: 'resume', state: 'error' });
  assert.deepEqual(decideHold({ ...held, heldSeconds: 30 }), {
    action: 'resume',
    state: 'error',
    failure: 'no filtered audio after 30 s',
  });
});

test('no stream or a stopped audio context is never treated as ready', () => {
  assert.deepEqual(decideHold({ ...playing, hasStream: false }), { action: 'none', state: 'waiting' });
  assert.deepEqual(decideHold({ ...playing, isAudioRunning: false, processed: [[40, 50]] }), {
    action: 'pause',
    state: 'filtering',
  });
});
```

**Step 2: Run them and see them fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/playback-math.js'` and `…/src/pipeline/hold-policy.js`

**Step 3: Implement `src/pipeline/playback-math.js`**

```js
export function scheduleSpan({ windowStart, windowEnd, mediaNow, ctxNow, lead = 0.05 }) {
  const startMedia = Math.max(windowStart, mediaNow + lead);
  if (startMedia >= windowEnd) return null;
  return {
    when: ctxNow + (startMedia - mediaNow),
    offset: startMedia - windowStart,
    duration: windowEnd - startMedia,
    startMedia,
  };
}

export function crossfadeSpan({ previousEnd, nextStart, mediaNow, lead = 0.05 }) {
  const from = Math.max(nextStart, mediaNow + lead);
  if (from >= previousEnd) return null;
  return { from, to: previousEnd };
}

export function measureDrift({ anchorCtx, anchorMedia, ctxNow, mediaNow }) {
  return ctxNow - anchorCtx - (mediaNow - anchorMedia);
}
```

**Step 4: Implement `src/pipeline/hold-policy.js`**

```js
import { contiguousEnd, nextRangeStart } from './ranges.js';

export const HOLD_CONFIG = {
  playMarginSeconds: 0.3,
  resumeAheadSeconds: 2,
  startGapSeconds: 0.5,
  endSlackSeconds: 0.5,
  holdTimeoutSeconds: 30,
};

export function readyAheadSeconds(processed, now, startGapSeconds = HOLD_CONFIG.startGapSeconds) {
  const start = nextRangeStart(processed, now);
  if (start === null || start - now > startGapSeconds) return 0;
  return contiguousEnd(processed, start) - now;
}

export function decideHold({
  failure,
  hasStream,
  playbackRate,
  isPaused,
  isHeld,
  heldSeconds,
  isAudioRunning,
  processed,
  now,
  duration,
  config = HOLD_CONFIG,
}) {
  const release = (state) => ({ action: isHeld ? 'resume' : 'none', state });
  if (failure) return release('error');
  if (playbackRate !== 1) return release('muted');
  if (!hasStream) return release('waiting');

  const remaining = Number.isFinite(duration) ? Math.max(0, duration - now - config.endSlackSeconds) : Infinity;
  const ahead = isAudioRunning ? readyAheadSeconds(processed, now, config.startGapSeconds) : 0;
  if (isHeld) {
    if (ahead >= Math.min(config.resumeAheadSeconds, remaining)) return { action: 'resume', state: 'filtered' };
    if (heldSeconds >= config.holdTimeoutSeconds) {
      return { action: 'resume', state: 'error', failure: `no filtered audio after ${config.holdTimeoutSeconds} s` };
    }
    return { action: isPaused ? 'none' : 'pause', state: 'filtering' };
  }
  const isReady = ahead >= Math.min(config.playMarginSeconds, remaining);
  if (isReady) return { action: 'none', state: 'filtered' };
  return isPaused ? { action: 'none', state: 'waiting' } : { action: 'pause', state: 'filtering' };
}
```

The content script calls `decideHold` on every tick and on media events. `action` is what to do to the video: `pause` (and mark it held), `resume` (clear the hold and play if paused) or `none`. `state` is the panel state.

Why it works this way:
- `isHeld` means the extension made the pause. A pause the user made is never undone. If the user presses play while held and audio is still not ready, the next decision pauses again.
- Decoded audio, and so the first processed window, starts 312 samples (6.5 ms) after 0, and up to 80 ms after a seek point because of the Opus pre-roll. `readyAheadSeconds` lets the first processed range start up to 0.5 s after the playhead, the same tolerance the window planner uses. Without it a video at 0 s would hold forever.
- The audio track can end a few tens of milliseconds before `video.duration`. `endSlackSeconds` stops the last half second from needing audio, or the end of every video would hold until the timeout.
- An audio context that is not running cannot play processed audio, so it counts as nothing ready.

**Step 5: Run tests**

Run: `npm test`
Expected: PASS, 79 tests

**Step 6: Commit**

```bash
git add src/pipeline/playback-math.js src/pipeline/hold-policy.js test/playback-math.test.js test/hold-policy.test.js
git commit -m "feat(pipeline): playback scheduling math and hold policy"
```

---

### Task 10: Content script

**Files:**
- Create: `src/content/separator-client.js`, `src/content/original-audio.js`, `src/content/playback-scheduler.js`, `src/content/panel.js`, `src/content/read-ahead.js`
- Modify: `scripts/build-separator.mjs`
- Modify: `extension/manifest.json`

**Step 1: `src/content/separator-client.js`**

```js
const SEPARATOR_PAGE = 'separator.html';
const CONNECT = 'music-filter:connect';
const START_TIMEOUT_MS = 15000;

export function connectSeparator({ onMessage }) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(SEPARATOR_PAGE);
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
    });
    const fail = (error) => {
      clearTimeout(timer);
      frame.remove();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('separator frame did not start')), START_TIMEOUT_MS);
    frame.addEventListener(
      'load',
      () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          if (data.type === 'error') return fail(new Error(data.message));
          if (data.type !== 'ready') return;
          clearTimeout(timer);
          channel.port1.onmessage = ({ data: message }) => onMessage(message);
          resolve({ port: channel.port1, frame, info: data });
        };
        frame.contentWindow.postMessage({ type: CONNECT }, new URL(frame.src).origin, [channel.port2]);
      },
      { once: true },
    );
    document.documentElement.append(frame);
  });
}
```

**Step 2: `src/content/original-audio.js`**

```js
const RAMP_SECONDS = 0.03;

export function createOriginalAudio(video, context, { mode }) {
  if (mode === 'graph') {
    const source = context.createMediaElementSource(video);
    const gain = new GainNode(context, { gain: 1 });
    source.connect(gain).connect(context.destination);
    let level = 1;
    return {
      mode,
      setLevel(next) {
        if (next === level) return;
        level = next;
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(next, now + RAMP_SECONDS);
      },
      currentLevel: () => level,
      userVolume: () => (video.muted ? 0 : video.volume),
      dispose() {
        this.setLevel(1);
      },
    };
  }

  let level = 1;
  let isUserMuted = video.muted;
  const onVolumeChange = () => {
    if (level === 1) {
      isUserMuted = video.muted;
      return;
    }
    if (!video.muted) {
      isUserMuted = false;
      video.muted = true;
    }
  };
  video.addEventListener('volumechange', onVolumeChange);
  return {
    mode,
    setLevel(next) {
      if (next === level) return;
      level = next;
      video.muted = next === 0 ? true : isUserMuted;
    },
    currentLevel: () => level,
    userVolume: () => (isUserMuted ? 0 : video.volume),
    dispose() {
      this.setLevel(1);
      video.removeEventListener('volumechange', onVolumeChange);
    },
  };
}
```

In mute mode, YouTube's mute icon shows "muted" while processed audio plays. If the user clicks unmute there, filtering continues and the element is muted again. That is a known v1 wart on Safari.

`currentLevel()` feeds the panel's `data-original-level`, so the e2e test checks the real level rather than what the orchestrator meant to set.

**Step 3: `src/content/playback-scheduler.js`**

```js
import { readyAheadSeconds } from '../pipeline/hold-policy.js';
import { crossfadeSpan, measureDrift, scheduleSpan } from '../pipeline/playback-math.js';
import { addRange } from '../pipeline/ranges.js';

const HORIZON_SECONDS = 2;
const KEEP_BEHIND_SECONDS = 30;
const KEEP_AHEAD_SECONDS = 90;
const DRIFT_LIMIT_SECONDS = 0.08;

export class PlaybackScheduler {
  constructor(context, video) {
    this.context = context;
    this.video = video;
    this.bus = new GainNode(context, { gain: 1 });
    this.bus.connect(context.destination);
    this.windows = [];
    this.ranges = [];
    this.playing = new Map();
    this.anchor = null;
  }

  addWindow({ startSeconds, sampleRate, left, right }) {
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    this.windows.push({ start: startSeconds, end: startSeconds + left.length / sampleRate, buffer });
    this.windows.sort((a, b) => a.start - b.start);
    this.ranges = addRange(this.ranges, startSeconds, startSeconds + left.length / sampleRate);
  }

  tick({ allowProcessed }) {
    const mediaNow = this.video.currentTime;
    const ctxNow = this.context.currentTime;
    this.evict(mediaNow);
    if (!allowProcessed) {
      this.stopAll();
      return;
    }
    if (this.anchor && Math.abs(measureDrift({ ...this.anchor, ctxNow, mediaNow })) > DRIFT_LIMIT_SECONDS) this.stopAll();
    for (const window of this.windows) {
      if (this.playing.has(window) || window.end <= mediaNow || window.start > mediaNow + HORIZON_SECONDS) continue;
      this.start(window, mediaNow, ctxNow);
    }
  }

  start(window, mediaNow, ctxNow) {
    const span = scheduleSpan({ windowStart: window.start, windowEnd: window.end, mediaNow, ctxNow });
    if (!span) return;
    const toContext = (media) => ctxNow + (media - mediaNow);
    const source = new AudioBufferSourceNode(this.context, { buffer: window.buffer });
    const gain = new GainNode(this.context, { gain: 1 });
    source.connect(gain).connect(this.bus);

    const previous = [...this.playing.entries()].find(([other]) => other.start < window.start && other.end > span.startMedia);
    if (previous) {
      const fade = crossfadeSpan({ previousEnd: previous[0].end, nextStart: window.start, mediaNow });
      if (fade) {
        gain.gain.setValueAtTime(0, ctxNow);
        gain.gain.setValueAtTime(0, toContext(fade.from));
        gain.gain.linearRampToValueAtTime(1, toContext(fade.to));
        previous[1].gain.gain.setValueAtTime(1, toContext(fade.from));
        previous[1].gain.gain.linearRampToValueAtTime(0, toContext(fade.to));
      }
    }

    source.start(span.when, span.offset, span.duration);
    source.onended = () => {
      if (this.playing.get(window)?.source === source) this.playing.delete(window);
    };
    this.playing.set(window, { source, gain });
    this.anchor ??= { anchorCtx: ctxNow, anchorMedia: mediaNow };
  }

  stopAll() {
    for (const { source } of this.playing.values()) {
      try {
        source.stop();
      } catch {}
    }
    this.playing.clear();
    this.anchor = null;
  }

  reset() {
    this.stopAll();
    this.windows = [];
    this.ranges = [];
  }

  setVolume(level) {
    this.bus.gain.setTargetAtTime(level, this.context.currentTime, 0.01);
  }

  secondsAhead() {
    return readyAheadSeconds(this.ranges, this.video.currentTime);
  }

  evict(mediaNow) {
    const keepFrom = mediaNow - KEEP_BEHIND_SECONDS;
    const keepTo = mediaNow + KEEP_AHEAD_SECONDS;
    const kept = this.windows.filter((w) => this.playing.has(w) || (w.end > keepFrom && w.start < keepTo));
    if (kept.length === this.windows.length) return;
    this.windows = kept;
    this.ranges = kept.reduce((ranges, w) => addRange(ranges, w.start, w.end), []);
  }
}
```

**Step 4: `src/content/panel.js`**

```js
const MESSAGES = {
  off: () => '',
  waiting: () => 'Waiting for audio',
  filtering: () => 'Filtering…',
  filtered: (view) => `Filtered · ${view.aheadSeconds.toFixed(0)} s ready`,
  muted: () => 'Filter works at Normal speed',
  error: (view) => `Can't filter this video: ${view.detail}`,
};
const STATES_WITH_DETAIL = new Set(['waiting', 'filtering', 'filtered']);

export function createPanel({ onToggle }) {
  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'fixed',
    top: '64px',
    left: '8px',
    zIndex: '2147483647',
    padding: '6px 8px',
    maxWidth: '320px',
    font: '12px/1.4 ui-monospace, monospace',
    background: 'rgba(10, 20, 40, 0.88)',
    color: '#cfe3ff',
    borderRadius: '6px',
  });
  const button = document.createElement('button');
  Object.assign(button.style, {
    font: 'inherit',
    padding: '4px 8px',
    cursor: 'pointer',
    background: '#13233f',
    color: '#cfe3ff',
    border: '1px solid #cfe3ff',
    borderRadius: '4px',
  });
  const status = document.createElement('div');
  root.append(button, status);

  const view = { isOn: false, state: 'off', detail: '', aheadSeconds: 0, windows: 0, originalLevel: 1 };
  const render = () => {
    button.textContent = `Music filter: ${view.isOn ? 'ON' : 'OFF'}`;
    const extra = view.detail && STATES_WITH_DETAIL.has(view.state) ? ` · ${view.detail}` : '';
    status.textContent = view.isOn ? `${MESSAGES[view.state](view)}${extra}` : '';
    Object.assign(root.dataset, {
      state: view.state,
      originalLevel: String(view.originalLevel),
      aheadSeconds: view.aheadSeconds.toFixed(1),
      windows: String(view.windows),
    });
    if (!root.isConnected) document.documentElement.append(root);
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    view.isOn = !view.isOn;
    render();
    onToggle(view.isOn);
  });
  render();
  return {
    update(partial) {
      Object.assign(view, partial);
      render();
    },
  };
}
```

**Step 5: `src/content/read-ahead.js`**

```js
import { decideHold } from '../pipeline/hold-policy.js';
import { createOriginalAudio } from './original-audio.js';
import { createPanel } from './panel.js';
import { PlaybackScheduler } from './playback-scheduler.js';
import { connectSeparator } from './separator-client.js';

const TAP_CONNECT = 'music-filter:tap-connect';
const TICK_MS = 250;
const RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 4;
const OUTPUT_SAMPLE_RATE = 48000;
const TICK_EVENTS = ['play', 'playing', 'seeked', 'ratechange'];

const isSafari = navigator.vendor === 'Apple Computer, Inc.';
const isLocalTest = location.hostname === 'localhost' && localStorage.getItem('mf_fake_separator') === '1';
const MODEL = isLocalTest ? 'fake' : 'dfn3';

const streams = new Map();
const objectUrls = new Map();
let separator;
let activeStreamId = null;
let isEnabled = false;
let context;
let scheduler;
let original;
let attachedVideo;
let detail = '';
let failure = null;
let heldSince = null;

const panel = createPanel({ onToggle: (on) => setEnabled(on).catch((error) => fail(error.message)) });
connectTap();
setInterval(tick, TICK_MS);

function connectTap() {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => handleTapEvent(data);
  window.postMessage({ type: TAP_CONNECT }, '*', [channel.port2]);
}

function handleTapEvent(event) {
  if (event.kind === 'object-url') {
    objectUrls.set(event.mediaSourceId, event.url);
    return;
  }
  if (event.kind === 'source-buffer') {
    streams.set(event.streamId, { ...event, init: null, chunks: [], retainedBytes: 0 });
    for (const id of streams.keys()) {
      if (streams.size <= MAX_STREAMS) break;
      if (id !== activeStreamId) streams.delete(id);
    }
    return;
  }
  const stream = streams.get(event.streamId);
  if (!stream) return;
  if (event.kind === 'append') {
    retain(stream, event.bytes);
    if (event.streamId === activeStreamId) sendChunk(event.streamId, event.bytes);
  }
  if (event.kind === 'abort' && event.streamId === activeStreamId) send({ type: 'stream-abort', streamId: event.streamId });
}

function retain(stream, bytes) {
  if (!stream.init) {
    stream.init = bytes;
    return;
  }
  stream.chunks.push(bytes);
  stream.retainedBytes += bytes.byteLength;
  while (stream.retainedBytes > RETAINED_BYTES) stream.retainedBytes -= stream.chunks.shift().byteLength;
}

function sendChunk(streamId, bytes) {
  const copy = bytes.slice(0);
  send({ type: 'stream-chunk', streamId, bytes: copy }, [copy]);
}

function ensureSeparator() {
  separator ??= connectSeparator({ onMessage: handleWorkerMessage }).catch((error) => {
    separator = undefined;
    throw error;
  });
  return separator;
}

function send(message, transfer = []) {
  ensureSeparator().then(
    ({ port }) => port.postMessage(message, transfer),
    (error) => fail(`separator: ${error.message}`),
  );
}

function handleWorkerMessage(message) {
  if (message.type === 'error') {
    fail(`separator: ${message.message}`);
    return;
  }
  if (message.streamId !== activeStreamId) return;
  if (message.type === 'window') {
    scheduler?.addWindow(message);
    return;
  }
  if (message.type !== 'stream-status') return;
  if (message.stage === 'unsupported' || message.stage === 'error') fail(message.reason ?? message.message);
  if (message.stage === 'loading') detail = 'loading voice filter';
  if (message.stage === 'window') detail = `window ${message.durationSeconds.toFixed(0)} s in ${(message.computeMs / 1000).toFixed(1)} s`;
}

function fail(message) {
  failure = message;
  scheduler?.stopAll();
  releaseHold();
  panel.update({ state: 'error', detail: message, originalLevel: original?.currentLevel() ?? 1 });
}

function releaseHold() {
  if (heldSince === null) return;
  heldSince = null;
  if (attachedVideo?.paused) attachedVideo.play().catch(() => {});
}

function applyHold(action) {
  if (action === 'resume') releaseHold();
  if (action !== 'pause') return;
  heldSince ??= performance.now();
  attachedVideo.pause();
}

function pickVideo() {
  return document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
}

function selectStream(video) {
  const src = video.currentSrc || video.src;
  let match = null;
  for (const stream of streams.values()) if (objectUrls.get(stream.mediaSourceId) === src) match = stream;
  return match;
}

function activate(stream) {
  activeStreamId = stream.streamId;
  failure = null;
  scheduler?.reset();
  send({ type: 'stream-reset', streamId: stream.streamId, mime: stream.mime, model: MODEL });
  if (stream.init) sendChunk(stream.streamId, stream.init);
  for (const chunk of stream.chunks) sendChunk(stream.streamId, chunk);
}

function attach(video) {
  original?.dispose();
  context ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
  original = createOriginalAudio(video, context, { mode: isSafari ? 'mute' : 'graph' });
  scheduler?.reset();
  scheduler = new PlaybackScheduler(context, video);
  attachedVideo = video;
  activeStreamId = null;
  heldSince = null;
  video.addEventListener('seeking', () => {
    scheduler?.stopAll();
    tick();
  });
  for (const type of TICK_EVENTS) video.addEventListener(type, () => tick());
  video.addEventListener('play', () => context.resume());
}

async function setEnabled(on) {
  isEnabled = on;
  if (!on) {
    releaseHold();
    scheduler?.stopAll();
    original?.setLevel(1);
    panel.update({ state: 'off', detail: '', originalLevel: 1 });
    return;
  }
  const video = pickVideo();
  if (!video) throw new Error('no video on this page');
  if (video !== attachedVideo) attach(video);
  original.setLevel(0);
  failure = null;
  activeStreamId = null;
  panel.update({ state: 'waiting', detail: '', originalLevel: 0 });
  await context.resume();
  if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
  ensureSeparator().catch(() => {});
  tick();
}

function tick() {
  if (!isEnabled) return;
  const video = pickVideo();
  if (!video) return;
  if (video !== attachedVideo) attach(video);
  const stream = selectStream(video);
  if (stream && stream.streamId !== activeStreamId) activate(stream);
  if (activeStreamId !== null) {
    send({ type: 'playhead', streamId: activeStreamId, seconds: video.currentTime, isPlaying: !video.paused });
  }
  if (context.state !== 'running') context.resume().catch(() => {});

  const isAudioRunning = context.state === 'running';
  const decision = decideHold({
    failure,
    hasStream: activeStreamId !== null,
    playbackRate: video.playbackRate,
    isPaused: video.paused,
    isHeld: heldSince !== null,
    heldSeconds: heldSince === null ? 0 : (performance.now() - heldSince) / 1000,
    isAudioRunning,
    processed: scheduler.ranges,
    now: video.currentTime,
    duration: video.duration,
  });
  if (decision.failure) fail(decision.failure);
  else applyHold(decision.action);

  original.setLevel(0);
  const isFiltered = !failure && decision.state === 'filtered';
  scheduler.tick({ allowProcessed: isFiltered && !video.paused && !video.seeking && isAudioRunning });
  scheduler.setVolume(isFiltered ? original.userVolume() : 0);
  panel.update({
    state: failure ? 'error' : decision.state,
    detail: failure ?? detail,
    originalLevel: original.currentLevel(),
    aheadSeconds: scheduler.secondsAhead(),
    windows: scheduler.windows.length,
  });
}
```

Behaviour to know:
- While the filter is on, the original audio is set to 0 on every tick, including in the `muted`, `waiting` and `error` states. Only `setEnabled(false)` sets it back to 1.
- The hold controller is `decideHold` plus `heldSince`. `heldSince` is set when the extension pauses the video and cleared when it resumes it, when the filter is turned off, on a failure, and when a new video element is attached. Only a held video is ever resumed with `video.play()`. A `play()` the browser rejects clears the hold, so the user's next play press is handled normally.
- `play`, `playing`, `seeking`, `seeked` and `ratechange` run `tick()` at once. A play press before audio is ready is paused again within the same event, not up to 250 ms later, and processed audio starts right after a resume.
- `type: 'error'` messages come from `frame.js` (the Worker failed to start or crashed) and carry no `streamId`. They are handled before the stream filter, or a dead Worker would leave the panel on `waiting` with no reason shown.
- Processed audio needs `context.state === 'running'`. Safari moves the context to `interrupted` on calls and some backgrounding. A stopped context counts as nothing ready, so a playing video is held and `tick()` asks the context to resume. If it never does, the 30 s hold timeout turns into an error and the video plays on, muted.
- Turning the filter on clears `failure` and `activeStreamId`, so the next tick restarts the stream from its retained bytes. That is how the user retries after an error.
- No active stream (the tap missed the MediaSource, or a new video has not appended yet) shows `waiting` and does not hold, so the video is never paused waiting for a stream that may not come.
- Each YouTube video gets a new MediaSource. Old streams are dropped past `MAX_STREAMS`, so their retained bytes (up to 16 MB each) do not pile up over a long session. Ads get their own MediaSource and are filtered like any other stream.

**Step 6: Bundle it.** In `scripts/build-separator.mjs`, after the existing `await build(...)`, add:

```js
await build({
  entryPoints: { 'read-ahead': 'src/content/read-ahead.js' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outdir: OUT_DIR,
  logLevel: 'info',
});
```

**Step 7: Manifest.** Set `content_scripts` in `extension/manifest.json` to exactly:

```json
[
  {
    "matches": ["https://www.youtube.com/*", "https://m.youtube.com/*", "http://localhost/*"],
    "js": ["mse-tap.js"],
    "run_at": "document_start",
    "world": "MAIN"
  },
  {
    "matches": ["https://www.youtube.com/*", "https://m.youtube.com/*", "http://localhost/*"],
    "js": ["dist/read-ahead.js"],
    "run_at": "document_idle"
  }
]
```

Leave `web_accessible_resources` as it is. It already lists `separator.html`, `dist/separator-frame.js`, `dist/separator-worker.js`, `dist/ort/*` and `assets/*`. `content.js` and `clip-test.js` stay in the repo. To use their Diagnose button, temporarily put them back in `content_scripts` in place of `dist/read-ahead.js`.

**Step 8: Build and check**

Run: `npm run build && node --check extension/dist/read-ahead.js && npm test`
Expected: build writes `extension/dist/read-ahead.js` (about 20 KB) with no unresolved imports, syntax check passes, 79 tests pass.

**Step 9: Commit**

```bash
git add src/content scripts/build-separator.mjs extension/manifest.json
git commit -m "feat(extension): read-ahead content script with scheduler and pause-until-filtered"
```

---

### Task 11: Local MSE test page and headless Chrome test

**Files:**
- Create: `test-page/mse.html`
- Create: `test/e2e/read-ahead.e2e.mjs`
- Modify: `package.json` (`playwright` devDependency, `test:e2e` script)

**Step 1: `test-page/mse.html`**

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>music-filter MSE test</title>
<body style="margin:0;padding-top:140px;background:#111">
<video id="player" controls playsinline style="width:100%;max-width:640px"></video>
<script type="module">
  const file = new URLSearchParams(location.search).get('file') ?? 'fixtures/tone-60s.webm';
  const video = document.getElementById('player');
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener(
    'sourceopen',
    async () => {
      const sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs="opus"');
      const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer());
      let seed = 42;
      const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      let offset = 0;
      const appendNext = () => {
        if (offset >= bytes.length) return mediaSource.endOfStream();
        const size = 2000 + Math.floor(random() * 30000);
        sourceBuffer.appendBuffer(bytes.subarray(offset, offset + size));
        offset += size;
      };
      sourceBuffer.addEventListener('updateend', () => setTimeout(appendNext, 20));
      appendNext();
    },
    { once: true },
  );
</script>
</body>
```

**Step 2: Install Playwright**

```bash
npm install --save-dev --save-exact playwright@1.49.1
```

Do not run `npx playwright install` against the shared cache. It deletes other Playwright versions' browsers from `~/Library/Caches/ms-playwright`, which already broke another project once. Playwright 1.49.1 needs `chromium-1148`, which is already in that cache.

If `~/Library/Caches/ms-playwright/chromium-1148` is missing, run `PLAYWRIGHT_BROWSERS_PATH=.playwright npx playwright install chromium` and run the test with the same `PLAYWRIGHT_BROWSERS_PATH`. `.playwright/` is in `.gitignore`.

**Step 3: `test/e2e/read-ahead.e2e.mjs`**

```js
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const EXTENSION = resolve('extension');
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const useRealModel = process.argv.includes('--real-model');
const TIMEOUT_MS = useRealModel ? 60_000 : 20_000;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'test-page'], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mf-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    '--headless=new',
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const snapshot = (page) =>
  page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      panel: { ...document.querySelector('[data-state]')?.dataset },
      paused: video.paused,
      currentTime: video.currentTime,
    };
  });
const waitFor = async (page, label, isDone) => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    if (current.panel.state === 'error') throw new Error(`panel error: ${await page.textContent('[data-state]')}`);
    if (isDone(current)) return current;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label} never happened: ${JSON.stringify(await snapshot(page))}`);
};
const video = (page, action) => page.evaluate(action);

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/mse.html`);
  await page.evaluate((fake) => localStorage.setItem('mf_fake_separator', fake ? '1' : '0'), !useRealModel);
  await page.reload();
  await page.waitForSelector('[data-state]');
  await page.evaluate(() => {
    const root = document.querySelector('[data-state]');
    window.__seen = { states: [], originalLevelsWhileOn: new Set(), pauses: 0 };
    new MutationObserver(() => {
      __seen.states.push(root.dataset.state);
      if (root.dataset.state !== 'off') __seen.originalLevelsWhileOn.add(root.dataset.originalLevel);
    }).observe(root, { attributes: true });
    document.querySelector('video').addEventListener('pause', () => __seen.pauses++);
  });
  const seen = () => page.evaluate(() => ({ ...__seen, originalLevelsWhileOn: [...__seen.originalLevelsWhileOn] }));

  await page.getByRole('button', { name: /Music filter/ }).click();
  await video(page, () => document.querySelector('video').play().catch(() => {}));
  const filtered = await waitFor(page, 'filtered playback', (s) => s.panel.state === 'filtered' && !s.paused);
  console.log('filtered', filtered);

  const before = await seen();
  await video(page, () => (document.querySelector('video').currentTime = 40));
  const resumed = await waitFor(
    page,
    'resume after seek',
    (s) => s.currentTime >= 40 && s.panel.state === 'filtered' && !s.paused,
  );
  const afterSeek = await seen();
  const heldStates = afterSeek.states.slice(before.states.length);
  assert.ok(afterSeek.pauses > before.pauses || heldStates.includes('filtering'), 'the filter did not hold the video');
  console.log('held then resumed after seek', resumed, heldStates);

  await video(page, () => (document.querySelector('video').playbackRate = 1.5));
  const muted = await waitFor(page, 'muted at 1.5x', (s) => s.panel.state === 'muted' && !s.paused);
  console.log('muted at 1.5x', muted);
  await video(page, () => (document.querySelector('video').playbackRate = 1));
  await waitFor(page, 'filtered at 1x', (s) => s.panel.state === 'filtered' && !s.paused);

  await video(page, () => document.querySelector('video').pause());
  await page.waitForTimeout(1500);
  const userPaused = await snapshot(page);
  assert.equal(userPaused.paused, true, 'a user pause was resumed');
  assert.notEqual(userPaused.panel.state, 'filtering');

  await page.getByRole('button', { name: /Music filter/ }).click();
  const off = await snapshot(page);
  assert.equal(off.panel.state, 'off');
  assert.equal(off.panel.originalLevel, '1');
  assert.deepEqual((await seen()).originalLevelsWhileOn, ['0']);
  console.log('PASS');
} finally {
  await context.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
```

How the checks work:
- A hold after the seek lasts only as long as one 2 s window takes, a few hundred milliseconds with either model, so polling could miss it. A `MutationObserver` on the panel and a `pause` listener record it instead.
- `currentTime >= 40` in the resume check stops the `filtered` panel left over from before the seek from passing it.
- `originalLevelsWhileOn` collects `data-original-level` on every panel change while the state is not `off`. It must only ever hold `'0'`.
- `play()` is called with a `catch`, because the extension pauses the video before playback starts and that rejects the page's play promise with `AbortError`.

Add to `package.json` scripts: `"test:e2e": "npm run build && node test/e2e/read-ahead.e2e.mjs"`.

**Step 4: Run it with the fake separator**

Run: `npm run test:e2e`
Expected: logs `filtered {...}`, `held then resumed after seek {...} [ 'filtering', …, 'filtered' ]`, `muted at 1.5x {...}`, `PASS`. A failure prints the panel state. Fix the cause before moving on.

**Step 5: Run it with real DeepFilterNet3**

Run: `npm run build && node test/e2e/read-ahead.e2e.mjs --real-model`
Expected: `PASS`. Nothing is downloaded, the Worker loads the model from `extension/assets`. On a pure tone the filtered audio is near silent, which does not affect the checks. Note how long the first `filtered` and the hold after the seek took.

Measured on 2026-10-25 (M2 Pro, headless Chromium 131): fake separator, first `filtered` 0.56 s after the click and the hold after the seek 0.21 s, 3 of 3 runs passed. DeepFilterNet3, first `filtered` 0.98 s (model load from 0.52 s, then the 2 s window), 10 s windows in 0.5 s, hold after the seek 1.0 s.

The committed test also waits for the Python server before launching Chromium and checks that `currentTime` advances by more than 0.5 s in the second after the first `filtered`.

**Step 6: Commit**

```bash
git add test-page/mse.html test/e2e/read-ahead.e2e.mjs package.json package-lock.json
git commit -m "test(e2e): read-ahead hold, resume, speed and pause on a local MSE page"
```

---

### Task 12: Engine check with real DeepFilterNet3 in Node

**Files:**
- Create: `tools/listen/engine-check.mjs`

This writes what the scheduler would play, assembled offline with the same 1 s crossfades, so the stitching can be heard. It loads DeepFilterNet3 the way `bench/node-bench.mjs` does.

**Step 1: Write `tools/listen/engine-check.mjs`**

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { StreamEngine } from '../../src/pipeline/stream-engine.js';
import { createVoiceFilter } from '../../src/pipeline/voice-filter.js';

const asset = (name) => readFileSync(new URL(`../../extension/assets/${name}`, import.meta.url));
initSync(asset('df_bg.wasm'));
const handle = df_create(new Uint8Array(asset('DeepFilterNet3_onnx.tar.gz')), 100);
const voiceFilter = createVoiceFilter({
  processFrame: (frame) => df_process_frame(handle, frame),
  frameLength: df_get_frame_length(handle),
});

const [input = '../../test-page/fixtures/tone-60s.webm', output = 'engine-check.wav'] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(input));
const windows = [];
const engine = new StreamEngine({
  separate: async (left, right) => voiceFilter(left, right),
  onWindow: (w) => windows.push(w),
  onStatus: (s) => s.stage === 'window' && console.log(JSON.stringify(s)),
  config: { lookaheadSeconds: 3600, urgencySeconds: 3600 },
});
engine.pushChunk(bytes);
engine.setPlayhead(0, true);
await engine.ready;
while (engine.inFlight || !engine.isIdle()) await new Promise((r) => setTimeout(r, 100));

const rate = 48000;
const overlap = engine.config.overlapSeconds * rate;
const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / Math.max(1, samples.length));
const total = Math.ceil(Math.max(...windows.map((w) => w.startSeconds * rate + w.left.length)));
const out = [new Float32Array(total), new Float32Array(total)];
windows.forEach((w, index) => {
  const start = Math.round(w.startSeconds * rate);
  const next = windows[index + 1];
  const nextStart = next ? Math.round(next.startSeconds * rate) : Infinity;
  if (next) {
    const mine = w.left.subarray(nextStart - start);
    const theirs = next.left.subarray(0, mine.length);
    const difference = mine.map((s, i) => s - theirs[i]);
    const level = Math.max(rms(mine), 1e-9);
    console.log(`boundary ${(nextStart / rate).toFixed(2)} s: overlap mismatch ${(20 * Math.log10(rms(difference) / level)).toFixed(1)} dB`);
  }
  for (let i = 0; i < w.left.length; i++) {
    const t = start + i;
    let gain = 1;
    if (index > 0 && i < overlap) gain = i / overlap;
    if (t >= nextStart) gain *= 1 - (t - nextStart) / overlap;
    out[0][t] += w.left[i] * gain;
    out[1][t] += w.right[i] * gain;
  }
});

const data = Buffer.alloc(44 + total * 4);
data.write('RIFF', 0);
data.writeUInt32LE(36 + total * 4, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22);
data.writeUInt32LE(rate, 24);
data.writeUInt32LE(rate * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[0][i])) * 32767), 44 + i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[1][i])) * 32767), 46 + i * 4);
}
writeFileSync(output, data);
console.log(`${windows.length} windows → ${output}`);
```

`await engine.ready` has to come after `pushChunk`. Until the init segment is parsed, `ready` is an already-resolved promise, and the loop would exit with no windows. The playhead stays at 0, so `urgencySeconds: 3600` lets the planner take the short last window instead of leaving the final seconds out. The loop only ends because of the planner's `decodedEnd <= processedEnd` guard from Task 5.

Every import is relative or resolves from the repo root (`opus-decoder`), so `tools/listen/node_modules` is not needed. `vendor/df/df.js` and the assets must exist (`npm run build:wasm`).

`overlap mismatch` compares each window's last second with the next window's first second, the part the crossfade blends. It is the difference between the two in dB relative to the signal, so lower is better. On near-silent output it measures noise and can be ignored.

**Step 2: Run it**

Run: `cd tools/listen && node engine-check.mjs ../../test-page/fixtures/tone-60s.webm engine-check.wav`
Expected: one JSON line per window (2 s first, then 10 s windows starting 9 s apart, then a short last one), each with `computeMs` far under `durationSeconds * 1000`, one `boundary` line per window after the first, then `N windows → engine-check.wav`. DeepFilterNet3 treats a steady tone as noise, so the WAV is near silent.

Measured on 2026-10-25 (M2 Pro) on 30 s WebM Opus files made with ffmpeg:
- 440 Hz tone plus pink noise: 5 windows (2, 10, 10, 10 and 2.01 s), 10 s windows in 0.5 to 1.1 s. Output RMS 28 dB below the input.
- The same with speech from `say` mixed in: overlap mismatch -16 to -26 dB. The output lines up with the input at lag 0 (cross-correlation). No sample step within 10 ms of a window edge is larger than the file's 99.9th percentile step, so the crossfades do not click.

Run it on any WebM Opus speech-plus-music file to hear the stitching.

The committed script also prints both sides' RMS on each `boundary` line, so a mismatch caused by one side being silent is visible. Results from the committed script on 2026-10-25 (M2 Pro):
- `tone-60s.webm`: 8 windows (2 s, six of 10 s, 5 s), 10 s windows in 0.49 s. Every boundary reads 0.0 dB because the next window's first second is exactly zero (DeepFilterNet3 zero-masks the tone) against -72 dBFS on the earlier side. Inaudible either way.
- 30 s `say` speech over a 220/277/330 Hz chord and pink noise, libopus 128k: 5 windows (2, 10, 10, 10, 2 s), 10 s windows in 1.06 to 1.09 s. Overlap mismatch -16.3, -1.4, -28.0 and -27.2 dB. No sample step within 10 ms of a window edge is above the file's 99.9th percentile step.
- The -1.4 dB boundary at 10 s comes from a speech onset at 10.8 s after a 0.5 s zero-masked pause. The earlier window matches a continuous whole-file pass there, the next window is 7 dB louder. A longer warm-up on the window's own start (up to 2 s) does not change it. Warming up on the 1 to 3 s of audio before the window improves it to -9 dB. Every window differs from a continuous pass by -7 to -15 dB anyway, so DeepFilterNet3's output depends on its recurrent and normalization state for longer than the warm-up.
- Warming up on preceding audio is now implemented. The engine reads up to `warmUpBeforeSeconds` (2 s) of decoded audio before each window, bridging small holes with silence the same way windows do, and passes it to `separate` as `contextBefore`. The voice filter runs that context through DeepFilterNet3 first and drops its output, so the model state has settled on the audio just before the window. The 0.25 s warm-up on the window's own start remains for windows with nothing decoded before them, such as the first window of a stream. Re-measured on 2026-10-25 (M2 Pro) on the same speech file: overlap mismatch -15.3, -9.1, -37.4 and -34.3 dB (was -16.3, -1.4, -28.0 and -27.2). The first boundary barely moves because its earlier side is the cold first window and the next window only has 1 s of context. 10 s windows take 1.19 to 1.28 s (was 1.06 to 1.09 s) and the last 2 s window 0.43 s (was 0.26 s). On `tone-60s.webm` the boundaries still read 0.0 dB for the zero-masking reason above, and 10 s windows take 0.53 to 0.58 s (was 0.49 s).

**Step 3: Commit**

```bash
git add tools/listen/engine-check.mjs
git commit -m "tools: run the stream engine with real DeepFilterNet3 and write the stitched result"
```

---

### Task 13: Real YouTube in headless Chrome

**Step 1:** Adapt the harness in `test/e2e/read-ahead.e2e.mjs` into a scratchpad script that opens `https://www.youtube.com/watch?v=aqz-KE-bpKQ`.
- Do not sign in or accept anything.
- If a consent wall appears, choose "Reject all" if offered, otherwise stop.
- Turn the filter on, play, and wait for `filtered`. Expect `filtering` first, with YouTube showing the video paused, then playback resuming on its own.
- Seek forward once and check that the video pauses with `filtering`, then resumes on its own.

**Step 2:** Record:
- time to first `filtered`
- how long the hold after the seek lasted
- window compute times from the panel detail
- `aheadSeconds` over 30 s
- whether YouTube's own controls stayed in step with the extension's pause and play

Headless YouTube stops itself after about 35 s (see `docs/spikes/2026-10-19-worklet-csp-results.md`), so 30 s is the target.

**Step 3:** No commit unless a bug fix is needed. Put findings in Task 16's doc.

**Backward-seek bug (found and fixed during this task):** A seek back past the worker's 10 s keep-behind, or to before the point where filtering began, left the planner with no decoded audio near the playhead. YouTube never re-appends bytes it still holds, and the content script sent its retained bytes only once on activation. The hold ran to its 30 s timeout and the video then played silent with an error. On the TED video, paused at 6.0 s and rewound from 20.3 s to 5.3 s, that is what happened. Big Buck Bunny rewound from 18.9 s to 0.5 s never resumed either.

The fix has four parts. The engine reports a `starved` status once per playhead position when it has decoded audio but none at the playhead, or when planning reaches frames it dropped ahead of the playhead. The content script then replays the stream, sending `stream-reset` with the current playhead followed by the retained init and chunks, at most once per 5 s, and keeps the scheduler's windows. The engine still decodes every frame but only writes those within 30 s behind and 90 s ahead of the playhead, so a replay of many megabytes stays bounded. The keep-behind is now 30 s to match the scheduler. The hold resumes at 1.5 s ahead instead of 2 s, so the first 2 s window is enough.

Re-test in headless Chrome after the fix. TED paused at 6.8 s and rewound from 21.0 s to 6.0 s resumed filtered after 0.34 s. TED rewound from 29.7 s to 14.7 s resumed after 0.57 s. TED rewound from 34.2 s to 2 s, which crosses the new 30 s keep-behind, replayed the stream and resumed after 0.53 s. Big Buck Bunny rewound from 27.9 s to 0.5 s resumed after 0.24 s. The first `filtered` came 1.1 to 1.3 s after turning the filter on, and the original level stayed at 0 in every run. The local e2e test now rewinds from 45 s to 5 s and resumes in about 0.2 s.

---

### Task 14: Safari on the iPhone simulator

**Step 1: Build and install**

```bash
npm run build
bash scripts/build-safari.sh
cd "build/safari/Music Filter"
xcodebuild -scheme "Music Filter (iOS)" -configuration Debug -sdk iphonesimulator \
  -destination "id=DFF4CFE3-DCA5-4F93-A640-8F548ED741E3" -derivedDataPath ../DerivedData \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO build
xcrun simctl install DFF4CFE3-DCA5-4F93-A640-8F548ED741E3 "../DerivedData/Build/Products/Debug-iphonesimulator/Music Filter.app"
```

**Step 2: Check, on m.youtube.com/watch?v=aqz-KE-bpKQ**

- Panel appears. If not: Safari page menu, then Manage Extensions. Enable it with a drag on the toggle, because taps do not register in the simulator. Then allow the site.
- Turn the filter on, then play.
- `Filtering…` shows while the video is held, then `filtered` appears within a few seconds and playback resumes on its own. The video element is muted (mute mode) and the processed audio is audible on the Mac speakers.
- Seek: the video pauses with `Filtering…`, then resumes on its own. The original audio is never heard.
- Change the speed to 1.5x: the panel says "Filter works at Normal speed" and everything is silent.
- A pause you make stays paused. Toggling off restores the original audio and unmutes the video.

**Step 3: Record** what happens. Known risks:
- **The tap misses YouTube's first MediaSource** (seen once in three loads in the spike). The panel stays `waiting` and the video plays silently, and a reload fixes it.
- **The separator iframe or its Worker fails** on Safari. It has not been tested there yet, and it shows as `error` in the panel.

---

### Task 15: Firefox for Android on the emulator

**Step 1: Run**

```bash
npm run build && bash scripts/build-firefox.sh
~/Library/Android/sdk/emulator/emulator -avd Medium_Phone_API_37.0 -no-snapshot-save -no-boot-anim &
# wait for boot, then in a scratch dir with web-ext 10.7.0 installed:
npx web-ext run -t firefox-android --adb-bin "$HOME/Library/Android/sdk/platform-tools/adb" \
  --adb-device emulator-5554 --firefox-apk org.mozilla.firefox \
  --source-dir "$PWD/build/firefox" --no-input --no-reload
```

Firefox 158 is already installed on that emulator, with remote debugging on. If the emulator was wiped, follow `docs/spikes/2026-10-25-mobile-results.md`.

**Step 2: Check** the same list as Task 14, in graph mode: the video stays unmuted and its gain goes to 0. Also record window compute times and hold times, since the emulator is CPU-only.

**Step 3: Stop** web-ext and the emulator: `pkill -f "web-ext run"` and `adb -s emulator-5554 emu kill`.

---

### Task 16: Results

**Files:**
- Create: `docs/spikes/2026-10-25-read-ahead-results.md`

Record, per platform (Chrome desktop, Safari iPhone simulator, Firefox Android emulator):
- time to first filtered audio, including the first hold
- hold time after a seek
- window compute times and RTF
- seconds ready ahead during playback
- any `error` states, and whether a held video ever stayed paused
- what still needs a real device

Then a listening checklist for a person on Chrome desktop:
- 3 clips (vlog with background music, documentary, cartoon)
- speech kept (1 to 5), music left (1 to 5), sung vocals left (yes/no)
- crossfade clicks at window boundaries (yes/no)
- lip-sync OK (yes/no)

Commit:

```bash
git add docs/spikes/2026-10-25-read-ahead-results.md
git commit -m "docs: read-ahead pipeline results across browsers"
```

---

## Out of scope

- Keeping effects (everything but music) with MRX, TIGER, DBS-TIGER or WebGPU models. That is the next step after this plan (v2 in the design doc). The clip-test spike keeps its MRX/TIGER code for it.
- Removing sung vocals, which needs the v1.1 DeepFilterNet3 fine-tune.
- Filtering at speeds other than 1x.
- AAC/MP4 audio, which needs an MP4 demuxer and an AAC decoder.
- Popup UI, per-site settings and store packaging.
- The share-sheet action on iOS.
- Background playback.
