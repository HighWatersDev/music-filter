import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import {
  createLiveFilter,
  createOverloadMonitor,
  createWithWasmFallback,
  liveDetail,
  liveModelPlan,
  modelOverride,
  overloadAction,
  pickFeedVideo,
  selectFilterMode,
  tooSlowError,
} from '../src/content/live-filter.js';

class FakeVideo extends EventTarget {
  muted = false;
  volume = 0.7;
  readyState = 1;
  paused = false;
  ended = false;
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
    port: { messages: [], postMessage: (message) => node.port.messages.push(message) },
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
    sampleRate: 48000,
    outputLatency: 0.01,
    destination: fakeNode('destination'),
    gains: [],
    sources: new Map(),
    audioCalls: [],
    async suspend() {
      context.audioCalls.push('suspend');
      context.state = 'suspended';
    },
    async resume() {
      context.audioCalls.push('resume');
      context.state = 'running';
    },
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

const TOTAL_DELAY = 3165;

function setup({
  failToCreate = null,
  createContext = null,
  model = 'dpdfnet4',
  isPinned = false,
  switchTimeoutMs,
} = {}) {
  const context = fakeContext();
  const filterNode = fakeNode('worklet');
  let onMessage;
  let resolveNode;
  let rejectNode;
  const views = [];
  const builds = [];
  const preparations = [];
  const filter = createLiveFilter({
    createContext: createContext ?? (() => context),
    prepareFilter: async (_context, request) => {
      preparations.push(request);
      return { prepared: preparations.length };
    },
    createFilterNode: (_context, handler, prepared) => {
      onMessage = handler;
      builds.push({ contextState: context.state, prepared });
      return new Promise((resolve, reject) => {
        resolveNode = () =>
          resolve({
            node: filterNode,
            ready: {
              type: 'ready',
              model,
              isPinned,
              wasmSource: 'bytes',
              latencySamples: TOTAL_DELAY,
              warmupMs: { [model]: 1.25 },
              heldModels: [],
              wasmMemoryBytes: 65536,
            },
          });
        rejectNode = reject;
        if (failToCreate) reject(failToCreate);
      });
    },
    onChange: (view) => views.push(view),
    switchTimeoutMs,
  });
  return {
    context,
    filter,
    filterNode,
    views,
    builds,
    preparations,
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

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
};
const mode = (vendor, userAgent, extra = {}) => selectFilterMode({ vendor, userAgent, hostname: 'www.youtube.com', ...extra });

test('mode selection uses read-ahead on Safari and live on desktop Chrome and Firefox', () => {
  assert.equal(mode('Apple Computer, Inc.', UA.safariIphone), 'read-ahead');
  assert.equal(mode('Google Inc.', UA.chromeMac), 'live');
  assert.equal(mode('', UA.firefoxMac), 'live');
  assert.equal(mode('', undefined), 'live');
});

test('mode selection uses read-ahead on Firefox for Android but live on Chrome for Android', () => {
  assert.equal(mode('', UA.firefoxAndroid), 'read-ahead');
  assert.equal(mode('Google Inc.', UA.chromeAndroid), 'live');
});

test('the localhost override also applies on Firefox for Android', () => {
  assert.equal(mode('', UA.firefoxAndroid, { hostname: 'localhost', override: 'live' }), 'live');
});

test('a trip on DPDFNet-4 switches to DPDFNet-2, and a trip on DPDFNet-2 is too slow', () => {
  assert.equal(overloadAction({ model: 'dpdfnet4', isOverloaded: true }), 'switch');
  assert.equal(overloadAction({ model: 'dpdfnet2', isOverloaded: true }), 'too-slow');
  assert.equal(overloadAction({ model: 'dpdfnet4', isOverloaded: false }), 'none');
  assert.equal(overloadAction({ model: 'dpdfnet2', isOverloaded: false }), 'none');
});

test('a pinned model is never switched, so an overload on it is too slow', () => {
  assert.equal(overloadAction({ model: 'dpdfnet4', isPinned: true, isOverloaded: true }), 'too-slow');
  assert.equal(overloadAction({ model: 'dpdfnet4', isPinned: true, isOverloaded: false }), 'none');
});

test('the model override only applies on localhost and only with a known model', () => {
  assert.equal(modelOverride({ hostname: 'localhost', override: 'dpdfnet2' }), 'dpdfnet2');
  assert.equal(modelOverride({ hostname: 'localhost', override: 'dpdfnet4' }), 'dpdfnet4');
  assert.equal(modelOverride({ hostname: 'www.youtube.com', override: 'dpdfnet2' }), null);
  assert.equal(modelOverride({ hostname: 'localhost', override: 'dfn3' }), null);
  assert.equal(modelOverride({ hostname: 'localhost', override: null }), null);
});

test('the live detail names the model and the engine plus output delay', () => {
  assert.equal(
    liveDetail({ model: 'dpdfnet4', latencySamples: 3165, sampleRate: 48000, outputLatency: 0.01 }),
    'live, DPDFNet-4, 76 ms delay',
  );
  assert.equal(liveDetail({ model: 'dpdfnet2', latencySamples: 3165, sampleRate: 48000 }), 'live, DPDFNet-2, 66 ms delay');
  assert.equal(liveDetail({ model: null }), 'live');
});

test('the mode override only applies on localhost and only with a known mode', () => {
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'localhost', override: 'read-ahead' }), 'read-ahead');
  assert.equal(selectFilterMode({ vendor: 'Apple Computer, Inc.', hostname: 'localhost', override: 'live' }), 'live');
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'www.youtube.com', override: 'read-ahead' }), 'live');
  assert.equal(selectFilterMode({ vendor: 'Google Inc.', hostname: 'localhost', override: 'fast' }), 'live');
});

