# Read-Ahead Keep-Effects Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove music but keep speech and effects on YouTube in Chrome, Safari (iPhone/iPad/Mac) and Firefox (desktop/Android). The extension separates audio that the player has already downloaded, ahead of the playhead, and plays the result in sync with the video.

**Architecture:**
- A MAIN-world script (`mse-tap.js`) copies the bytes YouTube appends to its audio `SourceBuffer` and streams them to the content script over a `MessagePort`.
- The content script forwards the active stream to a separator Worker inside a hidden extension iframe. The Worker demuxes WebM, decodes Opus, keeps a PCM timeline, plans windows ahead of the playhead, runs MRX (`@audio/neural-separate`, mix minus music) and returns processed windows.
- The content script schedules those windows with Web Audio against `video.currentTime`, crossfading overlapping windows. It plays the original audio whenever processed audio does not cover the playhead.

**Tech Stack:** plain JavaScript ES modules, esbuild, `node:test`, `opus-decoder` 0.7.12 (libopus WASM, MIT), `@audio/neural-separate` 0.7.0 + `onnxruntime-web` 1.30.0 (already installed), Playwright 1.49.1 for the browser test, Xcode `safari-web-extension-converter`, `web-ext` 10.7.0.

**Read first:**
- `docs/research/2026-10-25-keep-effects.md`: why read-ahead and why MRX.
- `docs/spikes/2026-10-25-mobile-results.md`: Safari returns silence to `createMediaElementSource` for YouTube, and the MSE tap and decode work on iPhone and Firefox for Android.
- `src/separator/worker.js` and `src/separator/frame.js`: the existing separator Worker and iframe this plan extends.

---

## Decisions this plan bakes in

| Decision | Value | Why |
|---|---|---|
| Codec support | Opus in WebM only. Anything else falls back to original audio. | That is what YouTube served on Chrome, Safari iPhone and Firefox Android in the spikes. AAC/MP4 is a later task. |
| Opus decoding | `opus-decoder` WASM in the Worker, on every browser | Firefox for Android has no WebCodecs. One path everywhere keeps the code and tests the same. |
| Model | MRX, `device: 'wasm'` | Only open DnR model measured faster than real time in a browser (RTF 0.76 single-threaded on an M2 Pro). TIGER is too slow. |
| Windows | First window 4 s, then 10 s, 1 s overlap, minimum 2 s | Short first window means filtered audio starts sooner. 10 s keeps memory low enough for phones (MRX costs 0.47 dB of dialogue at 10 s vs 20 s). |
| Lookahead | Up to 30 s ahead of the playhead | YouTube buffered about 50 s ahead in the spikes. |
| Original audio control | Chrome and Firefox: `createMediaElementSource` into a GainNode. Safari: `video.muted`. | Safari's element tap is silent for YouTube, so the graph route would lose the original audio. |
| Never silent | Original audio plays whenever processed audio does not cover `[now, now + 0.25 s]`, or the video is paused, seeking, at a speed other than 1x, or showing an ad | Design rule since the first spike |
| Spike scripts | `content.js` (DeepFilterNet panel) and `clip-test.js` are removed from the manifest. The files stay. | Both call `createMediaElementSource`, which can only happen once per element. |

Constants live in `src/pipeline/stream-engine.js` (`DEFAULT_CONFIG`) and `src/content/playback-scheduler.js`.

## File map

