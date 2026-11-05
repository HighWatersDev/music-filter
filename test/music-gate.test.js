import test from 'node:test';
import assert from 'node:assert/strict';
import { gateCurve, isPassthrough, mixGate, openFrames, passthroughRanges } from '../src/pipeline/music-gate.js';

const near = (actual, expected) => assert.deepEqual(Array.from(actual, (v) => Math.round(v * 1000) / 1000), expected);

test('a frame opens only when every frame within reach is quiet, and the edges stay closed', () => {
  assert.deepEqual(openFrames(new Float32Array(9)), [false, false, false, true, true, true, false, false, false]);
});

test('one loud frame keeps its neighbours within reach closed', () => {
  const probabilities = new Float32Array(15);
  probabilities[7] = 0.5;
  assert.deepEqual(openFrames(probabilities).flatMap((open, k) => (open ? [k] : [])), [3, 11]);
});

test('a frame the detector could not score counts as music', () => {
  const probabilities = new Float32Array(9);
  probabilities[4] = NaN;
  assert.ok(openFrames(probabilities).every((open) => !open));
});

test('a score at the threshold counts as music', () => {
  assert.ok(openFrames(new Float32Array(9).fill(0.05)).every((open) => !open));
});

test('the curve fades in and out inside the open region', () => {
  const curve = gateCurve([false, true, true, false], { frameSamples: 10, length: 40, fadeSamples: 5 });
  near(curve.subarray(8, 16), [0, 0, 0.2, 0.4, 0.6, 0.8, 1, 1]);
  near(curve.subarray(24, 32), [1, 1, 0.8, 0.6, 0.4, 0.2, 0, 0]);
});

test('an open region shorter than two fades never reaches full original', () => {
  near(gateCurve([false, true, false], { frameSamples: 4, length: 12, fadeSamples: 5 }).subarray(4, 8), [0.2, 0.4, 0.4, 0.2]);
});

test('mixGate blends original and filtered by the curve, per channel', () => {
  const [left, right] = mixGate(
    [new Float32Array([1, 1, 1]), new Float32Array([2, 2, 2])],
    [new Float32Array(3), new Float32Array(3)],
    new Float32Array([0, 0.5, 1]),
  );
  assert.deepEqual(Array.from(left), [0, 0.5, 1]);
  assert.deepEqual(Array.from(right), [0, 1, 2]);
});

test('passthroughRanges lists where the original is mostly playing, in seconds', () => {
  const curve = new Float32Array([0, 0, 0.6, 1, 1, 0.4, 0, 0, 1, 1]);
  assert.deepEqual(passthroughRanges(curve, 10), [[0.2, 0.5], [0.8, 1]]);
});

test('isPassthrough checks a moment against those ranges', () => {
  const ranges = [[10, 12]];
  assert.equal(isPassthrough(ranges, 11), true);
  assert.equal(isPassthrough(ranges, 12), false);
  assert.equal(isPassthrough([], 11), false);
});