const BAD_WINDOW = [100, 100, 100, 100, 100].map(() => ({ count: 100, overTwoQuanta: 6 }));
const CLEAN_WINDOW = [100, 100, 100, 100, 100].map(() => ({ count: 100, overTwoQuanta: 5 }));
const recordWindow = (monitor, window) => window.map((stats) => monitor.record(stats)).at(-1);

test('the overload monitor judges whole 5 s windows only', () => {
  const monitor = createOverloadMonitor({ tripWindows: 1 });
  for (let i = 0; i < 4; i++) assert.equal(monitor.record({ count: 100, overTwoQuanta: 50 }), false);
  assert.equal(monitor.record({ count: 100, overTwoQuanta: 50 }), true);
});

test('the overload monitor needs 3 bad windows in a row to trip', () => {
  const monitor = createOverloadMonitor();
  assert.equal(recordWindow(monitor, BAD_WINDOW), false);
  assert.equal(recordWindow(monitor, BAD_WINDOW), false);
  assert.equal(recordWindow(monitor, CLEAN_WINDOW), false);
  assert.equal(recordWindow(monitor, BAD_WINDOW), false);
  assert.equal(recordWindow(monitor, BAD_WINDOW), false);
  assert.equal(recordWindow(monitor, BAD_WINDOW), true);
});

test('the overload monitor clears after 3 clean windows in a row', () => {
  const monitor = createOverloadMonitor();
  for (let i = 0; i < 3; i++) recordWindow(monitor, BAD_WINDOW);
  assert.equal(recordWindow(monitor, CLEAN_WINDOW), true);
  assert.equal(recordWindow(monitor, CLEAN_WINDOW), true);
  assert.equal(recordWindow(monitor, BAD_WINDOW), true);
  assert.equal(recordWindow(monitor, CLEAN_WINDOW), true);
  assert.equal(recordWindow(monitor, CLEAN_WINDOW), true);
  assert.equal(recordWindow(monitor, CLEAN_WINDOW), false);
});