| File | Status | Role |
|---|---|---|
| `src/pipeline/ebml.js` | new | EBML vint and value readers |
| `src/pipeline/webm-demuxer.js` | new | Streaming WebM demuxer, tolerant of arbitrary chunk boundaries, re-init and abort |
| `src/pipeline/opus-head.js` | new | Parse the OpusHead codec private data |
| `src/pipeline/frame-decoder.js` | new | Opus frames to timestamped PCM, with continuity and pre-roll handling |
| `src/pipeline/ranges.js` | new | Merged half-open interval helpers |
| `src/pipeline/pcm-timeline.js` | new | Paged PCM store keyed by sample position |
| `src/pipeline/window-planner.js` | new | Chooses the next window to separate |
| `src/pipeline/stream-engine.js` | new | Ties demux, decode, timeline, planner and separation together (Worker side) |
| `src/pipeline/playback-math.js` | new | Pure scheduling math for the content script |
| `src/separator/worker.js` | modify | Adds `stream-*` and `playhead` messages |
| `src/separator/frame.js` | modify | Transfers `bytes` buffers too |
| `extension/mse-tap.js` | rewrite | MessagePort tap with buffering until the content script connects |
| `src/content/separator-client.js` | new | Hidden iframe + MessageChannel connection |
| `src/content/original-audio.js` | new | Original audio control, graph and mute modes |
| `src/content/playback-scheduler.js` | new | Web Audio scheduling, crossfades, drift, coverage |
| `src/content/panel.js` | new | On/off button and status line |
| `src/content/read-ahead.js` | new | Content script orchestrator |
| `scripts/build-separator.mjs` | modify | Also bundles `dist/read-ahead.js` |
| `scripts/make-fixtures.sh` | new | Generates WebM Opus fixtures with ffmpeg |
| `extension/manifest.json` | modify | New content scripts, spike scripts removed |
| `test-page/mse.html` | new | Local page that plays a WebM file through MediaSource in random chunks |
| `test/e2e/read-ahead.e2e.mjs` | new | Headless Chrome test with the extension |
| `tools/listen/engine-check.mjs` | new | Runs the engine with real MRX in Node, writes a WAV |

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
```

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

  const isUrgent = (continuing ? processedEnd : start) - playhead <= urgency;
  if (!isUrgent || decodedEnd - start < minWindow) return null;
  return { start, end: decodedEnd };
}
```

The processed run is looked up with the same `maxStartGap` tolerance as the decoded run. Decoded audio starts at the 312-sample pre-skip, so the first processed window starts there too. With a plain `contiguousEnd(processed, 0)` the planner would see nothing processed and plan the first window again, forever.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 54 tests

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

The engine runs in the Worker. `separate(left, right, sampleRate)` is injected, so tests use a fake.

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
  assert.ok(Math.abs(windows[0].left.length / 48000 - 4) < 0.001);
  assert.ok(Math.abs(windows[1].startSeconds - (windows[0].startSeconds + 3)) < 0.001);
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
  firstWindowSeconds: 4,
  windowSeconds: 10,
  overlapSeconds: 1,
  minWindowSeconds: 2,
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
Expected: PASS, 61 tests

**Step 5: Commit**

```bash
git add src/pipeline/stream-engine.js test/stream-engine.test.js
git commit -m "feat(pipeline): stream engine from WebM bytes to separated windows"
```

---

### Task 7: Separator Worker stream messages

**Files:**
- Modify: `src/separator/worker.js` (add the stream handling next to `handle`, wire it into `self.onmessage`)
- Modify: `src/separator/frame.js:3` (`transferablesOf`)

**Step 1: Update `src/separator/frame.js`**

Replace the `transferablesOf` line with:

```js
const transferablesOf = (data) => [
  ...new Set([data?.left?.buffer, data?.right?.buffer, data?.bytes instanceof ArrayBuffer ? data.bytes : null].filter(Boolean)),
];
```

**Step 2: Add stream handling to `src/separator/worker.js`**

Add the import at the top:

```js
import { StreamEngine } from '../pipeline/stream-engine.js';
```

Add below `runSeparation`:

