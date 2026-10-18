# Spike: DeepFilterNet3 AudioWorklet on YouTube Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove or disprove two things before building v1. First, that a Chrome extension can load an AudioWorklet running DeepFilterNet3 WASM on a YouTube watch page despite YouTube's CSP. Second, that it processes audio in real time without glitches.

**Architecture:** A throwaway MV3 extension. A content script tries 4 loading strategies (worklet loaded from an extension URL or a Blob URL, WASM compiled in the content script or inside the worklet) and reports which pass. The first passing strategy is then attached to the page's `<video>`, and per-frame timing is streamed to an on-page overlay. A Node benchmark gives a baseline WASM speed outside the browser.

**Tech Stack:** Rust + wasm-pack (upstream `libDF` with `--features wasm`), plain JavaScript ES modules, esbuild (bundles the worklet into one file), `node:test`, Chrome stable.

**Design doc:** `docs/plans/2026-10-19-music-filter-design.md`

**Prior art:** `deepfilternet3-noise-filter` on npm (Apache-2.0 OR MIT, repo `mezonai/mezon-noise-suppression`) runs DeepFilterNet3 in an AudioWorklet. Things learned from reading its code:

- WASM exports: `df_create(modelBytes, attenLimDb)`, `df_get_frame_length(handle)`, `df_process_frame(handle, Float32Array) -> Float32Array`, `df_set_atten_lim(handle, db)`.
- `df_create` takes the raw bytes of `DeepFilterNet3_onnx.tar.gz`.
- wasm-bindgen glue calls `new TextDecoder()` at module top level, and AudioWorkletGlobalScope has no `TextDecoder`. A polyfill must be imported first.
- It hands the compiled `WebAssembly.Module` and the model bytes to the worklet through `processorOptions`, then calls `initSync` inside the worklet.

