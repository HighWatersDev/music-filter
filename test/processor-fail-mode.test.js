import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK,
  RESAMPLER_ONSET,
  TOTAL_DELAY,
  createProcessor,
  firstSoundAt,
  fakeEngines,
  isInput,
  isProcessed,
  messagesOf,
  render,
  send,
} from './helpers/fake-processor.js';

const errors = (processor) => messagesOf(processor, 'error');

function assertNeverInput(samples) {
  assert.ok(samples.every((sample) => Math.abs(sample) < 0.5), 'an input sample reached the output');
}

test('silence mode outputs zeros when init fails', () => {
  const processor = createProcessor({ engines: fakeEngines({ createError: new Error('bad model') }), failMode: 'silence' });
  const samples = render(processor, 20);
  assert.ok(samples.every((sample) => sample === 0));
  assert.deepEqual(errors(processor).map((m) => m.stage), ['init']);
});

test('without a fail mode the processor is silent when init fails', () => {
  const processor = createProcessor({ engines: fakeEngines({ createError: new Error('bad model') }) });
  assert.ok(render(processor, 20).every((sample) => sample === 0));
});

test('without a fail mode the processor never lets the input through after a throwing hop', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines });
  render(processor, 30);
  engines.behaviour = 'throw';
  assertNeverInput(render(processor, 60));
});

test('passthrough mode still passes the input through when init fails', () => {
  const processor = createProcessor({ engines: fakeEngines({ createError: new Error('bad model') }), failMode: 'passthrough' });
  const samples = render(processor, 4);
  assert.ok(samples.every(isInput));
});

test('a context that is not 48 kHz fails init', () => {
  const processor = createProcessor({ failMode: 'silence', sampleRate: 44100 });
  assert.match(errors(processor)[0].message, /48000/);
  assert.ok(render(processor, 4).every((sample) => sample === 0));
});

for (const behaviour of ['throw', 'nan']) {
  test(`silence mode goes silent after a ${behaviour} hop and reports it once`, () => {
    const engines = fakeEngines();
    const processor = createProcessor({ engines, failMode: 'silence' });
    const before = render(processor, 60);
    assert.ok(before.slice(-BLOCK).every(isProcessed), 'processed audio before the failure');

    engines.behaviour = behaviour;
    const after = render(processor, 60);
    assertNeverInput(after);
    assert.ok(after.slice(-20 * BLOCK).every((sample) => sample === 0), 'output settles on silence');
    assert.deepEqual(errors(processor).map((m) => m.stage), ['process']);
  });
}

test('silence mode stays silent if the model recovers after a failure', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  render(processor, 10);
  engines.behaviour = 'throw';
  render(processor, 10);
  engines.behaviour = 'ok';
  const samples = render(processor, 60);
  assert.ok(samples.slice(-10 * BLOCK).every((sample) => sample === 0));
});

test('passthrough mode falls back to the delayed input after a throwing hop', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'passthrough' });
  render(processor, 30);
  engines.behaviour = 'throw';
  const samples = render(processor, 60);
  assert.ok(samples.slice(-10 * BLOCK).every(isInput));
});

test('an unknown fail mode is rejected at init and outputs silence', () => {
  const processor = createProcessor({ failMode: 'loud' });
  const samples = render(processor, 4);
  assert.ok(samples.every((sample) => sample === 0));
  assert.match(errors(processor)[0].message, /failMode/);
});

test('ready reports the fail mode, the model and the 3165-sample delay', () => {
  const processor = createProcessor({ failMode: 'silence' });
  const [ready] = messagesOf(processor, 'ready');
  assert.equal(ready.failMode, 'silence');
  assert.equal(ready.model, 'dpdfnet4');
  assert.equal(ready.latencySamples, TOTAL_DELAY);
});

test('processed audio is aligned to the reported delay', () => {
  const processor = createProcessor({ failMode: 'silence' });
  const firstAudible = firstSoundAt(render(processor, Math.ceil(TOTAL_DELAY / BLOCK) + 20));
  assert.ok(firstAudible > TOTAL_DELAY - RESAMPLER_ONSET && firstAudible <= TOTAL_DELAY, `first output at ${firstAudible}`);
});

test('silence mode ignores bypass, so the input can never reach the output', () => {
  const processor = createProcessor({ failMode: 'silence' });
  render(processor, 30);
  send(processor, { type: 'bypass', value: true });
  assertNeverInput(render(processor, 60));
});

test('passthrough mode still honours bypass with the input delayed like the filter', () => {
  const processor = createProcessor({ failMode: 'passthrough' });
  render(processor, 60);
  send(processor, { type: 'bypass', value: true });
  const samples = render(processor, 30);
  assert.ok(samples.slice(-BLOCK).every(isInput));
});

test('while idle the processor outputs zeros without running the model', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  render(processor, 10);
  send(processor, { type: 'idle', value: true });
  const before = engines.hops;
  const samples = render(processor, 40);
  assert.equal(engines.hops, before);
  assert.ok(samples.every((sample) => sample === 0));
});

test('leaving idle resets the model and resumes with no audio left over from before', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  render(processor, 60);
  send(processor, { type: 'idle', value: true });
  render(processor, 10);
  const resets = engines.created[0].resets;
  send(processor, { type: 'idle', value: false });
  assert.equal(engines.created[0].resets, resets + 1);
  const before = engines.hops;
  const samples = render(processor, 60);
  assert.ok(engines.hops > before);
  const firstProcessed = firstSoundAt(samples);
  assert.ok(firstProcessed > TOTAL_DELAY - RESAMPLER_ONSET, `processed audio after ${firstProcessed} samples`);
  assert.ok(samples.slice(-BLOCK).every(isProcessed));
});

test('dispose frees the engine and ends the processor', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  render(processor, 10);
  send(processor, { type: 'dispose' });
  const before = engines.hops;
  const output = [new Float32Array(BLOCK).fill(1), new Float32Array(BLOCK).fill(1)];
  const input = [new Float32Array(BLOCK).fill(0.9), new Float32Array(BLOCK).fill(0.9)];
  assert.equal(processor.process([input], [output]), false);
  assert.ok(output.every((channel) => channel.every((sample) => sample === 0)));
  assert.equal(engines.hops, before);
  assert.equal(engines.created[0].freed, true);
});

test('a free that throws during dispose is reported and processing still ends', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  engines.freeError = new Error('double free');
  send(processor, { type: 'dispose' });
  assert.deepEqual(errors(processor).map((m) => m.stage), ['dispose']);
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  assert.equal(processor.process([input], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]]), false);
});