```js
const STREAM_MESSAGES = new Set(['stream-reset', 'stream-chunk', 'stream-abort', 'playhead']);
let stream = null;
let separationQueue = Promise.resolve();

function queueSeparation(task) {
  const result = separationQueue.then(task);
  separationQueue = result.catch(() => {});
  return result;
}

function createWindowSeparator(model, device, streamId) {
  if (model === 'fake') return async (left, right) => [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
  return (left, right, sampleRate) =>
    queueSeparation(async () => {
      const ready = await prepare(model, device, (status) => post({ type: 'stream-status', streamId, ...status }));
      const { residual } = await separate([left, right], {
        model,
        sampleRate,
        targets: ['music'],
        session: async () => ready.session,
      });
      return residual;
    });
}

function handleStream(data) {
  if (data.type === 'stream-reset') {
    const { streamId, model, device } = data;
    stream?.engine.reset();
    stream = {
      id: streamId,
      engine: new StreamEngine({
        separate: createWindowSeparator(model, device, streamId),
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

`stream-reset` resets the old engine before replacing it. That frees its Opus decoder and bumps its generation, so a window it still has in flight is dropped instead of being posted and then planning more windows for a stream nobody plays. An MRX call cannot be cancelled, so `queueSeparation` runs one at a time. The new stream's first window waits for the old call instead of running two separations on the same ONNX session at once.

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

**Step 3: Build and check the bundle**

Run: `npm run build:separator`
Expected: `extension/dist/separator-worker.js` builds with opus-decoder inside, and there are no unresolved imports.

Run: `npm test`
Expected: PASS, 61 tests

**Step 4: Commit**

```bash
git add src/separator/worker.js src/separator/frame.js
git commit -m "feat(separator): stream engine messages in the separator worker"
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

### Task 9: Playback math

**Files:**
- Create: `src/pipeline/playback-math.js`
- Test: `test/playback-math.test.js`

**Step 1: Write the failing test**

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

**Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '…/src/pipeline/playback-math.js'`

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

**Step 4: Run tests**

Run: `npm test`
Expected: PASS, 66 tests

**Step 5: Commit**

```bash
git add src/pipeline/playback-math.js test/playback-math.test.js
git commit -m "feat(pipeline): playback scheduling math"
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
    userVolume: () => (isUserMuted ? 0 : video.volume),
    dispose() {
      this.setLevel(1);
      video.removeEventListener('volumechange', onVolumeChange);
    },
  };
}
```

In mute mode, YouTube's mute icon shows "muted" while processed audio plays. If the user clicks unmute there, filtering continues and the element is muted again. That is a known v1 wart on Safari.

**Step 3: `src/content/playback-scheduler.js`**

```js
import { addRange, contiguousEnd, covers } from '../pipeline/ranges.js';
import { crossfadeSpan, measureDrift, scheduleSpan } from '../pipeline/playback-math.js';

const HORIZON_SECONDS = 2;
const KEEP_BEHIND_SECONDS = 30;
const KEEP_AHEAD_SECONDS = 90;
const DRIFT_LIMIT_SECONDS = 0.08;
const COVER_MARGIN_SECONDS = 0.25;

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
      return false;
    }
    if (this.anchor && Math.abs(measureDrift({ ...this.anchor, ctxNow, mediaNow })) > DRIFT_LIMIT_SECONDS) this.stopAll();
    for (const window of this.windows) {
      if (this.playing.has(window) || window.end <= mediaNow || window.start > mediaNow + HORIZON_SECONDS) continue;
      this.start(window, mediaNow, ctxNow);
    }
    return this.playing.size > 0 && covers(this.ranges, mediaNow, mediaNow + COVER_MARGIN_SECONDS);
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
    const now = this.video.currentTime;
    return Math.max(0, contiguousEnd(this.ranges, now) - now);
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
    status.textContent = view.isOn
      ? `${view.state}${view.detail ? ` · ${view.detail}` : ''} · ${view.aheadSeconds.toFixed(0)} s ready`
      : '';
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
import { createOriginalAudio } from './original-audio.js';
import { createPanel } from './panel.js';
import { PlaybackScheduler } from './playback-scheduler.js';
import { connectSeparator } from './separator-client.js';

const TAP_CONNECT = 'music-filter:tap-connect';
const TICK_MS = 250;
const RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 4;
const OUTPUT_SAMPLE_RATE = 48000;