[WorkAdventure noise-suppression](https://github.com/workadventure/noise-suppression) also runs libDF/tract WASM in an AudioWorklet at 48 kHz, measured at 2.7% of an M4 core and 41 to 71 ms of delay. Read it if the build or worklet wiring gets stuck.

**Already known from a live probe** (Chrome 148, YouTube watch page, 2026-10-19, details in `docs/research/2026-10-19-landscape.md`):

- `extension-url` strategies should PASS. Both `blob-url` strategies should FAIL with an AbortError from YouTube's CSP. The probe still runs all 4 to confirm this with the real model.
- `performance.now` does not exist in AudioWorkletGlobalScope. The processor falls back to `Date.now`, which has 1 ms resolution, so browser frame times come out in whole milliseconds. The Node benchmark gives the precise numbers.
- Compiling WASM inside the worklet works only because YouTube allows `'unsafe-eval'`. Prefer the `content-script` compile strategy for v1.

---

## Go / no-go gates

Record every result in `docs/spikes/2026-10-19-worklet-csp-results.md` (Task 10).

| Gate | Pass condition |
|---|---|
| G1 Load | At least 1 of the 4 strategies reaches `ready` on a `https://www.youtube.com/watch?v=…` page in Chrome stable |
| G2 Speed (Node) | Mean frame time ≤ 3 ms for a 10 ms frame on the dev Mac |
| G3 Real time (browser) | With `Date.now` timing, p95 ≤ 2 ms and `overQuantum` ≤ 1% of frames. `overQuantum` counts frames over 2.67 ms, one 128-sample render quantum at 48 kHz, which at 1 ms resolution means 3 ms or more. Test with `latencyHint: 'interactive'` first and retry with `'playback'` if it fails. Passes only if 5 minutes of playback has no audible crackle. |
| G4 Sound | On 3 clips (vlog with background music, podcast with music intro, music video), music is clearly reduced and speech stays intelligible. Sung vocals leaking through is expected and does not fail the gate. |
| G5 Delay | `baseLatency + outputLatency + 40 ms` ≤ 100 ms (40 ms is DeepFilterNet3's algorithmic latency, 125 ms late is the ITU-R BT.1359 detectability limit), and no visible lip-sync drift |

Why G3 uses 2.67 ms and not the 10 ms frame length: the worklet gets a callback every 128 samples (2.67 ms). A 10 ms model frame is processed entirely inside one of those callbacks. A frame that takes 5 ms is "faster than real time" on average but still overruns that single callback, and only the output buffer's slack hides it.

If G1 fails for all 4 strategies, the next spike is the `chrome.tabCapture` + offscreen document route (approach B in the design doc).

---

### Task 0: Prerequisites and scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`

**Step 1: Install toolchain**

```bash
rustup target add wasm32-unknown-unknown
brew install wasm-pack
node --version
```

Expected: Node `v24.x`. If git commands fail with an Xcode licence error, prefix them with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.

**Step 2: Write `package.json`**

```json
{
  "name": "music-filter",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/",
    "build:wasm": "bash scripts/build-wasm.sh",
    "build:worklet": "esbuild src/worklet/processor.js --bundle --format=esm --outfile=extension/dist/processor.js",
    "bench": "node bench/node-bench.mjs"
  },
  "devDependencies": {
    "esbuild": "0.25.0"
  }
}
```

**Step 3: Write `.gitignore`**

```
node_modules/
extension/dist/
extension/assets/
vendor/df/df.js
test-page/sample.mp4
```

**Step 4: Install and commit**

```bash
cd ~/Projects/music-filter
npm install
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold spike project"
```

---

### Task 1: FrameStats

Collects per-frame processing times and reports mean, p95, max, and counts over the frame budget and over one render quantum.

**Files:**
- Create: `src/worklet/frame-stats.js`
- Test: `test/frame-stats.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameStats } from '../src/worklet/frame-stats.js';

test('drain summarises recorded durations and resets', () => {
  const stats = new FrameStats({ budgetMs: 90, quantumMs: 50 });
  for (let ms = 1; ms <= 100; ms++) stats.record(ms);

  assert.deepEqual(stats.drain(), {
    count: 100,
    meanMs: 50.5,
    p95Ms: 95,
    maxMs: 100,
    overBudget: 10,
    overQuantum: 50,
    budgetMs: 90,
    quantumMs: 50,
  });
  assert.equal(stats.count, 0);
});

test('drain with no samples returns zeros', () => {
  const stats = new FrameStats({ budgetMs: 10, quantumMs: 2.5 });
  assert.deepEqual(stats.drain(), {
    count: 0,
    meanMs: 0,
    p95Ms: 0,
    maxMs: 0,
    overBudget: 0,
    overQuantum: 0,
    budgetMs: 10,
    quantumMs: 2.5,
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '…/src/worklet/frame-stats.js'`

**Step 3: Write minimal implementation**

```js
export class FrameStats {
  constructor({ budgetMs, quantumMs }) {
    this.budgetMs = budgetMs;
    this.quantumMs = quantumMs;
    this.durations = [];
  }

  get count() {
    return this.durations.length;
  }

  record(durationMs) {
    this.durations.push(durationMs);
  }

  drain() {
    const sorted = this.durations.slice().sort((a, b) => a - b);
    const count = sorted.length;
    this.durations = [];

    const summary = {
      count,
      meanMs: 0,
      p95Ms: 0,
      maxMs: 0,
      overBudget: 0,
      overQuantum: 0,
      budgetMs: this.budgetMs,
      quantumMs: this.quantumMs,
    };
    if (count === 0) return summary;

    summary.meanMs = sorted.reduce((total, d) => total + d, 0) / count;
    summary.p95Ms = sorted[Math.ceil(count * 0.95) - 1];
    summary.maxMs = sorted[count - 1];
    summary.overBudget = sorted.filter((d) => d > this.budgetMs).length;
    summary.overQuantum = sorted.filter((d) => d > this.quantumMs).length;
    return summary;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 2 tests

**Step 5: Commit**

```bash
git add src/worklet/frame-stats.js test/frame-stats.test.js
git commit -m "feat: frame timing stats"
```

---

### Task 2: FrameAdapter

WebAudio delivers 128-sample blocks. DeepFilterNet3 wants 480-sample frames. The adapter collects input into frames, runs the model, and plays the result back out in 128-sample blocks. The output FIFO starts with one frame of silence, so output is always available and the added delay is exactly one frame.

**Files:**
- Create: `src/worklet/frame-adapter.js`
- Test: `test/frame-adapter.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameAdapter } from '../src/worklet/frame-adapter.js';

const BLOCK = 128;
const FRAME = 480;

function runBlocks(adapter, blockCount) {
  const output = [];
  for (let block = 0; block < blockCount; block++) {
    const input = Float32Array.from({ length: BLOCK }, (_, i) => block * BLOCK + i + 1);
    const out = new Float32Array(BLOCK);
    adapter.process(input, out);
    output.push(...out);
  }
  return output;
}

test('output is the input delayed by exactly one frame', () => {
  const adapter = new FrameAdapter(FRAME, (frame) => frame);
  const output = runBlocks(adapter, 20);

  output.forEach((sample, n) => {
    assert.equal(sample, n < FRAME ? 0 : n - FRAME + 1, `sample ${n}`);
  });
  assert.equal(adapter.latencySamples, FRAME);
});

test('processFrame only ever receives full frames', () => {
  const lengths = [];
  const adapter = new FrameAdapter(FRAME, (frame) => {
    lengths.push(frame.length);
    return frame;
  });
  runBlocks(adapter, 15);

  assert.deepEqual(lengths, [FRAME, FRAME, FRAME, FRAME]);
});

test('output comes from processFrame, not the input', () => {
  const adapter = new FrameAdapter(FRAME, (frame) => frame.map((x) => -x));
  const output = runBlocks(adapter, 8);

  assert.equal(output[FRAME], -1);
  assert.equal(output[FRAME + 100], -101);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '…/src/worklet/frame-adapter.js'`

**Step 3: Write minimal implementation**

```js
export class FrameAdapter {
  constructor(frameLength, processFrame) {
    this.frameLength = frameLength;
    this.processFrame = processFrame;
    this.frame = new Float32Array(frameLength);
    this.frameFill = 0;
    this.fifo = new Float32Array(frameLength * 4);
    this.readIndex = 0;
    this.available = frameLength;
  }

  get latencySamples() {
    return this.frameLength;
  }

  process(input, output) {
    for (let i = 0; i < input.length; i++) {
      this.frame[this.frameFill++] = input[i];
      if (this.frameFill === this.frameLength) {
        this.pushFrame(this.processFrame(this.frame));
        this.frameFill = 0;
      }
    }

    for (let i = 0; i < output.length; i++) {
      output[i] = this.fifo[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.fifo.length;
    }
    this.available -= output.length;
  }

  pushFrame(processed) {
    let writeIndex = (this.readIndex + this.available) % this.fifo.length;
    for (let i = 0; i < processed.length; i++) {
      this.fifo[writeIndex] = processed[i];
      writeIndex = (writeIndex + 1) % this.fifo.length;
    }
    this.available += processed.length;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 5 tests total

**Step 5: Commit**

```bash
git add src/worklet/frame-adapter.js test/frame-adapter.test.js
git commit -m "feat: 128-sample block to 480-sample frame adapter"
```

---

### Task 3: TextDecoder / TextEncoder polyfill

The wasm-bindgen glue calls `new TextDecoder()` when the module loads. AudioWorkletGlobalScope has neither class, so the worklet must install them before importing the glue.

**Files:**
- Create: `src/worklet/text-codec-polyfill.js`
- Test: `test/text-codec-polyfill.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Utf8Decoder, Utf8Encoder } from '../src/worklet/text-codec-polyfill.js';

test('round-trips non-ASCII text', () => {
  const text = 'héllo ✓ 音楽';
  const bytes = new Utf8Encoder().encode(text);

  assert.deepEqual(bytes, new TextEncoder().encode(text));
  assert.equal(new Utf8Decoder().decode(bytes), text);
});

test('decodes a subarray view and an empty call', () => {
  const bytes = new TextEncoder().encode('xxabcxx');
  const decoder = new Utf8Decoder('utf-8', { ignoreBOM: true, fatal: true });

  assert.equal(decoder.decode(bytes.subarray(2, 5)), 'abc');
  assert.equal(decoder.decode(), '');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module '…/src/worklet/text-codec-polyfill.js'`

**Step 3: Write minimal implementation**

```js
export class Utf8Decoder {
  decode(input) {
    if (!input) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(binary));
  }
}

export class Utf8Encoder {
  get encoding() {
    return 'utf-8';
  }

  encode(text = '') {
    const binary = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
}

globalThis.TextDecoder ??= Utf8Decoder;
globalThis.TextEncoder ??= Utf8Encoder;
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 7 tests total

**Step 5: Commit**

```bash
git add src/worklet/text-codec-polyfill.js test/text-codec-polyfill.test.js
git commit -m "feat: TextDecoder/TextEncoder polyfill for the audio worklet"
```

---

### Task 4: Build DeepFilterNet3 WASM and fetch the model

**Files:**
- Create: `scripts/build-wasm.sh`
- Generated (git-ignored): `vendor/df/df.js`, `extension/assets/df_bg.wasm`, `extension/assets/DeepFilterNet3_onnx.tar.gz`
- Generated (committed): `vendor/df/SOURCE`

**Step 1: Write `scripts/build-wasm.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DF_REF="${DF_REF:-main}"
WORK="$(mktemp -d)"

git clone --depth 1 --branch "$DF_REF" https://github.com/Rikorose/DeepFilterNet.git "$WORK/DeepFilterNet"
cd "$WORK/DeepFilterNet/libDF"

RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+nontrapping-fptoint,+mutable-globals" \
  wasm-pack build --target web --release --features wasm

test -f pkg/df.js || { echo "expected pkg/df.js, got:"; ls pkg; exit 1; }

mkdir -p "$ROOT/vendor/df" "$ROOT/extension/assets"
cp pkg/df.js "$ROOT/vendor/df/df.js"
cp pkg/df_bg.wasm "$ROOT/extension/assets/df_bg.wasm"
cp ../models/DeepFilterNet3_onnx.tar.gz "$ROOT/extension/assets/DeepFilterNet3_onnx.tar.gz"

{
  echo "repo: https://github.com/Rikorose/DeepFilterNet"
  echo "commit: $(git rev-parse HEAD)"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "wasm bytes: $(wc -c < pkg/df_bg.wasm | tr -d ' ')"
  echo "model bytes: $(wc -c < ../models/DeepFilterNet3_onnx.tar.gz | tr -d ' ')"
} > "$ROOT/vendor/df/SOURCE"

cat "$ROOT/vendor/df/SOURCE"
```

**Step 2: Check upstream has the wasm feature before building**

```bash
git clone --depth 1 https://github.com/Rikorose/DeepFilterNet.git /tmp/df-check
grep -n 'wasm' /tmp/df-check/libDF/Cargo.toml
grep -rn 'pub fn df_' /tmp/df-check/libDF/src/ | grep -i wasm
```

Expected: a `wasm = [...]` feature in `Cargo.toml`, and `df_create`, `df_get_frame_length`, `df_process_frame`, `df_set_atten_lim` in a wasm source file. If the model lives under Git LFS, `ls -la /tmp/df-check/models/DeepFilterNet3_onnx.tar.gz` will show a ~130-byte pointer file. In that case, change the script to download it with `curl -L -o … https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3_onnx.tar.gz`.

If the feature or exports are missing, stop and record it in the results doc. The fallback is building from `mezonai/mezon-noise-suppression`'s fork, which is dual-licensed the same way.

**Step 3: Run the build**

Run: `npm run build:wasm`
Expected: `vendor/df/SOURCE` is printed with a commit SHA and non-zero byte counts. If `wasm-opt` rejects SIMD instructions, rerun with `wasm-pack build … --no-opt` and note it in the results doc.

**Step 4: Commit**

```bash
git add scripts/build-wasm.sh vendor/df/SOURCE
git commit -m "build: DeepFilterNet3 wasm build script"
```

---

### Task 5: Node benchmark (gate G2)

**Files:**
- Create: `bench/node-bench.mjs`

**Step 1: Write the benchmark**

```js
import { readFileSync } from 'node:fs';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../vendor/df/df.js';
import { FrameStats } from '../src/worklet/frame-stats.js';

const SAMPLE_RATE = 48000;
const SECONDS = 60;
const ATTEN_LIM_DB = 100;

const wasm = readFileSync(new URL('../extension/assets/df_bg.wasm', import.meta.url));
const model = readFileSync(new URL('../extension/assets/DeepFilterNet3_onnx.tar.gz', import.meta.url));

initSync({ module: wasm });
const handle = df_create(new Uint8Array(model), ATTEN_LIM_DB);
const frameLength = df_get_frame_length(handle);
const frameCount = Math.floor((SECONDS * SAMPLE_RATE) / frameLength);

const stats = new FrameStats({
  budgetMs: (frameLength / SAMPLE_RATE) * 1000,
  quantumMs: (128 / SAMPLE_RATE) * 1000,
});

const frame = new Float32Array(frameLength);
for (let f = 0; f < frameCount; f++) {
  for (let i = 0; i < frameLength; i++) {
    const t = (f * frameLength + i) / SAMPLE_RATE;
    frame[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * (Math.random() * 2 - 1);
  }
  const start = performance.now();
  df_process_frame(handle, frame);
  stats.record(performance.now() - start);
}

const summary = stats.drain();
console.log(JSON.stringify({ frameLength, realtimeFactor: summary.meanMs / summary.budgetMs, ...summary }, null, 2));
```

**Step 2: Run it**

Run: `npm run bench`
Expected: JSON with `frameLength: 480`, `budgetMs: 10`, and `meanMs` well under 10. G2 passes if `meanMs ≤ 3`. Copy the output into the results doc.

**Step 3: Commit**

```bash
git add bench/node-bench.mjs
git commit -m "bench: DeepFilterNet3 wasm frame timing in Node"
```

---

### Task 6: Worklet processor

**Files:**
- Create: `src/worklet/processor.js`
- Generated (git-ignored): `extension/dist/processor.js`

**Step 1: Write the processor**

The polyfill import must stay first so it runs before the wasm-bindgen glue evaluates.

```js
import './text-codec-polyfill.js';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { FrameAdapter } from './frame-adapter.js';
import { FrameStats } from './frame-stats.js';

const REPORT_EVERY_FRAMES = 100;
const RENDER_QUANTUM = 128;

const clock =
  typeof performance === 'object' && typeof performance.now === 'function'
    ? { name: 'performance.now', now: () => performance.now() }
    : { name: 'Date.now', now: () => Date.now() };

class MusicFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.isBypassed = false;
    this.mono = new Float32Array(RENDER_QUANTUM);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'bypass') this.isBypassed = data.value;
    };

    try {
      const { wasm, modelBytes, attenLimDb } = options.processorOptions;
      initSync({ module: wasm });
      this.handle = df_create(new Uint8Array(modelBytes), attenLimDb);
      const frameLength = df_get_frame_length(this.handle);
      this.stats = new FrameStats({
        budgetMs: (frameLength / sampleRate) * 1000,
        quantumMs: (RENDER_QUANTUM / sampleRate) * 1000,
      });
      this.adapter = new FrameAdapter(frameLength, (frame) => this.processFrame(frame));
      this.port.postMessage({ type: 'ready', frameLength, sampleRate, clock: clock.name });
    } catch (error) {
      this.port.postMessage({ type: 'error', stage: 'init', message: String(error?.message ?? error) });
    }
  }

  processFrame(frame) {
    if (this.isBypassed) return frame;
    const start = clock.now();
    const processed = df_process_frame(this.handle, frame);
    this.stats.record(clock.now() - start);
    if (this.stats.count >= REPORT_EVERY_FRAMES) {
      this.port.postMessage({ type: 'stats', ...this.stats.drain() });
    }
    return processed;
  }

  toMono(input) {
    const [left, right] = input;
    if (!left) return this.mono.fill(0);
    if (!right) return left;
    for (let i = 0; i < left.length; i++) this.mono[i] = 0.5 * (left[i] + right[i]);
    return this.mono;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!this.adapter) return true;

    this.adapter.process(this.toMono(inputs[0]), output[0]);
    for (let channel = 1; channel < output.length; channel++) output[channel].set(output[0]);
    return true;
  }
}

registerProcessor('music-filter', MusicFilterProcessor);
```

**Step 2: Bundle it**

Run: `npm run build:worklet`
Expected: `extension/dist/processor.js` written. Check it has no remaining imports:

```bash
grep -c '^import ' extension/dist/processor.js
```

Expected: `0`. A Blob URL module cannot resolve relative imports, so the bundle must be self-contained.

**Step 3: Commit**

```bash
git add src/worklet/processor.js
git commit -m "feat: DeepFilterNet3 audio worklet processor"
```

---

### Task 7: Extension manifest and content script

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/content.js`

**Step 1: Write `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Music Filter Spike",
  "version": "0.0.1",
  "content_scripts": [
    {
      "matches": ["https://www.youtube.com/*", "http://localhost/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["dist/processor.js", "assets/*"],
      "matches": ["https://www.youtube.com/*", "http://localhost/*"]
    }
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

**Step 2: Write `extension/content.js`**

Hotkeys, all Alt+Shift so they don't collide with YouTube's own:

| Keys | Action |
|---|---|
| Alt+Shift+L | Probe all 4 strategies. Does not touch the video. |
| Alt+Shift+M | Attach the first passing strategy to the `<video>` |
| Alt+Shift+B | Toggle bypass (graph stays attached, delay stays the same) |
| Alt+Shift+H | Toggle `latencyHint` between `interactive` and `playback`, then reload |

```js
(() => {
  const PROCESSOR_PATH = 'dist/processor.js';
  const WASM_PATH = 'assets/df_bg.wasm';
  const MODEL_PATH = 'assets/DeepFilterNet3_onnx.tar.gz';
  const ATTEN_LIM_DB = 100;
  const READY_TIMEOUT_MS = 10000;
  const STRATEGY_KEY = 'musicFilter.strategy';
  const LATENCY_KEY = 'musicFilter.latencyHint';

  const STRATEGIES = [
    { loader: 'extension-url', compileIn: 'content-script' },
    { loader: 'extension-url', compileIn: 'worklet' },
    { loader: 'blob-url', compileIn: 'content-script' },
    { loader: 'blob-url', compileIn: 'worklet' },
  ];

  const overlay = (() => {
    const box = document.createElement('pre');
    Object.assign(box.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      zIndex: '2147483647',
      margin: '0',
      padding: '8px',
      maxWidth: '520px',
      whiteSpace: 'pre-wrap',
      font: '12px/1.4 ui-monospace, monospace',
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#7CFC00',
      pointerEvents: 'none',
    });
    const lines = new Map();
    return {
      set(key, text) {
        lines.set(key, text);
        box.textContent = [...lines.values()].join('\n');
        if (!box.isConnected) document.documentElement.append(box);
      },
    };
  })();

  const cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
  });

  let assetsPromise;
  function loadAssets() {
    assetsPromise ??= Promise.all([
      fetch(chrome.runtime.getURL(PROCESSOR_PATH)).then((r) => r.text()),
      fetch(chrome.runtime.getURL(WASM_PATH)).then((r) => r.arrayBuffer()),
      fetch(chrome.runtime.getURL(MODEL_PATH)).then((r) => r.arrayBuffer()),
    ]).then(([processorSource, wasmBytes, modelBytes]) => ({ processorSource, wasmBytes, modelBytes }));
    return assetsPromise;
  }

  function moduleUrl(loader, processorSource) {
    if (loader === 'extension-url') return chrome.runtime.getURL(PROCESSOR_PATH);
    return URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
  }

  function waitForReady(node) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready message after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
      node.port.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(timer);
          resolve(data);
        }
        if (data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`${data.stage}: ${data.message}`));
        }
      };
      node.onprocessorerror = () => {
        clearTimeout(timer);
        reject(new Error('processorerror event'));
      };
    });
  }

  async function createFilterNode(context, strategy) {
    const assets = await loadAssets();
    await context.audioWorklet.addModule(moduleUrl(strategy.loader, assets.processorSource));
    const wasm =
      strategy.compileIn === 'content-script' ? await WebAssembly.compile(assets.wasmBytes) : assets.wasmBytes;
    const node = new AudioWorkletNode(context, 'music-filter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasm, modelBytes: assets.modelBytes, attenLimDb: ATTEN_LIM_DB },
    });
    const ready = await waitForReady(node);
    return { node, ready };
  }

  async function probe() {
    const rows = [];
    for (const strategy of STRATEGIES) {
      const violationsBefore = cspViolations.length;
      const context = new AudioContext({ sampleRate: 48000 });
      const startedAt = performance.now();
      try {
        await context.resume();
        const { ready } = await createFilterNode(context, strategy);
        rows.push({ ...strategy, ok: true, initMs: Math.round(performance.now() - startedAt), ...ready });
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        rows.push({ ...strategy, ok: false, error: error.message, csp: cspViolations.slice(violationsBefore) });
      } finally {
        await context.close();
      }
    }

    console.table(rows);
    console.log('[music-filter] probe', JSON.stringify(rows));
    overlay.set(
      'probe',
      rows
        .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.loader} / ${r.compileIn}${r.ok ? ` ${r.initMs}ms` : ` ${r.error}`}`)
        .join('\n'),
    );

    const passing = rows.find((r) => r.ok);
    if (passing) {
      sessionStorage.setItem(STRATEGY_KEY, JSON.stringify({ loader: passing.loader, compileIn: passing.compileIn }));
    }
    return passing;
  }

  let attached;

  async function attach() {
    if (attached) return;
    const video = document.querySelector('video');
    if (!video) return overlay.set('status', 'no <video> on this page');

    const strategy = JSON.parse(sessionStorage.getItem(STRATEGY_KEY) ?? 'null') ?? (await probe());
    if (!strategy) return overlay.set('status', 'no working strategy, video left untouched');

    const latencyHint = sessionStorage.getItem(LATENCY_KEY) ?? 'interactive';
    const context = new AudioContext({ sampleRate: 48000, latencyHint });
    await context.resume();

    let node;
    let ready;
    try {
      ({ node, ready } = await createFilterNode(context, strategy));
    } catch (error) {
      await context.close();
      return overlay.set('status', `attach failed, video left untouched: ${error.message}`);
    }

    context.createMediaElementSource(video).connect(node).connect(context.destination);
    node.port.onmessage = ({ data }) => {
      if (data.type !== 'stats') return;
      console.log('[music-filter] stats', JSON.stringify(data));
      overlay.set(
        'stats',
        `frames=${data.count} mean=${data.meanMs.toFixed(2)}ms p95=${data.p95Ms.toFixed(2)}ms ` +
          `max=${data.maxMs.toFixed(2)}ms overQuantum=${data.overQuantum} overBudget=${data.overBudget}`,
      );
    };
    attached = { node, isBypassed: false };

    overlay.set(
      'status',
      `attached ${strategy.loader}/${strategy.compileIn} latencyHint=${latencyHint} ` +
        `base=${(context.baseLatency * 1000).toFixed(1)}ms output=${(context.outputLatency * 1000).toFixed(1)}ms ` +
        `frame=${ready.frameLength} clock=${ready.clock}`,
    );
  }

  async function toggleBypass() {
    if (!attached) return;
    attached.isBypassed = !attached.isBypassed;
    attached.node.port.postMessage({ type: 'bypass', value: attached.isBypassed });
    overlay.set('bypass', attached.isBypassed ? 'BYPASS (original audio)' : 'FILTERING');
  }

  async function toggleLatencyHint() {
    const current = sessionStorage.getItem(LATENCY_KEY) ?? 'interactive';
    sessionStorage.setItem(LATENCY_KEY, current === 'interactive' ? 'playback' : 'interactive');
    location.reload();
  }

  const HOTKEYS = { KeyL: probe, KeyM: attach, KeyB: toggleBypass, KeyH: toggleLatencyHint };

  document.addEventListener(
    'keydown',
    (event) => {
      const action = event.altKey && event.shiftKey ? HOTKEYS[event.code] : undefined;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action().catch((error) => overlay.set('status', `error: ${error.message}`));
    },
    true,
  );

  overlay.set('help', 'music-filter spike: Alt+Shift+L probe, M attach, B bypass, H latency hint');
})();
```

`createMediaElementSource` is only called after the worklet reports `ready`, so a failed strategy never silences the video. Every hotkey action is `async` so the keydown handler's `.catch` always has a promise.

**Step 3: Load the extension**

1. `npm run build:worklet`
2. Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `~/Projects/music-filter/extension`.
3. Expected: no errors on the extension card.

**Step 4: Commit**

```bash
git add extension/manifest.json extension/content.js
git commit -m "feat: spike extension with strategy probe, attach and stats overlay"
```

---

### Task 8: Control run on a page with no CSP

This separates bugs in our code from CSP blocks. If a strategy fails here, it's our bug, not YouTube's.

**Files:**
- Create: `test-page/index.html`
- Provide (git-ignored): `test-page/sample.mp4`, any clip with speech over background music

**Step 1: Write `test-page/index.html`**

```html
<!doctype html>
<meta charset="utf-8">
<title>music-filter control</title>
<video src="sample.mp4" controls width="640"></video>
```

**Step 2: Serve and test**

```bash
python3 -m http.server 8000 --directory test-page
```

Open `http://localhost:8000`, click the page once, then:

1. Alt+Shift+L. Expected: all 4 rows `PASS`, `frameLength 480`. Any `FAIL` here is a bug. Fix it before Task 9.
2. Press play, then Alt+Shift+M. Expected: status line shows `attached …`, and stats lines update every second.
3. Alt+Shift+B a few times. Expected: background music audibly drops when filtering, and the audio never cuts out.

**Step 3: Commit**

```bash
git add test-page/index.html
git commit -m "test: local control page for the spike"
```

---

### Task 9: YouTube run (gates G1, G3, G4, G5)

**Step 1: Capture YouTube's CSP for the record**

```bash
curl -sI 'https://www.youtube.com/watch?v=jNQXAC9IVRw' | grep -i '^content-security-policy'
```

Paste the output into the results doc. `script-src`, `worker-src` and the absence or presence of `'wasm-unsafe-eval'` are the directives that matter.

**Step 2: Probe (G1)**

Open any YouTube watch page, click the page once, then Alt+Shift+L. Copy the `[music-filter] probe` console line, from the content script context in DevTools, into the results doc. Include the `csp` entries for every `FAIL`.

**Step 3: Real-time check (G3, G5)**

1. Play a video, then Alt+Shift+M.
2. Let it run for 5 minutes. Copy 10 `[music-filter] stats` lines spread across the run, and the `status` line with `base` and `output` latency.
3. Listen for crackles. Note any.
4. Repeat with Alt+Shift+H (`playback`) if G3 failed on `interactive`.
5. Repeat once with 3 other heavy tabs open (another YouTube video paused, a Google Doc, a Figma file or similar) to see how much headroom there is.

**Step 4: Listening test (G4)**

Run three clips: a vlog with background music, a podcast with a music intro, and a music video. Toggle Alt+Shift+B on each. Score speech clarity and music left over, 1 to 5 each.

---

### Task 10: Results and decision

**Files:**
- Create: `docs/spikes/2026-10-19-worklet-csp-results.md`

**Step 1: Write the results doc**

```markdown
# Spike results: DeepFilterNet3 AudioWorklet on YouTube

Date:
Chrome version:
Machine:
DeepFilterNet commit (from vendor/df/SOURCE):
WASM / model size:

## Gates

| Gate | Result | Evidence |
|---|---|---|
| G1 Load | | |
| G2 Speed (Node) | | |
| G3 Real time (browser) | | |
| G4 Sound | | |
| G5 Delay | | |

## Strategy probe

| Loader | Compile in | Control page | YouTube | Error / CSP directive |
|---|---|---|---|---|
| extension-url | content-script | | | |
| extension-url | worklet | | | |
| blob-url | content-script | | | |
| blob-url | worklet | | | |

## YouTube CSP header

## Frame timing

Node bench JSON:

Browser stats, interactive:

Browser stats, playback:

## Listening scores

| Clip | Speech clarity 1-5 | Music left 1-5 | Notes |
|---|---|---|---|

## Decision

Go / no-go for approach A, the chosen strategy, and anything the v1 plan must change.
```

**Step 2: Commit**

```bash
git add docs/spikes/2026-10-19-worklet-csp-results.md
git commit -m "docs: spike results for worklet on YouTube"
```

---

## Out of scope for this spike

- Firefox. Its content scripts use Xray wrappers, which may change how `createMediaElementSource` and worklets behave. Check it separately once Chrome passes.
- Popup UI, per-site settings, the strength slider, SPA navigation handling, element swaps.
- Fine-tuned weights.
