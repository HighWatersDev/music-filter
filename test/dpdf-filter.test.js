import test from 'node:test';
import assert from 'node:assert/strict';
import { createDpdfFilter } from '../src/pipeline/dpdf-filter.js';
import { createDownsampler, createUpsampler } from '../src/pipeline/resampler.js';

const HOP = 160;
const ROUND_TRIP = 288;

function delayEngine(delay, { hop = HOP } = {}) {
  const line = new Float32Array(delay + hop);
  const engine = {
    hop,
    hops: 0,
    resets: 0,
    processHop(input, output) {
      assert.equal(input.length, hop);
      assert.equal(output.length, hop);
      line.copyWithin(0, hop);
      line.set(input, delay);
      output.set(line.subarray(0, hop));
      engine.hops++;
    },
    reset() {
      line.fill(0);
      engine.resets++;
    },
  };
  return engine;
}

function noise(length, seed) {
  let state = seed;
  return Float32Array.from({ length }, () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
}

function tones(length) {
  const out = new Float32Array(length);
  [180, 950, 2210, 3870, 5300, 6650].forEach((frequency, k) => {
    for (let i = 0; i < length; i++) out[i] += Math.sin((2 * Math.PI * frequency * i) / 48000 + k) / 6;
  });
  return out;
}

function run(filter, input, blockSizes = [input.length]) {
  const output = new Float32Array(input.length);
  let read = 0;
  for (let b = 0; read < input.length; b++) {
    const size = Math.min(blockSizes[b % blockSizes.length], input.length - read);
    filter.process(input.subarray(read, read + size), output.subarray(read, read + size));
    read += size;
  }
  return output;
}

function roundTrip(input) {
  const low = new Float32Array(input.length / 3);
  createDownsampler().process(input, low);
  const high = new Float32Array(input.length);
  createUpsampler().process(low, high);
  return high;
}

function snrDb(reference, actual) {
  let signal = 0;
  let error = 0;
  for (let i = 0; i < reference.length; i++) {
    signal += reference[i] ** 2;
    error += (reference[i] - actual[i]) ** 2;
  }
  return 10 * Math.log10(signal / error);
}

test('total delay is the hop buffering plus the resampler round trip plus the engine delay', () => {
  assert.equal(createDpdfFilter({ engine: delayEngine(0), engineDelay: 0 }).delay, 477 + ROUND_TRIP);
  assert.equal(createDpdfFilter({ engine: delayEngine(800), engineDelay: 800 }).delay, 477 + ROUND_TRIP + 2400);
});

test('defaults to the measured DPDFNet delay of 800 samples at 16 kHz', () => {
  assert.equal(createDpdfFilter({ engine: delayEngine(800) }).delay, 477 + ROUND_TRIP + 2400);
});

test('with a pass-through engine the output is the resampler round trip, shifted by the hop buffering', () => {
  const input = noise(48000, 1);
  const filter = createDpdfFilter({ engine: delayEngine(0), engineDelay: 0 });
  const output = run(filter, input, [128]);
  const shift = filter.delay - ROUND_TRIP;
  assert.deepEqual(output.subarray(0, shift), new Float32Array(shift));
  assert.deepEqual(output.subarray(shift), roundTrip(input).subarray(0, input.length - shift));
});

test('a band-limited signal comes out aligned to the reported delay', () => {
  for (const engineDelay of [0, 37, 800]) {
    const input = tones(48000 * 2);
    const filter = createDpdfFilter({ engine: delayEngine(engineDelay), engineDelay });
    const output = run(filter, input, [128]);
    const start = 48000;
    const span = 24000;
    let best = [0, -Infinity];
    for (let lag = filter.delay - 6; lag <= filter.delay + 6; lag++) {
      const snr = snrDb(input.subarray(start - lag, start - lag + span), output.subarray(start, start + span));
      if (snr > best[1]) best = [lag, snr];
    }
    assert.equal(best[0], filter.delay, `engine delay ${engineDelay}`);
    assert.ok(best[1] > 40, `engine delay ${engineDelay}: SNR ${best[1].toFixed(1)} dB`);
  }
});

test('output does not depend on block sizes', () => {
  const input = noise(48000, 2);
  const whole = run(createDpdfFilter({ engine: delayEngine(800) }), input);
  for (const blocks of [[1], [128], [480], [477, 3], [479, 1, 960, 3], [5000, 7], [127, 129]]) {
    assert.deepEqual(run(createDpdfFilter({ engine: delayEngine(800) }), input, blocks), whole, `blocks ${blocks}`);
  }
});

test('feeds the engine one hop per 480 input samples', () => {
  const engine = delayEngine(0);
  const filter = createDpdfFilter({ engine, engineDelay: 0 });
  run(filter, noise(4800, 3), [128]);
  assert.equal(engine.hops, 10);
});

test('reset restores a fresh filter and resets the engine', () => {
  const input = noise(20000, 4);
  const engine = delayEngine(800);
  const filter = createDpdfFilter({ engine });
  run(filter, noise(7777, 5), [128]);
  filter.reset();
  assert.equal(engine.resets, 1);
  assert.deepEqual(run(filter, input, [128]), run(createDpdfFilter({ engine: delayEngine(800) }), input, [128]));
});

test('rejects an engine whose hop is not 160 samples', () => {
  assert.throws(() => createDpdfFilter({ engine: delayEngine(0, { hop: 480 }) }), /hop/);
});
