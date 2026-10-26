import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadAheadFilters, nextReadAheadModel, windowRtf } from '../src/separator/read-ahead-filters.js';

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
const run = (filters, seconds, contextSeconds = 0) =>
  filters.filter(tone(seconds), tone(seconds), RATE, contextSeconds ? { contextBefore: [tone(contextSeconds), tone(contextSeconds)] } : {});

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

test('a slow first window switches later windows to DPDFNet-2 and only then loads its bytes', async () => {
  const fake = fakeRuntimes({ costMs: { dpdfnet4: 7, dpdfnet2: 3 } });
  const changes = [];
  const filters = createReadAheadFilters({
    instantiate: fake.instantiate,
    fetchModel: fake.fetchModel,
    now: fake.clock.now,
    onModelChange: (change) => changes.push(change),
  });
  await run(filters, 2);
  assert.deepEqual(fake.fetched, ['dpdfnet4']);
  assert.equal(filters.model, 'dpdfnet2');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].model, 'dpdfnet2');
  assert.ok(changes[0].rtf > 0.6, `rtf ${changes[0].rtf}`);
  assert.equal(fake.runtimes[0].engines[0].freed, true, 'DPDFNet-4 is freed');

  await run(filters, 2);
  assert.deepEqual(fake.fetched, ['dpdfnet4', 'dpdfnet2']);
  assert.equal(fake.runtimes[0].engines[1].model, 'dpdfnet2');
});

test('a fast first window keeps DPDFNet-4 and never loads DPDFNet-2', async () => {
  const fake = fakeRuntimes({ costMs: { dpdfnet4: 1, dpdfnet2: 1 } });
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  await run(filters, 2);
  await run(filters, 2);
  assert.equal(filters.model, 'dpdfnet4');
  assert.deepEqual(fake.fetched, ['dpdfnet4']);
});

test('only the first window is judged', async () => {
  const costMs = { dpdfnet4: 1, dpdfnet2: 1 };
  const fake = fakeRuntimes({ costMs });
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  await run(filters, 2);
  costMs.dpdfnet4 = 9;
  await run(filters, 2);
  assert.equal(filters.model, 'dpdfnet4');
});

test('the context counts toward the audio duration of the first window', async () => {
  const fake = fakeRuntimes({ costMs: { dpdfnet4: 4, dpdfnet2: 1 } });
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  await run(filters, 1, 1);
  assert.equal(filters.model, 'dpdfnet4', 'about 0.4 of real time over the window and its context');
});

test('after a switch to DPDFNet-2 a fresh instance after an error keeps DPDFNet-2', async () => {
  const fake = fakeRuntimes({ costMs: { dpdfnet4: 7, dpdfnet2: 3 } });
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  await run(filters, 2);
  fake.runtimes[0].createEngine = () => {
    throw new Error('unreachable executed');
  };
  await assert.rejects(run(filters, 2), /unreachable/);
  await run(filters, 2);
  assert.equal(fake.runtimes.length, 2);
  assert.deepEqual(fake.runtimes[1].engines.map((engine) => engine.model), ['dpdfnet2']);
});

test('loading is reported only while the current model has no engine yet', async () => {
  const fake = fakeRuntimes();
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  assert.equal(filters.isLoading, true);
  await filters.load();
  assert.equal(filters.isLoading, false);
});