const isSafari = navigator.vendor === 'Apple Computer, Inc.';
const isLocalTest = location.hostname === 'localhost' && localStorage.getItem('mf_fake_separator') === '1';
const MODEL = isLocalTest ? { model: 'fake', device: 'wasm' } : { model: 'mrx', device: 'wasm' };

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
  if (message.stage === 'download') detail = `downloading model ${(message.loaded / 1e6).toFixed(0)} MB`;
  if (message.stage === 'session') detail = 'starting model';
  if (message.stage === 'window') detail = `window ${message.durationSeconds.toFixed(0)} s in ${(message.computeMs / 1000).toFixed(1)} s`;
}

function fail(message) {
  failure = message;
  original?.setLevel(1);
  scheduler?.stopAll();
  panel.update({ state: 'error', detail: message, originalLevel: 1 });
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
  send({ type: 'stream-reset', streamId: stream.streamId, mime: stream.mime, ...MODEL });
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
  video.addEventListener('seeking', () => {
    scheduler?.stopAll();
    original?.setLevel(1);
  });
  video.addEventListener('play', () => context.resume());
}

async function setEnabled(on) {
  isEnabled = on;
  if (!on) {
    scheduler?.stopAll();
    original?.setLevel(1);
    panel.update({ state: 'off', detail: '', originalLevel: 1 });
    return;
  }
  const video = pickVideo();
  if (!video) throw new Error('no video on this page');
  if (video !== attachedVideo) attach(video);
  await context.resume();
  if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
  ensureSeparator().catch(() => {});
  panel.update({ state: 'waiting', detail: '' });
}

