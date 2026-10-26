import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createVoiceFilter } from '../src/pipeline/voice-filter.js';
import { createDpdfFilter, wrapDpdf } from '../src/pipeline/dpdf-filter.js';

const DELAY = 3165;
const DPDF_JS = new URL('../vendor/dpdf/dpdf.js', import.meta.url);
const DPDF_WASM = new URL('../extension/assets/dpdf_bg.wasm', import.meta.url);
const DPDF_MODEL = new URL('../extension/assets/dpdfnet4.onnx', import.meta.url);
const missingDpdf = [DPDF_JS, DPDF_WASM, DPDF_MODEL].filter((url) => !existsSync(url));

function fakeFilter({ delay = DELAY, smoothing = 0 } = {}) {
  const line = new Float32Array(delay);
  const events = [];
  let position = 0;
  let average = 0;
  return {
    delay,
    events,
    process(input, output) {
      events.push({ type: 'process', input: input.slice() });
      for (let i = 0; i < input.length; i++) {
        average = smoothing * average + (1 - smoothing) * input[i];
        output[i] = line[position];
        line[position] = average;
        position = (position + 1) % delay;
      }
    },
    reset() {
      events.push({ type: 'reset' });
      line.fill(0);
      position = 0;
      average = 0;
    },
  };
}

function noise(length, seed) {
  let state = seed;
  return Float32Array.from({ length }, () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
}

function downmix(left, right) {
  return Float32Array.from(left, (sample, i) => 0.5 * (sample + right[i]));
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function assertSameSamples(actual, expected) {
  assert.equal(actual.length, expected.length);
  const firstMismatch = actual.findIndex((sample, i) => sample !== expected[i]);
  assert.equal(firstMismatch, -1, `first mismatch at sample ${firstMismatch}`);
}

test('output lines up with the mono downmix sample for sample after the delay', () => {
  const filter = fakeFilter();
  const left = noise(48000 + 123, 1);
  const right = noise(48000 + 123, 2);
  const [voice, copy] = createVoiceFilter({ filter })(left, right, { contextBefore: [noise(500, 3), noise(500, 4)] });
  assertSameSamples(voice, downmix(left, right));
  assertSameSamples(copy, voice);
  assert.notEqual(copy.buffer, voice.buffer);
});

test('the window is padded so the delayed tail is flushed', () => {
  const filter = fakeFilter();
  const left = noise(9600, 5);
  createVoiceFilter({ filter })(left, left, { contextBefore: [noise(700, 6), noise(700, 7)] });
  const windowPass = filter.events.at(-1);
  assert.equal(windowPass.input.length, 9600 + DELAY);
  assertSameSamples(windowPass.input.subarray(0, 9600), left);
  assert.ok(windowPass.input.subarray(9600).every((sample) => sample === 0));
});

test('a window shorter than the delay keeps its length', () => {
  const left = noise(100, 8);
  const right = noise(100, 9);
  const [voice] = createVoiceFilter({ filter: fakeFilter() })(left, right);
  assertSameSamples(voice, downmix(left, right));
});

test('context primes the state exactly like one continuous pass and its output is discarded', () => {
  const context = [noise(5000 + 37, 10), noise(5000 + 37, 11)];
  const left = noise(9600 + 11, 12);
  const right = noise(9600 + 11, 13);

  const primed = fakeFilter({ smoothing: 0.999 });
  const [voice, copy] = createVoiceFilter({ filter: primed })(left, right, { contextBefore: context });

  const continuous = fakeFilter({ smoothing: 0.999 });
  const whole = concat(downmix(...context), downmix(left, right));
  const out = new Float32Array(whole.length + DELAY);
  continuous.process(concat(whole, new Float32Array(DELAY)), out);

  assertSameSamples(voice, out.subarray(DELAY + context[0].length));
  assertSameSamples(copy, voice);
  assert.deepEqual(
    primed.events.map((event) => event.type),
    ['reset', 'process', 'process'],
  );
  assertSameSamples(primed.events[1].input, downmix(...context));

  const [cold] = createVoiceFilter({ filter: fakeFilter({ smoothing: 0.999 }) })(left, right);
  assert.ok(cold.some((sample, i) => sample !== voice[i]));
});

test('every window resets the engine so the previous window leaves no state behind', () => {
  const filter = fakeFilter({ smoothing: 0.99 });
  const voiceFilter = createVoiceFilter({ filter });
  const context = [noise(2000, 14), noise(2000, 15)];
  const left = noise(9600, 16);
  const right = noise(9600, 17);
  const [first] = voiceFilter(left, right, { contextBefore: context });
  voiceFilter(noise(4800, 18), noise(4800, 19), { contextBefore: [noise(3000, 20), noise(3000, 21)] });
  const [again] = voiceFilter(left, right, { contextBefore: context });
  assertSameSamples(again, first);
  assert.equal(filter.events.filter((event) => event.type === 'reset').length, 3);
});

test('an empty context falls back to a warm-up on the start of the window', () => {
  const warmUpSamples = 4800;
  const left = noise(9600, 22);
  const right = noise(9600, 23);
  const mono = downmix(left, right);
  for (const options of [undefined, {}, { contextBefore: [new Float32Array(0), new Float32Array(0)] }]) {
    const filter = fakeFilter();
    const [voice] = createVoiceFilter({ filter, warmUpSamples })(left, right, options);
    assert.deepEqual(
      filter.events.map((event) => event.type),
      ['reset', 'process', 'process'],
    );
    assertSameSamples(filter.events[1].input, mono.subarray(0, warmUpSamples));
    assertSameSamples(voice, mono);
  }
});

test(
  'real DPDFNet-4 keeps the length, stays finite and strongly attenuates a steady tone',
  { skip: missingDpdf.length > 0 && `missing ${missingDpdf.map((url) => url.pathname).join(', ')}` },
  async () => {
    const { initSync, Dpdf } = await import(DPDF_JS.href);
    initSync({ module: readFileSync(DPDF_WASM) });
    const engine = wrapDpdf(new Dpdf(new Uint8Array(readFileSync(DPDF_MODEL))));
    try {
      const voiceFilter = createVoiceFilter({ filter: createDpdfFilter({ engine }) });
      const tone = (length, phase) =>
        Float32Array.from(noise(length, 24 + phase), (n, i) => 0.3 * Math.sin((2 * Math.PI * 440 * (i + phase)) / 48000) + 0.01 * n);
      const context = tone(48000, 0);
      const input = tone(2 * 48000 + 77, 48000);
      const [voice, copy] = voiceFilter(input, input, { contextBefore: [context, context] });
      const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
      assert.equal(voice.length, input.length);
      assert.equal(copy.length, input.length);
      assert.ok(voice.every(Number.isFinite));
      const dropDb = 20 * Math.log10(rms(input) / rms(voice));
      assert.ok(dropDb > 20, `RMS dropped ${dropDb.toFixed(1)} dB`);
    } finally {
      engine.free();
    }
  },
);
