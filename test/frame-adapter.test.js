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
