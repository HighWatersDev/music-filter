import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalAudioRegistry, resolveUserVolume } from '../src/content/original-audio.js';

class FakeVideo extends EventTarget {
  muted = false;
  volume = 0.7;
  readyState = 1;
  loadMetadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
  changeVolume(changes) {
    Object.assign(this, changes);
    this.dispatchEvent(new Event('volumechange'));
  }
}

function fakeParam(value) {
  const param = {
    value,
    calls: [],
    cancelScheduledValues: (time) => param.calls.push(['cancel', time]),
    setValueAtTime: (next, time) => {
      param.calls.push(['set', next, time]);
      param.value = next;
    },
    linearRampToValueAtTime: (next, time) => {
      param.calls.push(['ramp', next, time]);
      param.value = next;
    },
  };
  return param;
}

function fakeContext() {
  const routed = new Set();
  const context = {
    currentTime: 5,
    destination: { name: 'destination' },
    gains: [],
    sourceCalls: 0,
    createGain() {
      const gain = { gain: fakeParam(1), connections: [], connect: (node) => gain.connections.push(node) };
      context.gains.push(gain);
      return gain;
    },
    createMediaElementSource(video) {
      context.sourceCalls += 1;
      if (routed.has(video)) throw new Error('InvalidStateError: element already connected');
      routed.add(video);
      return { connect() {} };
    },
  };
  return context;
}

test('re-attaching an element reuses its graph instead of routing it twice', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  const first = registry.attach(video, context, { level: 0 });
  registry.restoreAll();
  const second = registry.attach(video, context, { level: 0 });
  assert.equal(second, first);
  assert.equal(context.sourceCalls, 1);
  assert.equal(second.error, null);
  assert.equal(second.currentLevel(), 0);
  assert.equal(context.gains[0].gain.value, 0);
});

test('a new graph starts at the requested level without ramping down from 1', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  registry.attach(new FakeVideo(), context, { level: 0 });
  const { gain } = context.gains[0];
  assert.equal(gain.value, 0);
  assert.ok(gain.calls.every(([kind, value]) => kind === 'cancel' || value === 0));
});

test('muting the graph is immediate and restoring ramps', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const control = registry.attach(new FakeVideo(), context, { level: 0 });
  const { gain } = context.gains[0];
  control.setLevel(1);
  assert.deepEqual(gain.calls.at(-1)[0], 'ramp');
  assert.equal(gain.value, 1);
  control.setLevel(0);
  assert.deepEqual(gain.calls.at(-1), ['set', 0, 5]);
});

test('a graph that cannot be created fails closed by muting the element', () => {
  const context = fakeContext();
  context.createMediaElementSource = () => {
    throw new Error('InvalidStateError');
  };
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  const control = registry.attach(video, context, { level: 0 });
  assert.match(control.error, /InvalidStateError/);
  assert.equal(control.currentLevel(), 0);
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
  registry.restoreAll();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.7);
});

test('every attached element stays silent until restoreAll', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const first = registry.attach(new FakeVideo(), context, { level: 0 });
  const second = registry.attach(new FakeVideo(), context, { level: 0 });
  assert.equal(first.currentLevel(), 0);
  assert.equal(second.currentLevel(), 0);
  registry.restoreAll();
  assert.equal(first.currentLevel(), 1);
  assert.equal(second.currentLevel(), 1);
  assert.equal(context.gains[0].gain.value, 1);
  assert.equal(context.gains[1].gain.value, 1);
});

test('an element without a source is not routed until its metadata loads', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  video.readyState = 0;
  const control = registry.attach(video, context, { level: 0 });
  control.setLevel(0);
  assert.equal(context.sourceCalls, 0);
  assert.equal(control.isRouted(), false);
  assert.equal(control.currentLevel(), 0);
  assert.equal(control.error, null);
  video.loadMetadata();
  assert.equal(context.sourceCalls, 1);
  assert.equal(control.isRouted(), true);
  assert.equal(registry.attach(video, context, { level: 0 }), control);
  assert.equal(context.sourceCalls, 1);
});

