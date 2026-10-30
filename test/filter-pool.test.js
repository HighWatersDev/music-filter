import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilterPool } from '../src/separator/filter-pool.js';

function fakeWorkers(count, respond) {
  const seen = [];
  const ports = Array.from({ length: count }, (_, index) => {
    const { port1, port2 } = new MessageChannel();
    port2.onmessage = ({ data }) => {
      seen.push({ index, ...data });
      if (data.type === 'filter') respond(port2, data, index);
    };
    return { port: port1, close: () => (port1.close(), port2.close()) };
  });
  return { seen, ports: ports.map(({ port }) => port), close: () => ports.forEach(({ close }) => close()) };
}

async function waitUntil(isDone) {
  for (let i = 0; i < 200 && !isDone(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(isDone(), 'condition never became true');
}

const request = (n) => ({ model: 'dpdfnet4', sampleRate: 48000, left: new Float32Array([n]), right: new Float32Array([n]) });

test('requests go to idle workers, and a finished worker takes the next request', async () => {
  const held = [];
  const workers = fakeWorkers(2, (port, data, index) => held.push(() => port.postMessage({ type: 'filtered', id: data.id, left: data.left, right: data.right, computeMs: 5 + index })));
  const pool = createFilterPool(workers.ports);
  assert.equal(pool.size, 2);
  const first = pool.run(request(1));
  const second = pool.run(request(2));
  await waitUntil(() => workers.seen.length === 2);
  assert.deepEqual(workers.seen.map((m) => m.index), [0, 1]);
  held[1]();
  const done = await second;
  assert.equal(done.left[0], 2);
  assert.equal(done.computeMs, 6);
  const third = pool.run(request(3));
  await waitUntil(() => workers.seen.length === 3);
  assert.equal(workers.seen.at(-1).index, 1, 'the worker that finished takes the third request');
  held[0]();
  held[2]();
  await Promise.all([first, third]);
  workers.close();
});

test('a worker error rejects only its own request and the worker stays usable', async () => {
  let fail = true;
  const workers = fakeWorkers(1, (port, data) =>
    port.postMessage(fail ? { type: 'error', id: data.id, message: 'recursive use of an object' } : { type: 'filtered', id: data.id, left: data.left, right: data.right, computeMs: 1 }),
  );
  const pool = createFilterPool(workers.ports);
  await assert.rejects(pool.run(request(1)), /recursive use/);
  fail = false;
  assert.equal((await pool.run(request(2))).left[0], 2);
  workers.close();
});

test('load reaches every worker', async () => {
  const workers = fakeWorkers(3, () => {});
  createFilterPool(workers.ports).load('dpdfnet2');
  await waitUntil(() => workers.seen.length === 3);
  assert.deepEqual(workers.seen.map((m) => [m.index, m.type, m.model]), [[0, 'load', 'dpdfnet2'], [1, 'load', 'dpdfnet2'], [2, 'load', 'dpdfnet2']]);
  workers.close();
});

test('the pool size follows the core count: 3 on 6 or more, 2 on 4, 1 on 2 or fewer', async () => {
  const { filterWorkerCount } = await import('../src/separator/filter-pool.js');
  assert.deepEqual([1, 2, 3, 4, 6, 8, 12, undefined].map((cores) => filterWorkerCount(cores)), [1, 1, 1, 2, 3, 3, 3, 1]);
  assert.equal(filterWorkerCount(8, { isSafari: true }), 2, 'Safari stays at 2 until memory is measured on a device');
});

test('a request that never gets a reply rejects after the timeout and its worker is retired', async () => {
  const workers = fakeWorkers(2, (port, data, index) => {
    if (index === 1) port.postMessage({ type: 'filtered', id: data.id, left: data.left, right: data.right, computeMs: 1 });
  });
  const pool = createFilterPool(workers.ports, { timeoutMs: 30 });
  await assert.rejects(pool.run(request(1)), /did not answer/);
  assert.equal(pool.size, 1);
  assert.equal((await pool.run(request(2))).left[0], 2);
  workers.close();
});
