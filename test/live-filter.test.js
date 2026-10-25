import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveFilter, createOverloadMonitor, selectFilterMode } from '../src/content/live-filter.js';

class FakeVideo extends EventTarget {
  muted = false;
  volume = 0.7;
  readyState = 1;
}

function fakeParam(value) {
  const param = {
    value,
    cancelScheduledValues() {},
    setValueAtTime: (next) => (param.value = next),
    linearRampToValueAtTime: (next) => (param.value = next),
  };
  return param;
}

function fakeNode(name) {
  const node = {
    name,
    connections: new Set(),
    connect(target) {
      node.connections.add(target);
      return target;
    },
    disconnect(target) {
      if (target) node.connections.delete(target);
      else node.connections.clear();
    },
  };
  return node;
}

function fakeContext() {
  const context = {
    state: 'running',
    currentTime: 1,
    destination: fakeNode('destination'),
    gains: [],
    sources: new Map(),
    resume: async () => {},
    createGain() {
      const gain = fakeNode(`gain${context.gains.length}`);
      gain.gain = fakeParam(1);
      context.gains.push(gain);
      return gain;
    },
    createMediaElementSource(video) {
      const source = fakeNode('source');
      context.sources.set(video, source);
      return source;
    },
  };
  return context;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ failToCreate = null } = {}) {
  const context = fakeContext();
  const filterNode = fakeNode('worklet');
  let onMessage;
  let resolveNode;
  let rejectNode;
  const views = [];
  const filter = createLiveFilter({
    createContext: () => context,
    createFilterNode: (_context, handler) => {
      onMessage = handler;
      return new Promise((resolve, reject) => {
        resolveNode = () => resolve(filterNode);
        rejectNode = reject;
        if (failToCreate) reject(failToCreate);
      });
    },
    onChange: (view) => views.push(view),
  });
  return {
    context,
    filter,
    filterNode,
    views,
    post: (message) => onMessage(message),
    ready: async () => {
      await flush();
      resolveNode();
      await flush();
    },
    reject: async (error) => {
      rejectNode(error);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const originalGainOf = (context) => context.gains[0];
const filterOutputOf = (context, filterNode) => [...filterNode.connections][0];
const originalLevels = (views) => [...new Set(views.filter((v) => v.state !== 'off').map((v) => v.originalLevel))];

test('mode selection uses read-ahead only on Safari', () => {
  assert.equal(selectFilterMode({ vendor: 'Apple Computer, Inc.', hostname: 'www.youtube.com' }), 'read-ahead');
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'www.youtube.com' }), 'live');
  assert.equal(selectFilterMode({ vendor: '', hostname: 'www.youtube.com' }), 'live');
});

test('the mode override only applies on localhost and only with a known mode', () => {
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'localhost', override: 'read-ahead' }), 'read-ahead');
  assert.equal(selectFilterMode({ vendor: 'Apple Computer, Inc.', hostname: 'localhost', override: 'live' }), 'live');
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'www.youtube.com', override: 'read-ahead' }), 'live');
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'localhost', override: 'fast' }), 'live');
});

test('the overload monitor needs 5 s of frames before it judges', () => {
  const monitor = createOverloadMonitor();
  for (let i = 0; i < 4; i++) assert.equal(monitor.record({ count: 100, overTwoQuanta: 50 }), false);
  assert.equal(monitor.record({ count: 100, overTwoQuanta: 50 }), true);
});

test('the overload monitor trips above 5% over the last 5 s only', () => {
  const monitor = createOverloadMonitor();
  for (let i = 0; i < 5; i++) assert.equal(monitor.record({ count: 100, overTwoQuanta: 5 }), false);
  assert.equal(monitor.record({ count: 100, overTwoQuanta: 6 }), true);
  for (let i = 0; i < 5; i++) monitor.record({ count: 100, overTwoQuanta: 0 });
  assert.equal(monitor.record({ count: 100, overTwoQuanta: 20 }), false);
  monitor.reset();
  assert.equal(monitor.record({ count: 100, overTwoQuanta: 100 }), false);
});

test('while starting, the original is muted and nothing reaches the output', async () => {
  const { context, filter, views } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  assert.equal(originalGainOf(context).gain.value, 0);
  assert.equal(views.at(-1).state, 'starting');
  assert.equal(context.sources.get(video).connections.size, 1);
});

test('once ready, the element feeds only the worklet and the original stays at 0', async () => {
  const { context, filter, filterNode, views, ready } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();

  const source = context.sources.get(video);
  const original = originalGainOf(context);
  assert.deepEqual([...source.connections], [original, filterNode]);
  assert.equal(original.gain.value, 0);
  const output = filterOutputOf(context, filterNode);
  assert.equal(output.gain.value, 1);
  assert.ok(output.connections.has(context.destination));
  assert.equal(views.at(-1).state, 'filtered');
  assert.equal(views.at(-1).detail, 'live, 40 ms delay');
  assert.deepEqual(originalLevels(views), [0]);
});