test('routing on loadedmetadata starts the graph silent while the filter is on', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  video.readyState = 0;
  const control = registry.attach(video, context, { level: 0 });
  video.loadMetadata();
  const { gain } = context.gains[0];
  assert.equal(gain.value, 0);
  assert.ok(gain.calls.every(([kind, value]) => kind === 'cancel' || value === 0));
  assert.equal(control.currentLevel(), 0);
  control.setLevel(1);
  assert.equal(gain.value, 1);
});

test('a level change routes an element that gained metadata without an event', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  video.readyState = 0;
  const control = registry.attach(video, context, { level: 0 });
  video.readyState = 2;
  control.setLevel(0);
  assert.equal(context.sourceCalls, 1);
  assert.equal(context.gains[0].gain.value, 0);
});

test('an element restored before its metadata loads is left unrouted', () => {
  const context = fakeContext();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  video.readyState = 0;
  const control = registry.attach(video, context, { level: 0 });
  registry.restoreAll();
  video.loadMetadata();
  assert.equal(context.sourceCalls, 0);
  assert.equal(control.currentLevel(), 1);
  registry.attach(video, context, { level: 0 });
  assert.equal(context.sourceCalls, 1);
  assert.equal(context.gains[0].gain.value, 0);
});

test('a graph that fails when metadata loads fails closed by muting the element', () => {
  const context = fakeContext();
  context.createMediaElementSource = () => {
    throw new Error('InvalidStateError');
  };
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  const video = new FakeVideo();
  video.readyState = 0;
  const control = registry.attach(video, context, { level: 0 });
  assert.equal(control.error, null);
  video.loadMetadata();
  assert.match(control.error, /InvalidStateError/);
  assert.equal(control.mode, 'mute');
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
});

test('mute mode silences with muted and volume and restores the user settings', () => {
  const registry = createOriginalAudioRegistry({ mode: 'mute' });
  const video = new FakeVideo();
  registry.attach(video, null, { level: 0 });
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
  registry.restoreAll();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.7);
});

test('mute mode keeps the element silent when the user unmutes or changes volume', () => {
  const registry = createOriginalAudioRegistry({ mode: 'mute' });
  const video = new FakeVideo();
  const control = registry.attach(video, null, { level: 0 });
  video.changeVolume({ muted: false });
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0);
  assert.equal(control.userVolume(), 0.7);
  video.changeVolume({ volume: 0.4 });
  assert.equal(video.volume, 0);
  assert.equal(control.userVolume(), 0.4);
  registry.restoreAll();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.4);
});

test('mute mode remembers a user mute made before filtering', () => {
  const registry = createOriginalAudioRegistry({ mode: 'mute' });
  const video = new FakeVideo();
  video.muted = true;
  const control = registry.attach(video, null, { level: 0 });
  assert.equal(control.userVolume(), 0);
  registry.restoreAll();
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0.7);
});

test('mute mode takes the user volume from the player when it reports one', () => {
  let player = { muted: true, volume: 0.8 };
  const registry = createOriginalAudioRegistry({ mode: 'mute', readPlayerVolume: () => player });
  const control = registry.attach(new FakeVideo(), null, { level: 0 });
  assert.equal(control.userVolume(), 0);
  player = { muted: false, volume: 0.5 };
  assert.equal(control.userVolume(), 0.5);
  player = null;
  assert.equal(control.userVolume(), 0.7);
});

test('resolveUserVolume falls back to remembered values when the player report is unusable', () => {
  const remembered = { muted: false, volume: 0.6 };
  assert.equal(resolveUserVolume({ player: null, remembered }), 0.6);
  assert.equal(resolveUserVolume({ player: { muted: undefined, volume: 0.2 }, remembered }), 0.6);
  assert.equal(resolveUserVolume({ player: { muted: false, volume: Number.NaN }, remembered }), 0.6);
  assert.equal(resolveUserVolume({ player: { muted: false, volume: 1.5 }, remembered }), 1);
  assert.equal(resolveUserVolume({ player: null, remembered: { muted: true, volume: 0.6 } }), 0);
});

