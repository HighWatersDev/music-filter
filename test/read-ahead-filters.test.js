import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPolicy, createReadAheadFilters, nextReadAheadModel, windowRtf } from '../src/separator/read-ahead-filters.js';

const RATE = 48000;
const HOP = 160;

function fakeRuntimes({ costMs = { dpdfnet4: 0.2, dpdfnet2: 0.1 }, poisoned = new Set() } = {}) {
  const clock = { time: 0, now: () => clock.time };
  const runtimes = [];
  const fetched = [];
  const instantiate = async () => {
    const runtime = { id: runtimes.length + 1, engines: [] };
    runtime.createEngine = (bytes) => {
      const model = new TextDecoder().decode(bytes);
      const engine = {
        model,
        hop: HOP,
        hops: 0,
        freed: false,
        processHop(input, output) {
          if (poisoned.has(runtime.id)) throw new Error('recursive use of an object detected');
          engine.hops += 1;
          clock.time += costMs[model];
          output.set(input);
        },
        reset() {},
        free() {
          engine.freed = true;
        },
      };
      runtime.engines.push(engine);
      return engine;
    };
    runtimes.push(runtime);
    return runtime;
  };
  const fetchModel = async (name) => {
    fetched.push(name);
    return new TextEncoder().encode(name);
  };
  return { clock, runtimes, fetched, instantiate, fetchModel };
}

const tone = (seconds) => Float32Array.from({ length: seconds * RATE }, (_, i) => 0.1 * Math.sin(i / 10));
const run = (filters, seconds, model = 'dpdfnet4') => filters.filter(tone(seconds), tone(seconds), RATE, { model });

test('the RTF of a window counts the context it warmed up on', () => {
  assert.equal(windowRtf({ computeMs: 700, samples: 2 * RATE, sampleRate: RATE }), 0.35);
});

test('read-ahead moves to DPDFNet-2 only when DPDFNet-4 runs above 0.6 of real time', () => {
  assert.equal(nextReadAheadModel({ model: 'dpdfnet4', rtf: 0.61 }), 'dpdfnet2');
  assert.equal(nextReadAheadModel({ model: 'dpdfnet4', rtf: 0.6 }), 'dpdfnet4');
  assert.equal(nextReadAheadModel({ model: 'dpdfnet4', rtf: 0.29 }), 'dpdfnet4');
  assert.equal(nextReadAheadModel({ model: 'dpdfnet2', rtf: 3 }), 'dpdfnet2');
});

test('a filter error drops the wasm instance and the next window runs on a fresh one', async () => {
  const fake = fakeRuntimes({ poisoned: new Set([1]) });
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  await assert.rejects(run(filters, 1), /recursive use/);
  const [left] = await run(filters, 1);
  assert.equal(left.length, RATE);
  assert.equal(fake.runtimes.length, 2);
  assert.equal(fake.runtimes[1].engines[0].model, 'dpdfnet4');
  assert.ok(fake.runtimes[1].engines[0].hops > 0);
});

test('without an error the instance and the engine are reused across windows', async () => {
  const fake = fakeRuntimes();
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  await run(filters, 1);
  await run(filters, 1);
  assert.equal(fake.runtimes.length, 1);
  assert.equal(fake.runtimes[0].engines.length, 1);
});

test('a request for another model frees the current engine and only then loads the new bytes', async () => {
  const fake = fakeRuntimes();
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel });
  await run(filters, 2);
  assert.deepEqual(fake.fetched, ['dpdfnet4']);
  await run(filters, 2, 'dpdfnet2');
  assert.deepEqual(fake.fetched, ['dpdfnet4', 'dpdfnet2']);
  assert.equal(fake.runtimes[0].engines[0].freed, true, 'DPDFNet-4 is freed');
  assert.equal(fake.runtimes[0].engines[1].model, 'dpdfnet2');
  assert.ok(fake.runtimes[0].engines[1].hops > 0);
});

test('a fresh instance after an error builds only the model that was asked for', async () => {
  const poisoned = new Set();
  const fake = fakeRuntimes({ poisoned });
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel });
  await run(filters, 2, 'dpdfnet2');
  poisoned.add(1);
  await assert.rejects(run(filters, 2, 'dpdfnet2'), /recursive use/);
  await run(filters, 2, 'dpdfnet2');
  assert.equal(fake.runtimes.length, 2);
  assert.deepEqual(fake.runtimes[1].engines.map((engine) => engine.model), ['dpdfnet2']);
});

test('load prepares a model before the first window', async () => {
  const fake = fakeRuntimes();
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel });
  await filters.load('dpdfnet4');
  assert.deepEqual(fake.fetched, ['dpdfnet4']);
  await run(filters, 1);
  assert.equal(fake.runtimes[0].engines.length, 1);
});

const observed = (seconds, computeSeconds, model = 'dpdfnet4', isWarm = true) => ({
  model,
  isWarm,
  computeMs: computeSeconds * 1000,
  samples: seconds * RATE,
  sampleRate: RATE,
});

test('the model policy judges the first window of at least 5 s, counting its context', () => {
  const changes = [];
  const policy = createModelPolicy({ workers: 1, onModelChange: (change) => changes.push(change) });
  policy.observe(observed(2, 3.5));
  assert.equal(policy.model, 'dpdfnet4', 'a cold 2 s first window is not judged');
  policy.observe(observed(11, 7.7));
  assert.equal(policy.model, 'dpdfnet2');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].model, 'dpdfnet2');
  assert.ok(Math.abs(changes[0].rtf - 0.7) < 1e-9);
});

test('the model policy divides the RTF by the number of workers', () => {
  const shared = createModelPolicy({ workers: 3 });
  shared.observe(observed(11, 11 * 0.9));
  assert.equal(shared.model, 'dpdfnet4');
  const alone = createModelPolicy({ workers: 1 });
  alone.observe(observed(11, 11 * 0.9));
  assert.equal(alone.model, 'dpdfnet2');
});

test('only the first judged window counts, and windows from another model are ignored', () => {
  const policy = createModelPolicy({ workers: 1 });
  policy.observe(observed(11, 20, 'dpdfnet2'));
  assert.equal(policy.model, 'dpdfnet4');
  policy.observe(observed(11, 3));
  policy.observe(observed(11, 20));
  assert.equal(policy.model, 'dpdfnet4');
});

test('a cold call into a fresh instance is never judged', () => {
  const policy = createModelPolicy({ workers: 1 });
  policy.observe(observed(11, 20, 'dpdfnet4', false));
  assert.equal(policy.model, 'dpdfnet4');
  policy.observe(observed(11, 3));
  assert.equal(policy.model, 'dpdfnet4');
});

test('one window slower than real time moves to DPDFNet-2 however many workers share the load', () => {
  const policy = createModelPolicy({ workers: 3 });
  policy.observe(observed(11, 11 * 1.2));
  assert.equal(policy.model, 'dpdfnet2');
});

test('a model load that arrives during a window does not delay it or get thrown away', async () => {
  const fake = fakeRuntimes();
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel });
  await run(filters, 1);
  const loading = filters.load('dpdfnet2');
  await run(filters, 1);
  await loading;
  await run(filters, 1, 'dpdfnet2');
  assert.deepEqual(fake.fetched, ['dpdfnet4', 'dpdfnet2']);
});