test('a reset forgets the overload state', () => {
  const monitor = createOverloadMonitor();
  for (let i = 0; i < 3; i++) recordWindow(monitor, BAD_WINDOW);
  monitor.reset();
  assert.equal(recordWindow(monitor, BAD_WINDOW), false);
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
  assert.equal(views.at(-1).detail, 'live, DPDFNet-4, 76 ms delay');
  assert.equal(views.at(-1).model, 'dpdfnet4');
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

const slowStats = { type: 'stats', count: 100, overQuantum: 60, overTwoQuanta: 10, meanMs: 4, p95Ms: 6, maxMs: 9 };
const fastStats = { type: 'stats', count: 100, overQuantum: 0, overTwoQuanta: 0, meanMs: 1, p95Ms: 2, maxMs: 3 };

test('an overloaded device on DPDFNet-2 mutes and says so instead of playing the original', async () => {
  const { context, filter, filterNode, views, ready, post } = setup({ model: 'dpdfnet2' });
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  for (let i = 0; i < 10; i++) post(slowStats);
  assert.equal(views.at(-1).state, 'filtered', 'two slow windows are not enough');
  for (let i = 0; i < 5; i++) post(slowStats);

  assert.equal(views.at(-1).state, 'too-slow');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 0);
  assert.equal(originalGainOf(context).gain.value, 0);
  assert.ok(context.sources.get(video).connections.has(filterNode), 'the worklet keeps running to measure recovery');
  assert.notDeepEqual(filterNode.port.messages.at(-1), { type: 'idle', value: true });
});

test('an overloaded device on DPDFNet-2 recovers after 15 s of clean frames', async () => {
  const { context, filter, filterNode, views, ready, post } = setup({ model: 'dpdfnet2' });
  filter.setEnabled(true, new FakeVideo());
  await ready();
  for (let i = 0; i < 15; i++) post(slowStats);
  for (let i = 0; i < 10; i++) post(fastStats);
  assert.equal(views.at(-1).state, 'too-slow');
  for (let i = 0; i < 5; i++) post(fastStats);
  assert.equal(views.at(-1).state, 'filtered');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 1);
  assert.equal(originalGainOf(context).gain.value, 0);
});

test('an overload on DPDFNet-4 asks the worklet for DPDFNet-2 and mutes the output until it switches', async () => {
  const { context, filter, filterNode, views, ready, post } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  for (let i = 0; i < 15; i++) post(slowStats);
  await flush();

  assert.deepEqual(filterNode.port.messages.at(-1), { type: 'use-model', model: 'dpdfnet2' });
  assert.equal(views.at(-1).state, 'starting');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 0);
  assert.equal(originalGainOf(context).gain.value, 0);

  for (let i = 0; i < 15; i++) post(slowStats);
  assert.equal(filterNode.port.messages.filter((m) => m.type === 'use-model').length, 1, 'stats during the switch are ignored');

  post({ type: 'model', model: 'dpdfnet2', latencySamples: TOTAL_DELAY, warmupMs: { dpdfnet2: 1.375 } });
  await flush();
  assert.equal(views.at(-1).state, 'filtered');
  assert.equal(views.at(-1).model, 'dpdfnet2');
  assert.equal(views.at(-1).detail, 'live, DPDFNet-2, 76 ms delay');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 1);
  assert.deepEqual(originalLevels(views), [0]);
});

test('an overload on a pinned DPDFNet-4 shows the too-slow message without asking for a switch', async () => {
  const { context, filter, filterNode, views, ready, post } = setup({ isPinned: true });
  filter.setEnabled(true, new FakeVideo());
  await ready();
  for (let i = 0; i < 15; i++) post(slowStats);
  assert.equal(views.at(-1).state, 'too-slow');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 0);
  assert.deepEqual(filterNode.port.messages.filter((m) => m.type === 'use-model'), []);
});