test('a fallback mute restored before the primary control leaves the user settings', () => {
  const primary = createOriginalAudioRegistry({ mode: 'mute' });
  const fallback = createOriginalAudioRegistry({ mode: 'mute' });
  const video = new FakeVideo();
  primary.attach(video, null, { level: 0 });
  fallback.attach(video, null, { level: 0 });
  fallback.restoreAll();
  primary.restoreAll();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.7);
});

test('onRoute hands over the element source once, when the element is routed', () => {
  const context = fakeContext();
  const routes = [];
  const registry = createOriginalAudioRegistry({ mode: 'graph', onRoute: (video, source) => routes.push([video, source]) });
  const video = new FakeVideo();
  video.readyState = 0;
  const control = registry.attach(video, context, { level: 0 });
  assert.equal(routes.length, 0);
  assert.equal(control.source, null);

  video.loadMetadata();
  registry.restoreAll();
  registry.attach(video, context, { level: 0 });
  assert.equal(routes.length, 1);
  assert.equal(routes[0][0], video);
  assert.equal(routes[0][1], control.source);
  assert.ok(control.source);
});

test('onRoute is not called when routing fails', () => {
  const context = fakeContext();
  context.createMediaElementSource = () => {
    throw new Error('InvalidStateError');
  };
  const routes = [];
  const registry = createOriginalAudioRegistry({ mode: 'graph', onRoute: (...args) => routes.push(args) });
  const control = registry.attach(new FakeVideo(), context, { level: 0 });
  assert.equal(routes.length, 0);
  assert.equal(control.source, null);
  assert.match(control.error, /could not be routed/);
});

function swapSourceUnmuted(video, eventType) {
  video.muted = false;
  video.volume = 0.7;
  video.dispatchEvent(new Event(eventType));
}

for (const eventType of ['emptied', 'loadstart', 'loadedmetadata', 'play', 'playing']) {
  test(`mute mode re-mutes an element unmuted without a volumechange, on ${eventType}`, () => {
    const video = new FakeVideo();
    const registry = createOriginalAudioRegistry({ mode: 'mute' });
    registry.attach(video, null, { level: 0 });
    swapSourceUnmuted(video, eventType);
    assert.equal(video.muted, true);
    assert.equal(video.volume, 0);
  });
}

test('the tick re-mutes an element that an ad unmuted with no event at all', () => {
  const video = new FakeVideo();
  const registry = createOriginalAudioRegistry({ mode: 'mute' });
  registry.attach(video, null, { level: 0 });
  video.muted = false;
  registry.enforceAll();
  assert.equal(video.muted, true);
});

test('enforcing the mute does not overwrite the user settings restored later', () => {
  const video = new FakeVideo();
  video.volume = 0.4;
  const registry = createOriginalAudioRegistry({ mode: 'mute' });
  registry.attach(video, null, { level: 0 });
  swapSourceUnmuted(video, 'emptied');
  registry.enforceAll();
  registry.restoreAll();
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0.4);
});

test('enforcement leaves a restored element alone', () => {
  const video = new FakeVideo();
  const registry = createOriginalAudioRegistry({ mode: 'mute' });
  registry.attach(video, null, { level: 0 });
  registry.restoreAll();
  video.muted = true;
  video.dispatchEvent(new Event('emptied'));
  registry.enforceAll();
  video.muted = false;
  video.dispatchEvent(new Event('playing'));
  assert.equal(video.muted, false);
});

test('the tick routes a graph element whose metadata event was missed, at 0', () => {
  const context = fakeContext();
  const video = new FakeVideo();
  video.readyState = 0;
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  registry.attach(video, context, { level: 0 });
  assert.equal(context.gains.length, 0);
  video.readyState = 1;
  registry.enforceAll();
  assert.equal(context.gains.length, 1);
  assert.equal(context.gains[0].gain.value, 0);
});

test('the tick puts a graph gain back to 0 if it drifted while the filter is on', () => {
  const context = fakeContext();
  const video = new FakeVideo();
  const registry = createOriginalAudioRegistry({ mode: 'graph' });
  registry.attach(video, context, { level: 0 });
  context.gains[0].gain.value = 1;
  registry.enforceAll();
  assert.equal(context.gains[0].gain.value, 0);
});
