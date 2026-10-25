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

function movingAverageFilter() {
  let average = 0;
  const inputs = [];
  const processFrame = (frame) => {
    inputs.push(frame.slice());
    return frame.map((sample) => (average = 0.9999 * average + 0.0001 * sample));
  };
  return { processFrame, inputs };
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

test('context before the window primes the state exactly like one continuous pass', () => {
  const context = [noise(5000 + 37, 8), noise(5000 + 37, 9)];
  const left = noise(9600 + 11, 10);
  const right = noise(9600 + 11, 11);

  const primed = movingAverageFilter();
  const [voice, copy] = createVoiceFilter({ processFrame: primed.processFrame, frameLength: FRAME })(left, right, {
    contextBefore: context,
  });

  const continuous = movingAverageFilter();
  const [whole] = createVoiceFilter({ processFrame: continuous.processFrame, frameLength: FRAME, warmUpSamples: 0 })(
    concat(context[0], left),
    concat(context[1], right),
  );

  assertSameSamples(voice, whole.subarray(context[0].length));
  assertSameSamples(copy, voice);
  assertSameSamples(primed.inputs[0], downmix(...context).subarray(0, FRAME));
  assert.equal(primed.inputs.length, Math.ceil((context[0].length + left.length + DFN_DELAY_SAMPLES) / FRAME));

  const cold = movingAverageFilter();
  const [unprimed] = createVoiceFilter({ processFrame: cold.processFrame, frameLength: FRAME })(left, right);
  assert.ok(unprimed.some((sample, i) => sample !== voice[i]));
});

test('an empty context falls back to the warm-up on the start of the window', () => {
  const warmUpSamples = 4800;
  const left = noise(9600, 12);
  const right = noise(9600, 13);
  const mono = downmix(left, right);
  for (const options of [undefined, {}, { contextBefore: [new Float32Array(0), new Float32Array(0)] }]) {
    const { processFrame, inputs } = movingAverageFilter();
    createVoiceFilter({ processFrame, frameLength: FRAME, warmUpSamples })(left, right, options);
    assert.equal(inputs.length, warmUpSamples / FRAME + Math.ceil((9600 + DFN_DELAY_SAMPLES) / FRAME));
    assertSameSamples(inputs[0], mono.subarray(0, FRAME));
    assertSameSamples(inputs[warmUpSamples / FRAME], mono.subarray(0, FRAME));
  }
});
