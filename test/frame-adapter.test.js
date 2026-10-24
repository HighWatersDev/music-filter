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

function runIdentity(frameLength, blockSize, blockCount) {
  const adapter = new FrameAdapter(frameLength, (frame) => frame);
  const output = [];
  for (let block = 0; block < blockCount; block++) {
    const input = Float32Array.from({ length: blockSize }, (_, i) => block * blockSize + i + 1);
    const out = new Float32Array(blockSize);
    adapter.process(input, out);
    output.push(...out);
  }
  return output;
}

for (const [frameLength, blockSize] of [[480, 441], [480, 1500], [480, 2048], [100, 128]]) {
  test(`identity delay is exactly one frame for frame ${frameLength}, block ${blockSize}`, () => {
    const output = runIdentity(frameLength, blockSize, 12);
    output.forEach((sample, n) => {
      assert.equal(sample, n < frameLength ? 0 : n - frameLength + 1, `sample ${n}`);
    });
  });
}

test('a processed frame of the wrong length throws, naming both lengths', () => {
  const adapter = new FrameAdapter(FRAME, (frame) => frame.subarray(0, FRAME - 1));
  assert.throws(() => runBlocks(adapter, 4), /480.*479|479.*480/);
});

test('a block length that changes after the first call throws', () => {
  const adapter = new FrameAdapter(FRAME, (frame) => frame);
  adapter.process(new Float32Array(BLOCK), new Float32Array(BLOCK));
  assert.throws(() => adapter.process(new Float32Array(256), new Float32Array(256)));
});

test('input and output of different lengths throw', () => {
  const adapter = new FrameAdapter(FRAME, (frame) => frame);
  assert.throws(() => adapter.process(new Float32Array(BLOCK), new Float32Array(BLOCK * 2)));
});

test('a processFrame that throws once does not wedge the adapter', () => {
  let calls = 0;
  const adapter = new FrameAdapter(FRAME, (frame) => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return frame;
  });

  assert.throws(() => runBlocks(adapter, 4), /boom/);
  for (let block = 0; block < 8; block++) {
    adapter.process(new Float32Array(BLOCK), new Float32Array(BLOCK));
  }
  assert.ok(calls > 1, `processFrame called ${calls} times`);
});
