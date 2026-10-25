import test from 'node:test';
import assert from 'node:assert/strict';
import { defineMusicFilterProcessor } from '../src/worklet/music-filter-processor.js';

const BLOCK = 128;
const FRAME = 480;
const INPUT_LEVEL = 0.9;
const PROCESSED_LEVEL = 0.25;

class FakeProcessorBase {
  constructor() {
    this.messages = [];
    this.port = { onmessage: null, postMessage: (message) => this.messages.push(message) };
  }
}

function fakeDf({ createError = null } = {}) {
  const df = {
    behaviour: 'ok',
    initSync() {},
    df_create() {
      if (createError) throw createError;
      return 1;
    },
    df_get_frame_length: () => FRAME,
    df_process_frame(handle, frame) {
      if (df.behaviour === 'throw') throw new Error('frame exploded');
      if (df.behaviour === 'nan') return new Float32Array(frame.length).fill(Number.NaN);
      if (df.behaviour === 'short') return new Float32Array(10);
      return new Float32Array(frame.length).fill(PROCESSED_LEVEL);
    },
  };
  return df;
}

function createProcessor({ df, failMode }) {
  const Processor = defineMusicFilterProcessor({
    Base: FakeProcessorBase,
    df,
    sampleRate: 48000,
    clock: { name: 'fake', now: () => 0 },
  });
  const processorOptions = { wasm: {}, modelBytes: new ArrayBuffer(4), attenLimDb: 100 };
  if (failMode) processorOptions.failMode = failMode;
  return new Processor({ processorOptions });
}

function render(processor, blocks) {
  const samples = [];
  for (let block = 0; block < blocks; block++) {
    const input = [new Float32Array(BLOCK).fill(INPUT_LEVEL), new Float32Array(BLOCK).fill(INPUT_LEVEL)];
    const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    processor.process([input], [output]);
    samples.push(...output[0], ...output[1]);
  }
  return samples;
}

const errors = (processor) => processor.messages.filter((message) => message.type === 'error');

function assertNeverInput(samples) {
  assert.ok(
    samples.every((sample) => sample === 0 || sample === PROCESSED_LEVEL),
    'an input sample reached the output',
  );
}

test('silence mode outputs zeros when init fails', () => {
  const processor = createProcessor({ df: fakeDf({ createError: new Error('bad model') }), failMode: 'silence' });
  const samples = render(processor, 20);
  assert.ok(samples.every((sample) => sample === 0));
  assert.deepEqual(errors(processor).map((m) => m.stage), ['init']);
});

test('passthrough mode still passes the input through when init fails', () => {
  const processor = createProcessor({ df: fakeDf({ createError: new Error('bad model') }) });
  const samples = render(processor, 4);
  assert.ok(samples.every((sample) => Math.abs(sample - INPUT_LEVEL) < 1e-6));
});

for (const [behaviour, stage] of [
  ['throw', 'process'],
  ['nan', 'process'],
  ['short', 'render'],
]) {
  test(`silence mode goes silent after a ${behaviour} frame and reports it once`, () => {
    const df = fakeDf();
    const processor = createProcessor({ df, failMode: 'silence' });
    const before = render(processor, 30);
    assert.ok(before.slice(-BLOCK).every((sample) => sample === PROCESSED_LEVEL), 'processed audio before the failure');

    df.behaviour = behaviour;
    const after = render(processor, 60);
    assertNeverInput(after);
    assert.ok(after.slice(-20 * BLOCK).every((sample) => sample === 0), 'output settles on silence');
    assert.deepEqual(errors(processor).map((m) => m.stage), [stage]);
  });
}

test('silence mode stays silent if the model recovers after a failure', () => {
  const df = fakeDf();
  const processor = createProcessor({ df, failMode: 'silence' });
  render(processor, 10);
  df.behaviour = 'throw';
  render(processor, 10);
  df.behaviour = 'ok';
  const samples = render(processor, 30);
  assert.ok(samples.slice(-10 * BLOCK).every((sample) => sample === 0));
});

test('passthrough mode falls back to the delayed input after a throwing frame', () => {
  const df = fakeDf();
  const processor = createProcessor({ df });
  render(processor, 30);
  df.behaviour = 'throw';
  const samples = render(processor, 60);
  assert.ok(samples.slice(-10 * BLOCK).every((sample) => Math.abs(sample - INPUT_LEVEL) < 1e-6));
});

test('passthrough mode falls back to the delayed input after a render error', () => {
  const df = fakeDf();
  const processor = createProcessor({ df });
  render(processor, 30);
  df.behaviour = 'short';
  const samples = render(processor, 60);
  assert.ok(samples.slice(-10 * BLOCK).every((sample) => Math.abs(sample - INPUT_LEVEL) < 1e-6));
});

test('an unknown fail mode is rejected at init and outputs silence', () => {
  const processor = createProcessor({ df: fakeDf(), failMode: 'loud' });
  const samples = render(processor, 4);
  assert.ok(samples.every((sample) => sample === 0));
  assert.match(errors(processor)[0].message, /failMode/);
});

test('ready reports the fail mode and the 1920-sample delay', () => {
  const processor = createProcessor({ df: fakeDf(), failMode: 'silence' });
  const ready = processor.messages.find((message) => message.type === 'ready');
  assert.equal(ready.failMode, 'silence');
  assert.equal(ready.latencySamples, 1920);
});
