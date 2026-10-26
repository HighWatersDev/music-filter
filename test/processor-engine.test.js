import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK,
  RESAMPLER_ONSET,
  TOTAL_DELAY,
  createProcessor,
  fakeEngines,
  firstSoundAt,
  isProcessed,
  messagesOf,
  render,
  send,
} from './helpers/fake-processor.js';

const SLOW_DPDFNET4 = { dpdfnet4: 2.25, dpdfnet2: 1.375 };

test('the processor initialises the wasm from the module it was given', () => {
  const engines = fakeEngines();
  createProcessor({ engines, failMode: 'silence' });
  assert.deepEqual(engines.initCalls, ['wasm-module']);
});

test('a fast device keeps DPDFNet-4 and reports its warm-up mean', () => {
  const engines = fakeEngines({ costs: { dpdfnet4: 1.25, dpdfnet2: 1 } });
  const processor = createProcessor({ engines, failMode: 'silence' });
  const [ready] = messagesOf(processor, 'ready');
  assert.equal(ready.model, 'dpdfnet4');
  assert.deepEqual(ready.warmupMs, { dpdfnet4: 1.25 });
  assert.deepEqual(engines.created.map((engine) => engine.model), ['dpdfnet4']);
  assert.equal(engines.created[0].resets, 1, 'reset after warm-up');
});

test('a slower device falls back to DPDFNet-2 and frees DPDFNet-4', () => {
  const engines = fakeEngines({ costs: SLOW_DPDFNET4 });
  const processor = createProcessor({ engines, failMode: 'silence' });
  const [ready] = messagesOf(processor, 'ready');
  assert.equal(ready.model, 'dpdfnet2');
  assert.deepEqual(ready.warmupMs, SLOW_DPDFNET4);
  assert.deepEqual(engines.created.map((engine) => [engine.model, engine.freed]), [
    ['dpdfnet4', true],
    ['dpdfnet2', false],
  ]);
  assert.ok(render(processor, 60).slice(-BLOCK).every(isProcessed));
});

test('a device too slow for DPDFNet-2 reports too-slow instead of ready and stays silent', () => {
  const engines = fakeEngines({ costs: { dpdfnet4: 3, dpdfnet2: 2.5 } });
  const processor = createProcessor({ engines, failMode: 'silence' });
  assert.deepEqual(messagesOf(processor, 'ready'), []);
  const [tooSlow] = messagesOf(processor, 'too-slow');
  assert.deepEqual(tooSlow.warmupMs, { dpdfnet4: 3, dpdfnet2: 2.5 });
  assert.ok(engines.created.every((engine) => engine.freed));
  assert.ok(render(processor, 60).every((sample) => sample === 0));
});

test('missing model bytes fail init', () => {
  const processor = createProcessor({ failMode: 'silence', options: { models: {} } });
  assert.match(messagesOf(processor, 'error')[0].message, /dpdfnet4/);
});

test('use-model switches from DPDFNet-4 to DPDFNet-2 with fresh, silent buffers', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  assert.ok(render(processor, 60).slice(-BLOCK).every(isProcessed));

  send(processor, { type: 'use-model', model: 'dpdfnet2' });
  const [first, second] = engines.created;
  assert.equal(first.freed, true);
  assert.equal(second.model, 'dpdfnet2');
  const [switched] = messagesOf(processor, 'model');
  assert.equal(switched.model, 'dpdfnet2');
  assert.equal(switched.latencySamples, TOTAL_DELAY);
  assert.deepEqual(switched.warmupMs, { dpdfnet2: 1 });

  const after = render(processor, 60);
  const firstProcessed = firstSoundAt(after);
  assert.ok(firstProcessed > TOTAL_DELAY - RESAMPLER_ONSET, `old audio leaked after the switch at ${firstProcessed}`);
  assert.ok(after.slice(-BLOCK).every(isProcessed));
});

test('a switch to a DPDFNet-2 that is too slow reports too-slow and goes silent', () => {
  const engines = fakeEngines({ costs: { dpdfnet4: 1, dpdfnet2: 2.5 } });
  const processor = createProcessor({ engines, failMode: 'silence' });
  render(processor, 60);
  send(processor, { type: 'use-model', model: 'dpdfnet2' });
  assert.equal(messagesOf(processor, 'too-slow').length, 1);
  assert.ok(engines.created.every((engine) => engine.freed));
  assert.ok(render(processor, 40).every((sample) => sample === 0));
});

test('use-model for the model already running does nothing', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  send(processor, { type: 'use-model', model: 'dpdfnet4' });
  assert.equal(engines.created.length, 1);
  assert.deepEqual(messagesOf(processor, 'model'), []);
});

test('a switch that fails is reported as an error and leaves silence', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence', options: { models: { dpdfnet4: new TextEncoder().encode('dpdfnet4').buffer } } });
  render(processor, 30);
  send(processor, { type: 'use-model', model: 'dpdfnet2' });
  assert.deepEqual(messagesOf(processor, 'error').map((m) => m.stage), ['switch']);
  assert.ok(render(processor, 40).every((sample) => sample === 0));
});

test('hop timings are reported every 100 hops against a 10 ms budget', () => {
  const engines = fakeEngines();
  const processor = createProcessor({ engines, failMode: 'silence' });
  render(processor, Math.ceil((100 * 480) / BLOCK) + 1);
  const [stats] = messagesOf(processor, 'stats');
  assert.equal(stats.count, 100);
  assert.equal(stats.meanMs, 1);
  assert.equal(stats.budgetMs, 10);
  assert.equal(stats.model, 'dpdfnet4');
});
