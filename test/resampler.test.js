import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownsampler, createUpsampler } from '../src/pipeline/resampler.js';

const HIGH = 48000;
const LOW = 16000;

function sine(frequency, rate, length, phase = 0) {
  return Float32Array.from({ length }, (_, i) => Math.sin((2 * Math.PI * frequency * i) / rate + phase));
}

function noise(length, seed) {
  let state = seed;
  return Float32Array.from({ length }, () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
}

function downsample(input, blockSizes = [input.length]) {
  const down = createDownsampler();
  const out = new Float32Array(Math.ceil(input.length / 3));
  let read = 0;
  let written = 0;
  for (let b = 0; read < input.length; b++) {
    const size = Math.min(blockSizes[b % blockSizes.length], input.length - read);
    written += down.process(input.subarray(read, read + size), out.subarray(written));
    read += size;
  }
  assert.equal(written, out.length);
  return out;
}

function upsample(input, blockSizes = [input.length]) {
  const up = createUpsampler();
  const out = new Float32Array(input.length * 3);
  let read = 0;
  let written = 0;
  for (let b = 0; read < input.length; b++) {
    const size = Math.min(blockSizes[b % blockSizes.length], input.length - read);
    written += up.process(input.subarray(read, read + size), out.subarray(written));
    read += size;
  }
  assert.equal(written, out.length);
  return out;
}

function amplitudeAt(signal, frequency, rate, start, length) {
  let s = 0;
  let c = 0;
  for (let i = start; i < start + length; i++) {
    s += signal[i] * Math.sin((2 * Math.PI * frequency * i) / rate);
    c += signal[i] * Math.cos((2 * Math.PI * frequency * i) / rate);
  }
  return (2 / length) * Math.hypot(s, c);
}

function rms(signal, start, length) {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += signal[i] ** 2;
  return Math.sqrt(sum / length);
}

const db = (ratio) => 20 * Math.log10(ratio);

function snrDb(reference, actual) {
  let signal = 0;
  let error = 0;
  for (let i = 0; i < reference.length; i++) {
    signal += reference[i] ** 2;
    error += (reference[i] - actual[i]) ** 2;
  }
  return 10 * Math.log10(signal / error);
}

test('reports integer delays: 48 samples at 16 kHz down, 144 samples at 48 kHz up', () => {
  assert.equal(createDownsampler().delay, 48);
  assert.equal(createUpsampler().delay, 144);
});

test('downsampling keeps the passband within 0.5 dB up to 7 kHz', () => {
  for (const frequency of [50, 300, 1000, 2500, 4000, 5500, 6500, 7000]) {
    const out = downsample(sine(frequency, HIGH, HIGH * 2));
    const gain = db(amplitudeAt(out, frequency, LOW, LOW / 2, LOW));
    assert.ok(Math.abs(gain) <= 0.5, `${frequency} Hz: ${gain.toFixed(3)} dB`);
  }
});

test('downsampling rejects everything above 8 kHz by at least 60 dB', () => {
  for (const frequency of [8050, 8500, 9000, 11000, 14000, 16000, 19000, 23950]) {
    const out = downsample(sine(frequency, HIGH, HIGH * 2));
    const gain = db(rms(out, LOW / 2, LOW) / Math.SQRT1_2);
    assert.ok(gain <= -60, `${frequency} Hz leaks at ${gain.toFixed(1)} dB`);
  }
});

test('upsampling keeps the passband within 0.5 dB up to 7 kHz', () => {
  for (const frequency of [50, 300, 1000, 2500, 4000, 5500, 6500, 7000]) {
    const out = upsample(sine(frequency, LOW, LOW * 2));
    const gain = db(amplitudeAt(out, frequency, HIGH, HIGH / 2, HIGH));
    assert.ok(Math.abs(gain) <= 0.5, `${frequency} Hz: ${gain.toFixed(3)} dB`);
  }
});

test('upsampling rejects the images by at least 60 dB', () => {
  for (const frequency of [300, 1000, 4000, 7000, 7900]) {
    const out = upsample(sine(frequency, LOW, LOW * 2));
    for (const image of [LOW - frequency, LOW + frequency]) {
      const gain = db(amplitudeAt(out, image, HIGH, HIGH / 2, HIGH));
      assert.ok(gain <= -60, `${frequency} Hz image at ${image} Hz is ${gain.toFixed(1)} dB`);
    }
  }
});

test('the round trip delays a band-limited signal by exactly the reported delay at every input phase', () => {
  const expectedDelay = 3 * createDownsampler().delay + createUpsampler().delay;
  assert.equal(expectedDelay, 288);
  const tones = [220, 1170, 2930, 4410, 6020, 6870];
  const length = HIGH * 2;
  const clean = new Float32Array(length);
  tones.forEach((frequency, k) => {
    const tone = sine(frequency, HIGH, length, k * 1.3);
    for (let i = 0; i < length; i++) clean[i] += tone[i] / tones.length;
  });

  for (const lead of [0, 1, 2, 7]) {
    const input = new Float32Array(length + lead);
    input.set(clean, lead);
    const out = upsample(downsample(input));
    const start = HIGH / 2;
    const span = HIGH;
    const scores = [];
    for (let lag = expectedDelay - 5; lag <= expectedDelay + 5; lag++) {
      scores.push([lag, snrDb(input.subarray(start - lag, start - lag + span), out.subarray(start, start + span))]);
    }
    const [bestLag, bestSnr] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    assert.equal(bestLag, expectedDelay, `lead ${lead}`);
    assert.ok(bestSnr > 40, `lead ${lead}: round-trip SNR ${bestSnr.toFixed(1)} dB`);
  }
});

test('downsampling gives identical output for any block sizes', () => {
  const input = noise(HIGH, 3);
  const whole = downsample(input);
  for (const blocks of [[1], [2], [128], [479, 1, 64, 3, 1000], [7, 11, 13]]) {
    assert.deepEqual(downsample(input, blocks), whole, `blocks ${blocks}`);
  }
});

test('upsampling gives identical output for any block sizes', () => {
  const input = noise(LOW, 5);
  const whole = upsample(input);
  for (const blocks of [[1], [2], [43], [160, 1, 37, 500], [5, 9]]) {
    assert.deepEqual(upsample(input, blocks), whole, `blocks ${blocks}`);
  }
});

test('reset makes a resampler behave like a new one', () => {
  const first = noise(4000, 9);
  const second = noise(3000, 11);
  const down = createDownsampler();
  const up = createUpsampler();
  down.process(first, new Float32Array(first.length));
  up.process(first, new Float32Array(first.length * 3));
  down.reset();
  up.reset();

  const downOut = new Float32Array(1000);
  assert.equal(down.process(second, downOut), 1000);
  assert.deepEqual(downOut, downsample(second));
  const upOut = new Float32Array(9000);
  assert.equal(up.process(second, upOut), 9000);
  assert.deepEqual(upOut, upsample(second));
});
