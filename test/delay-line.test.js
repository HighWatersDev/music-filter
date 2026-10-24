import test from 'node:test';
import assert from 'node:assert/strict';
import { DelayLine } from '../src/worklet/delay-line.js';

function runBlocks(line, blockSizes) {
  const output = [];
  let next = 1;
  for (const size of blockSizes) {
    const input = Float32Array.from({ length: size }, () => next++);
    const out = new Float32Array(size);
    line.process(input, out);
    output.push(...out);
  }
  return output;
}

test('output is the input delayed by exactly delaySamples', () => {
  const line = new DelayLine(1440);
  const output = runBlocks(line, Array(30).fill(480));

  output.forEach((sample, n) => {
    assert.equal(sample, n < 1440 ? 0 : n - 1440 + 1, `sample ${n}`);
  });
  assert.equal(line.delaySamples, 1440);
});

test('the delay holds across uneven block sizes, including blocks longer than the delay', () => {
  const line = new DelayLine(300);
  const output = runBlocks(line, [128, 7, 1000, 1, 480, 333]);

  output.forEach((sample, n) => {
    assert.equal(sample, n < 300 ? 0 : n - 300 + 1, `sample ${n}`);
  });
});

test('a zero delay copies the input', () => {
  const line = new DelayLine(0);
  assert.deepEqual(runBlocks(line, [5, 3]), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('processing in place gives the same result as a separate output buffer', () => {
  const line = new DelayLine(5);
  const output = [];
  let next = 1;
  for (let block = 0; block < 4; block++) {
    const buffer = Float32Array.from({ length: 4 }, () => next++);
    line.process(buffer, buffer);
    output.push(...buffer);
  }
  assert.deepEqual(output, [0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('process returns the output buffer', () => {
  const line = new DelayLine(2);
  const out = new Float32Array(4);
  assert.equal(line.process(new Float32Array(4), out), out);
});

test('input and output of different lengths throw', () => {
  const line = new DelayLine(4);
  assert.throws(() => line.process(new Float32Array(8), new Float32Array(4)), /8.*4/);
});

for (const bad of [-1, 1.5, Number.NaN, '10']) {
  test(`delay ${String(bad)} is rejected`, () => {
    assert.throws(() => new DelayLine(bad), RangeError);
  });
}