test('turning the filter off routes the original back at 1 and silences the worklet', async () => {
  const { context, filter, filterNode, views, ready } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  filter.setEnabled(false);

  const source = context.sources.get(video);
  assert.deepEqual([...source.connections], [originalGainOf(context)]);
  assert.equal(originalGainOf(context).gain.value, 1);
  assert.equal(filterOutputOf(context, filterNode).gain.value, 0);
  assert.equal(views.at(-1).state, 'off');
  assert.equal(views.at(-1).originalLevel, 1);
});

test('turning it back on reuses the element source and the worklet', async () => {
  const { context, filter, filterNode, ready } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  filter.setEnabled(false);
  filter.setEnabled(true, video);
  await ready();

  assert.equal(context.sources.size, 1);
  assert.equal(originalGainOf(context).gain.value, 0);
  assert.ok(context.sources.get(video).connections.has(filterNode));
  assert.equal(filterOutputOf(context, filterNode).gain.value, 1);
});

test('a processor error mutes everything and shows the message', async () => {
  const { context, filter, filterNode, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  post({ type: 'error', stage: 'process', message: 'boom' });

  assert.equal(originalGainOf(context).gain.value, 0);
  assert.equal(filterOutputOf(context, filterNode)?.gain.value ?? 0, 0);
  assert.equal(views.at(-1).state, 'error');
  assert.match(views.at(-1).detail, /boom/);
  assert.deepEqual(originalLevels(views), [0]);
});

test('a worklet that fails to load mutes and shows the message', async () => {
  const { context, filter, views } = setup({ failToCreate: new Error('addModule failed') });
  filter.setEnabled(true, new FakeVideo());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(originalGainOf(context).gain.value, 0);
  assert.equal(views.at(-1).state, 'error');
  assert.match(views.at(-1).detail, /addModule failed/);
});

test('an element that cannot be routed fails closed with the element muted', () => {
  const { context, filter, views } = setup();
  context.createMediaElementSource = () => {
    throw new Error('InvalidStateError');
  };
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  assert.equal(video.muted, true);
  assert.equal(views.at(-1).state, 'error');
});

test('an overloaded device mutes and says so instead of playing the original', async () => {
  const { context, filter, filterNode, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  for (let i = 0; i < 5; i++) {
    post({ type: 'stats', count: 100, overQuantum: 60, overTwoQuanta: 10, meanMs: 4, p95Ms: 6, maxMs: 9 });
  }

  assert.equal(views.at(-1).state, 'too-slow');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 0);
  assert.equal(originalGainOf(context).gain.value, 0);
});

test('frames just over one render quantum do not count as overload', async () => {
  const { filter, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  for (let i = 0; i < 10; i++) {
    post({ type: 'stats', count: 100, overQuantum: 20, overTwoQuanta: 1, meanMs: 1.6, p95Ms: 3, maxMs: 12 });
  }
  assert.equal(views.at(-1).state, 'filtered');
});

test('stats are summarised for the panel', async () => {
  const { filter, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  post({ type: 'stats', count: 100, overQuantum: 1, overTwoQuanta: 1, overBudget: 0, meanMs: 1, p95Ms: 2, maxMs: 3 });
  post({ type: 'stats', count: 100, overQuantum: 0, overTwoQuanta: 0, overBudget: 0, meanMs: 2, p95Ms: 1, maxMs: 5 });
  assert.deepEqual(views.at(-1).stats, {
    frames: 200,
    meanMs: 1.5,
    worstP95Ms: 2,
    worstMaxMs: 5,
    overQuantum: 1,
    overTwoQuanta: 1,
    overBudget: 0,
  });
});

test('a new element is attached through the registry and replaces the old feed', async () => {
  const { context, filter, filterNode, ready } = setup();
  const first = new FakeVideo();
  const second = new FakeVideo();
  filter.setEnabled(true, first);
  await ready();
  filter.attach(second);

  assert.ok(!context.sources.get(first).connections.has(filterNode));
  assert.ok(context.sources.get(second).connections.has(filterNode));
  const output = filterOutputOf(context, filterNode);
  const originals = context.gains.filter((gain) => gain !== output);
  assert.equal(originals.length, 2);
  assert.ok(originals.every((gain) => gain.gain.value === 0));
});

test('attaching the same element again does not create a second source', async () => {
  const { context, filter, ready } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  filter.attach(video);
  filter.attach(video);
  assert.equal(context.sources.size, 1);
});

test('an element without metadata is fed to the worklet once it routes', async () => {
  const { context, filter, filterNode, views, ready } = setup();
  const video = new FakeVideo();
  video.readyState = 0;
  filter.setEnabled(true, video);
  await ready();
  assert.equal(views.at(-1).state, 'starting');

  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.ok(context.sources.get(video).connections.has(filterNode));
  assert.equal(views.at(-1).state, 'filtered');
});

test('a retry after a processor error builds a fresh worklet', async () => {
  const { filter, views, ready, post } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  post({ type: 'error', stage: 'process', message: 'boom' });
  filter.setEnabled(false);
  filter.setEnabled(true, video);
  assert.equal(views.at(-1).state, 'starting');
  await ready();
  assert.equal(views.at(-1).state, 'filtered');
});