test('an overload after switching to DPDFNet-2 shows the too-slow message', async () => {
  const { context, filter, filterNode, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  for (let i = 0; i < 15; i++) post(slowStats);
  await flush();
  post({ type: 'model', model: 'dpdfnet2', latencySamples: TOTAL_DELAY, warmupMs: {} });
  await flush();
  for (let i = 0; i < 10; i++) post(slowStats);
  assert.equal(views.at(-1).state, 'filtered', 'the new model starts with a clean overload record');
  for (let i = 0; i < 5; i++) post(slowStats);
  assert.equal(views.at(-1).state, 'too-slow');
  assert.equal(filterOutputOf(context, filterNode).gain.value, 0);
  assert.equal(filterNode.port.messages.filter((m) => m.type === 'use-model').length, 1);
});

test('a worklet that finds the device too slow at start mutes with the too-slow message', async () => {
  const { context, filter, views } = setup({ failToCreate: tooSlowError({ dpdfnet4: 3, dpdfnet2: 2.5 }) });
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await flush();

  assert.equal(views.at(-1).state, 'too-slow');
  assert.equal(originalGainOf(context).gain.value, 0);
  assert.deepEqual(originalLevels(views), [0]);
});

test('a switch that finds DPDFNet-2 too slow disposes the worklet and shows the too-slow message', async () => {
  const { context, filter, filterNode, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  for (let i = 0; i < 15; i++) post(slowStats);
  post({ type: 'too-slow', warmupMs: { dpdfnet2: 2.5 } });

  assert.equal(views.at(-1).state, 'too-slow');
  assert.deepEqual(filterNode.port.messages.at(-1), { type: 'dispose' });
  assert.equal(originalGainOf(context).gain.value, 0);
  assert.deepEqual(originalLevels(views), [0]);
});

test('turning the filter off and on after too-slow tries again', async () => {
  const { filter, views, ready, post } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  post({ type: 'too-slow', warmupMs: {} });
  filter.setEnabled(false);
  filter.setEnabled(true, video);
  assert.equal(views.at(-1).state, 'starting');
  await ready();
  assert.equal(views.at(-1).state, 'filtered');
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

test('the panel gets the engine details from the ready message', async () => {
  const { filter, views, ready } = setup({ isPinned: true });
  filter.setEnabled(true, new FakeVideo());
  await ready();
  assert.deepEqual(views.at(-1).engine, {
    model: 'dpdfnet4',
    isPinned: true,
    wasmSource: 'bytes',
    latencySamples: TOTAL_DELAY,
    warmupMs: { dpdfnet4: 1.25 },
    heldModels: [],
    wasmMemoryBytes: 65536,
  });
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

test('a new main element is attached through the registry and replaces the old feed', async () => {
  const { context, filter, filterNode, ready } = setup();
  const first = new FakeVideo();
  const second = new FakeVideo();
  filter.setEnabled(true, first);
  await ready();
  first.paused = true;
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

const sourceOf = (context, video) => context.sources.get(video);
const gainOf = (source) => [...source.connections].find((node) => node.gain);

test('the main player is fed when it plays, and the feed falls back to another playing video', () => {
  const main = new FakeVideo();
  const preview = new FakeVideo();
  assert.equal(pickFeedVideo({ main, videos: [preview, main] }), main);
  main.paused = true;
  assert.equal(pickFeedVideo({ main, videos: [preview, main] }), preview);
  preview.ended = true;
  assert.equal(pickFeedVideo({ main, videos: [preview, main] }), main);
  assert.equal(pickFeedVideo({ main: null, videos: [preview] }), null);
});

test('every video on the page is routed at 0 while on, and only the playing one feeds the filter', async () => {
  const { context, filter, filterNode, views, ready } = setup();
  const main = new FakeVideo();
  const short = new FakeVideo();
  const preview = new FakeVideo();
  preview.paused = true;
  filter.setEnabled(true, main, [main, short, preview]);
  await ready();

  for (const video of [main, short, preview]) assert.equal(gainOf(sourceOf(context, video)).gain.value, 0);
  assert.ok(sourceOf(context, main).connections.has(filterNode));
  assert.ok(!sourceOf(context, short).connections.has(filterNode));
  assert.ok(!sourceOf(context, preview).connections.has(filterNode));
  assert.equal(views.at(-1).originalLevel, 0);

  main.paused = true;
  filter.refresh();
  assert.ok(!sourceOf(context, main).connections.has(filterNode));
  assert.ok(sourceOf(context, short).connections.has(filterNode));
  for (const video of [main, short, preview]) assert.equal(gainOf(sourceOf(context, video)).gain.value, 0);

  filter.setEnabled(false);
  for (const video of [main, short, preview]) assert.equal(gainOf(sourceOf(context, video)).gain.value, 1);
});

test('a video added later while on is routed at 0 without taking the feed from the playing main player', async () => {
  const { context, filter, filterNode, ready } = setup();
  const main = new FakeVideo();
  filter.setEnabled(true, main, [main]);
  await ready();
  const inline = new FakeVideo();
  filter.attach(main, [main, inline]);
  assert.equal(gainOf(sourceOf(context, inline)).gain.value, 0);
  assert.ok(sourceOf(context, main).connections.has(filterNode));
  assert.ok(!sourceOf(context, inline).connections.has(filterNode));
});

test('if the audio context cannot be created, every video is muted and the error is shown', () => {
  const { filter, views } = setup({
    createContext: () => {
      throw new Error('AudioContext blocked');
    },
  });
  const main = new FakeVideo();
  const other = new FakeVideo();
  filter.setEnabled(true, main, [main, other]);
  assert.equal(main.muted, true);
  assert.equal(other.muted, true);
  assert.equal(views.at(-1).state, 'error');
  assert.match(views.at(-1).detail, /AudioContext blocked/);
  assert.equal(views.at(-1).originalLevel, 0);

  const late = new FakeVideo();
  filter.attach(main, [main, other, late]);
  assert.equal(late.muted, true);

  filter.setEnabled(false);
  assert.ok([main, other, late].every((video) => video.muted === false && video.volume === 0.7));
  assert.equal(views.at(-1).originalLevel, 1);
});

test('an internal failure while on mutes the attached videos', async () => {
  const { filter, views, ready } = setup();
  const main = new FakeVideo();
  filter.setEnabled(true, main, [main]);
  await ready();
  filter.failClosed('internal error: boom');
  assert.equal(main.muted, true);
  assert.equal(views.at(-1).state, 'error');
  assert.equal(views.at(-1).originalLevel, 0);
});

test('the worklet idles while it has nothing to filter and wakes when fed', async () => {
  const { filter, filterNode, ready } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  assert.deepEqual(filterNode.port.messages, []);
  filter.setEnabled(false);
  assert.deepEqual(filterNode.port.messages, [{ type: 'idle', value: true }]);
  filter.setEnabled(true, video);
  assert.deepEqual(filterNode.port.messages.at(-1), { type: 'idle', value: false });
});

test('a worklet that is ready before any video routes starts idle', async () => {
  const { filter, filterNode, ready } = setup();
  const video = new FakeVideo();
  video.readyState = 0;
  filter.setEnabled(true, video);
  await ready();
  assert.deepEqual(filterNode.port.messages, [{ type: 'idle', value: true }]);
});

test('a processor error disposes of the worklet', async () => {
  const { filter, filterNode, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  post({ type: 'error', stage: 'process', message: 'boom' });
  assert.deepEqual(filterNode.port.messages.at(-1), { type: 'dispose' });
});

const dataCloneError = () => Object.assign(new Error('The object could not be cloned.'), { name: 'DataCloneError' });

test('the worklet gets the compiled module where the browser can clone it', () => {
  const calls = [];
  const node = createWithWasmFallback((wasm) => (calls.push(wasm), 'node'), { module: 'module', bytes: 'bytes' });
  assert.equal(node, 'node');
  assert.deepEqual(calls, ['module']);
});

test('the worklet gets the wasm bytes when the module cannot be cloned, as on Firefox', () => {
  const calls = [];
  const node = createWithWasmFallback(
    (wasm) => {
      calls.push(wasm);
      if (wasm === 'module') throw dataCloneError();
      return 'node';
    },
    { module: 'module', bytes: 'bytes' },
  );
  assert.equal(node, 'node');
  assert.deepEqual(calls, ['module', 'bytes']);
});

test('other node construction errors are not retried', () => {
  let calls = 0;
  assert.throws(
    () =>
      createWithWasmFallback(
        () => {
          calls += 1;
          throw new Error('NotSupportedError');
        },
        { module: 'module', bytes: 'bytes' },
      ),
    /NotSupportedError/,
  );
  assert.equal(calls, 1);
});

test('the tick re-mutes a fallback-muted video that an ad unmuted', () => {
  const { filter } = setup({
    createContext: () => {
      throw new Error('AudioContext blocked');
    },
  });
  const video = new FakeVideo();
  filter.setEnabled(true, video, [video]);
  video.muted = false;
  filter.enforce();
  assert.equal(video.muted, true);
});

test('the worklet is built while the context is suspended and the context resumes once it is ready', async () => {
  const { context, filter, builds, views, ready } = setup();
  filter.setEnabled(true, new FakeVideo());
  await flush();
  assert.deepEqual(builds.map((build) => build.contextState), ['suspended']);
  assert.equal(context.state, 'suspended', 'still suspended while the processor warms up');
  assert.equal(views.at(-1).state, 'starting');

  await ready();
  assert.equal(context.state, 'running');
  assert.deepEqual(context.audioCalls.slice(-2), ['suspend', 'resume']);
  assert.equal(views.at(-1).state, 'filtered');
});

test('the tick does not resume the context while the worklet is being built', async () => {
  const { context, filter } = setup();
  filter.setEnabled(true, new FakeVideo());
  await flush();
  const calls = context.audioCalls.length;
  filter.refresh();
  filter.refresh();
  assert.deepEqual(context.audioCalls.slice(calls), []);
  assert.equal(context.state, 'suspended');
});

test('the tick resumes a context that something else suspended', async () => {
  const { context, filter, ready } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  context.state = 'suspended';
  filter.refresh();
  assert.equal(context.audioCalls.at(-1), 'resume');
});

test('a worklet that fails to start still resumes the context', async () => {
  const { context, filter } = setup({ failToCreate: new Error('addModule failed') });
  filter.setEnabled(true, new FakeVideo());
  await flush();
  assert.equal(context.state, 'running');
});

test('turning the filter off while the worklet is built keeps the context suspended until it is ready', async () => {
  const { context, filter, views, ready } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await flush();
  filter.setEnabled(false);
  assert.equal(context.state, 'suspended');
  assert.equal(views.at(-1).state, 'off');
  await ready();
  assert.equal(context.state, 'running');
  assert.equal(originalGainOf(context).gain.value, 1);
});

async function overloadedSetup(options) {
  const live = setup(options);
  live.filter.setEnabled(true, new FakeVideo());
  await live.ready();
  for (let i = 0; i < 15; i++) live.post(slowStats);
  return live;
}

test('a model switch suspends the context before asking the worklet and resumes after the reply', async () => {
  const { context, filter, filterNode, views, ready, post } = setup();
  filter.setEnabled(true, new FakeVideo());
  await ready();
  const statesWhenAsked = [];
  const postMessage = filterNode.port.postMessage;
  filterNode.port.postMessage = (message) => {
    if (message.type === 'use-model') statesWhenAsked.push(context.state);
    postMessage(message);
  };
  for (let i = 0; i < 15; i++) post(slowStats);
  await flush();
  assert.deepEqual(statesWhenAsked, ['suspended']);
  assert.equal(context.state, 'suspended');
  assert.deepEqual(filterNode.port.messages.at(-1), { type: 'use-model', model: 'dpdfnet2' });

  post({ type: 'model', model: 'dpdfnet2', latencySamples: TOTAL_DELAY, warmupMs: { dpdfnet2: 1.375 } });
  await flush();
  assert.equal(context.state, 'running');
  assert.equal(views.at(-1).state, 'filtered');
});

for (const reply of [
  { type: 'too-slow', warmupMs: { dpdfnet2: 2.5 } },
  { type: 'error', stage: 'switch', message: 'boom' },
]) {
  test(`a model switch that ends in ${reply.type} resumes the context`, async () => {
    const { context, post } = await overloadedSetup();
    await flush();
    post(reply);
    await flush();
    assert.equal(context.state, 'running');
  });
}

test('a model switch with no reply fails with a message and resumes the context', async () => {
  const { context, views } = await overloadedSetup({ switchTimeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flush();
  assert.equal(views.at(-1).state, 'error');
  assert.match(views.at(-1).detail, /did not switch/);
  assert.equal(context.state, 'running');
  assert.equal(originalGainOf(context).gain.value, 0);
});

test('the live delay does not add baseLatency, which Chrome already counts in outputLatency', () => {
  assert.equal(
    liveDetail({ model: 'dpdfnet4', latencySamples: 3165, sampleRate: 48000, outputLatency: 0.032, baseLatency: 0.0053 }),
    'live, DPDFNet-4, 98 ms delay',
  );
});

test('the next worklet starts from the model the last one settled on', async () => {
  const { filter, preparations, ready, post } = setup();
  const video = new FakeVideo();
  filter.setEnabled(true, video);
  await ready();
  assert.deepEqual(preparations, [{ lastModel: null }]);
  for (let i = 0; i < 15; i++) post(slowStats);
  await flush();
  post({ type: 'model', model: 'dpdfnet2', latencySamples: TOTAL_DELAY, warmupMs: {} });
  post({ type: 'error', stage: 'process', message: 'boom' });
  filter.setEnabled(false);
  filter.setEnabled(true, video);
  await ready();
  assert.deepEqual(preparations.at(-1), { lastModel: 'dpdfnet2' });
});

test('a first worklet loads both models and starts from DPDFNet-4', () => {
  assert.deepEqual(liveModelPlan({ pinnedModel: null, lastModel: null }), { load: ['dpdfnet4', 'dpdfnet2'], options: {} });
  assert.deepEqual(liveModelPlan({ pinnedModel: null, lastModel: 'dpdfnet4' }), { load: ['dpdfnet4', 'dpdfnet2'], options: {} });
});

test('once DPDFNet-2 was chosen, a new worklet loads and starts from DPDFNet-2 only', () => {
  assert.deepEqual(liveModelPlan({ pinnedModel: null, lastModel: 'dpdfnet2' }), {
    load: ['dpdfnet2'],
    options: { from: 'dpdfnet2' },
  });
});

test('a pinned model loads only itself', () => {
  assert.deepEqual(liveModelPlan({ pinnedModel: 'dpdfnet4', lastModel: 'dpdfnet2' }), {
    load: ['dpdfnet4'],
    options: { model: 'dpdfnet4' },
  });
});

test('the worklet gets the bytes straight away when there is no compiled module, as on Firefox', () => {
  const calls = [];
  createWithWasmFallback((wasm) => (calls.push(wasm), 'node'), { module: null, bytes: 'bytes' });
  assert.deepEqual(calls, ['bytes']);
});

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc');

test('the prepared model bytes are not kept alive by the running worklet', async () => {
  const context = fakeContext();
  let prepared = { bytes: new ArrayBuffer(1024) };
  const weak = new WeakRef(prepared.bytes);
  const filter = createLiveFilter({
    createContext: () => context,
    prepareFilter: async () => {
      const handOff = prepared;
      prepared = null;
      return handOff;
    },
    createFilterNode: async (_context, onMessage) => {
      const node = fakeNode('worklet');
      node.port.onmessage = onMessage;
      return { node, ready: { type: 'ready', model: 'dpdfnet4', latencySamples: TOTAL_DELAY } };
    },
    onChange: () => {},
  });
  filter.setEnabled(true, new FakeVideo());
  await flush();
  await flush();
  collectGarbage();
  await flush();
  collectGarbage();
  assert.equal(weak.deref(), undefined);
});