function tick() {
  if (!isEnabled) return;
  const video = pickVideo();
  if (!video) return;
  if (video !== attachedVideo) attach(video);
  const stream = selectStream(video);
  if (stream && stream.streamId !== activeStreamId) activate(stream);

  const isPlaying = !video.paused && !video.seeking && video.readyState >= 3;
  if (activeStreamId !== null) send({ type: 'playhead', streamId: activeStreamId, seconds: video.currentTime, isPlaying });

  const isAdShowing = Boolean(document.querySelector('#movie_player.ad-showing'));
  const allowProcessed =
    !failure && isPlaying && !isAdShowing && video.playbackRate === 1 && context.state === 'running';
  const isCovered = scheduler.tick({ allowProcessed });
  original.setLevel(isCovered ? 0 : 1);
  scheduler.setVolume(original.userVolume());

  if (failure) return;
  panel.update({
    state: isCovered ? 'filtered' : stream ? 'original' : 'waiting',
    detail,
    originalLevel: isCovered ? 0 : 1,
    aheadSeconds: scheduler.secondsAhead(),
    windows: scheduler.windows.length,
  });
}
```

Behaviour to know:
- `type: 'error'` messages come from `frame.js` (the Worker failed to start or crashed) and carry no `streamId`. They are handled before the stream filter, or a dead Worker would leave the panel on `original` with no reason shown.
- Processed audio needs `context.state === 'running'`. Safari moves the context to `interrupted` on calls and some backgrounding, and a stalled context with the original muted would be silent.
- Each YouTube video gets a new MediaSource. Old streams are dropped past `MAX_STREAMS`, so their retained bytes (up to 16 MB each) do not pile up over a long session.

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

Leave `web_accessible_resources` as it is. It already lists `separator.html`, `dist/separator-frame.js`, `dist/separator-worker.js` and `dist/ort/*`. `content.js` and `clip-test.js` stay in the repo. To use their Diagnose button, temporarily put them back in `content_scripts` in place of `dist/read-ahead.js`.

**Step 8: Build and check**

Run: `npm run build && node --check extension/dist/read-ahead.js && npm test`
Expected: build writes `extension/dist/read-ahead.js`, syntax check passes, 66 tests pass.

**Step 9: Commit**

```bash
git add src/content scripts/build-separator.mjs extension/manifest.json
git commit -m "feat(extension): read-ahead content script with scheduler and original-audio fallback"
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

Then run `npx playwright install chromium`. It is a no-op when this Playwright version's Chromium is already cached. The `chromium-1248` folder already in `~/Library/Caches/ms-playwright` belongs to Playwright 1.64, not 1.49.1, so it does not count.

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

const panelState = (page) => page.evaluate(() => ({ ...document.querySelector('[data-state]')?.dataset }));
const waitForState = async (page, state, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await panelState(page);
    if (current.state === state) return current;
    if (current.state === 'error') throw new Error(`panel error: ${await page.textContent('[data-state]')}`);
    await page.waitForTimeout(250);
  }
  throw new Error(`state never became ${state}: ${JSON.stringify(await panelState(page))}`);
};

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/mse.html`);
  await page.evaluate((fake) => localStorage.setItem('mf_fake_separator', fake ? '1' : '0'), !useRealModel);
  await page.reload();
  await page.waitForSelector('[data-state]');

  await page.getByRole('button', { name: /Music filter/ }).click();
  await page.evaluate(() => document.querySelector('video').play());
  const filtered = await waitForState(page, 'filtered', useRealModel ? 90_000 : 20_000);
  assert.equal(filtered.originalLevel, '0');
  console.log('filtered', filtered);

  await page.evaluate(() => (document.querySelector('video').currentTime = 40));
  await page.waitForTimeout(600);
  const afterSeek = await waitForState(page, 'filtered', useRealModel ? 60_000 : 15_000);
  console.log('filtered after seek', afterSeek);

  await page.evaluate(() => document.querySelector('video').pause());
  await page.waitForTimeout(600);
  assert.equal((await panelState(page)).originalLevel, '1');

  await page.getByRole('button', { name: /Music filter/ }).click();
  assert.equal((await panelState(page)).state, 'off');
  console.log('PASS');
} finally {
  await context.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
```

The 600 ms wait after the seek lets two ticks pass. Without it, `waitForState` can read the `filtered` panel left over from before the seek and pass without checking anything at 40 s.

Add to `package.json` scripts: `"test:e2e": "npm run build && node test/e2e/read-ahead.e2e.mjs"`.

**Step 4: Run it with the fake separator**

Run: `npm run test:e2e`
Expected: logs `filtered {...}`, `filtered after seek {...}`, `PASS`. A failure prints the panel state. Fix the cause before moving on.

**Step 5: Run it with real MRX**

Run: `npm run build && node test/e2e/read-ahead.e2e.mjs --real-model`
Expected: `PASS`. The first run downloads the 31 MB model. Note how long the first `filtered` took.

**Step 6: Commit**

```bash
git add test-page/mse.html test/e2e/read-ahead.e2e.mjs package.json package-lock.json
git commit -m "test(e2e): read-ahead takeover, seek and pause on a local MSE page"
```

---

### Task 12: Engine check with real MRX in Node

**Files:**
- Create: `tools/listen/engine-check.mjs`

This writes what the scheduler would play, assembled offline with the same 1 s crossfades, so the stitching can be heard.

**Step 1: Write `tools/listen/engine-check.mjs`**

```js
import { readFileSync, writeFileSync } from 'node:fs';
import separate from '@audio/neural-separate';
import { StreamEngine } from '../../src/pipeline/stream-engine.js';

const [input = '../../test-page/fixtures/tone-60s.webm', output = 'engine-check.wav'] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(input));
const windows = [];
const engine = new StreamEngine({
  separate: async (left, right, sampleRate) =>
    (await separate([left, right], { model: 'mrx', sampleRate, targets: ['music'] })).residual,
  onWindow: (w) => windows.push(w),
  onStatus: (s) => s.stage === 'window' && console.log(JSON.stringify(s)),
  config: { lookaheadSeconds: 3600, urgencySeconds: 3600 },
});
engine.pushChunk(bytes);
engine.setPlayhead(0, true);
await engine.ready;
while (engine.inFlight || !engine.isIdle()) await new Promise((r) => setTimeout(r, 100));

const rate = 48000;
const total = Math.ceil(Math.max(...windows.map((w) => w.startSeconds * rate + w.left.length)));
const out = [new Float32Array(total), new Float32Array(total)];
const overlap = rate;
windows.forEach((w, index) => {
  const start = Math.round(w.startSeconds * rate);
  const next = windows[index + 1];
  const nextStart = next ? Math.round(next.startSeconds * rate) : Infinity;
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

`await engine.ready` has to come after `pushChunk`. Until the init segment is parsed, `ready` is an already-resolved promise, and the loop would exit with no windows. The playhead stays at 0, so `urgencySeconds: 3600` lets the planner take the short last window instead of leaving the final seconds out. `@audio/neural-separate` resolves from `tools/listen/node_modules`, which already has it with `onnxruntime-node`. The engine's `opus-decoder` resolves from the repo root.

**Step 2: Run it**

Run: `cd tools/listen && node engine-check.mjs ../../test-page/fixtures/tone-60s.webm engine-check.wav`
Expected: one JSON line per window, each with `computeMs` under `durationSeconds * 1000`, then `N windows → engine-check.wav`. On a pure tone, MRX should remove most of it, so the WAV is quiet. Run it on any WebM Opus speech-plus-music file to hear stitching.

**Step 3: Commit**

```bash
git add tools/listen/engine-check.mjs
git commit -m "tools: run the stream engine with real MRX and write the stitched result"
```

---

### Task 13: Real YouTube in headless Chrome

**Step 1:** Adapt the harness in `test/e2e/read-ahead.e2e.mjs` into a scratchpad script that opens `https://www.youtube.com/watch?v=aqz-KE-bpKQ`.
- Do not sign in or accept anything.
- If a consent wall appears, choose "Reject all" if offered, otherwise stop.
- Turn the filter on, play, and wait for `filtered`.

**Step 2:** Record:
- time to first `filtered`
- window compute times from the panel detail
- `aheadSeconds` over 30 s
- whether the video kept playing

Headless YouTube stops itself after about 35 s (see `docs/spikes/2026-10-19-worklet-csp-results.md`), so 30 s is the target.

**Step 3:** No commit unless a bug fix is needed. Put findings in Task 16's doc.

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
- `filtered` appears within about 20 s. The video element is muted (mute mode) and the processed audio is audible on the Mac speakers.
- Seek: the original audio comes back at once, then `filtered` returns.
- Pause and resume work. Toggling off restores the original audio and unmutes the video.

**Step 3: Record** what happens. Known risks:
- **The tap misses YouTube's first MediaSource** (seen once in three loads in the spike). The panel stays `waiting`, and a reload fixes it.
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

**Step 2: Check** the same list as Task 14, in graph mode: the video stays unmuted and its gain goes to 0. Also record window compute times, since the emulator is CPU-only.

**Step 3: Stop** web-ext and the emulator: `pkill -f "web-ext run"` and `adb -s emulator-5554 emu kill`.

---

### Task 16: Results

**Files:**
- Create: `docs/spikes/2026-10-25-read-ahead-results.md`

Record, per platform (Chrome desktop, Safari iPhone simulator, Firefox Android emulator):
- time to first filtered audio
- window compute times and RTF
- seconds ready ahead during playback
- seek recovery time
- any `error` or `unsupported` states
- what still needs a real device

Then a listening checklist for a person on Chrome desktop:
- 3 clips (documentary, gaming, cartoon)
- speech and effects kept (1 to 5), music left (1 to 5)
- crossfade clicks at window boundaries (yes/no)
- lip-sync OK (yes/no)

Commit:

```bash
git add docs/spikes/2026-10-25-read-ahead-results.md
git commit -m "docs: read-ahead pipeline results across browsers"
```

---

## Out of scope

- AAC/MP4 audio, which needs an MP4 demuxer and an AAC decoder.
- TIGER, DBS-TIGER and WebGPU models.
- Popup UI, per-site settings and store packaging.
- The share-sheet action on iOS.
- Background playback.
