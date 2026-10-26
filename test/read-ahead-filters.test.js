import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadAheadFilters } from '../src/separator/read-ahead-filters.js';

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

test('loading is reported only while the current model has no engine yet', async () => {
  const fake = fakeRuntimes();
  const filters = createReadAheadFilters({ instantiate: fake.instantiate, fetchModel: fake.fetchModel, now: fake.clock.now });
  assert.equal(filters.isLoading, true);
  await filters.load();
  assert.equal(filters.isLoading, false);
});
