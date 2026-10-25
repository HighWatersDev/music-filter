import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackScheduler } from '../src/content/playback-scheduler.js';

class FakeParam {
  constructor(value) {
    this.initial = value;
    this.events = [];
  }

  get value() {
    return this.valueAt(clock.now);
  }

  setValueAtTime(value, time) {
    this.insert({ type: 'set', value, time });
  }

  linearRampToValueAtTime(value, time) {
    this.insert({ type: 'ramp', value, time });
  }

  setTargetAtTime() {}

  cancelScheduledValues(time) {
    this.events = this.events.filter((e) => e.time < time);
  }

  insert(event) {
    const at = this.events.findIndex((e) => e.time > event.time);
    this.events.splice(at === -1 ? this.events.length : at, 0, event);
  }

  valueAt(t) {
    let before = null;
    for (const event of this.events) {
      if (event.time > t) {
        if (event.type !== 'ramp') break;
        const from = before ?? { time: 0, value: this.initial };
        if (event.time === from.time) return event.value;
        return from.value + ((event.value - from.value) * (t - from.time)) / (event.time - from.time);
      }
      before = event;
    }
    return before ? before.value : this.initial;
  }
}

const clock = { now: 0 };
const sources = [];

globalThis.AudioBuffer = class {
  constructor({ length, sampleRate }) {
    this.length = length;
    this.sampleRate = sampleRate;
  }

  copyToChannel() {}
};

globalThis.GainNode = class {
  constructor(context, { gain = 1 } = {}) {
    this.gain = new FakeParam(gain);
  }

  connect(target) {
    return target;
  }

  disconnect() {}
};

globalThis.AudioBufferSourceNode = class {
  constructor(context, { buffer }) {
    this.buffer = buffer;
    this.stopAt = Infinity;
    sources.push(this);
  }

  connect(gain) {
    this.gainNode = gain;
    return gain;
  }

  start(when, offset, duration) {
    Object.assign(this, { when, offset, duration });
  }

  stop(time) {
    this.stopAt = time;
  }
};

const RATE = 1000;

function play(windows, { until, latency = 0 }) {
  sources.length = 0;
  clock.now = 0;
  const context = { currentTime: 0, outputLatency: latency, destination: {} };
  const video = { currentTime: 0 };
  const scheduler = new PlaybackScheduler(context, video);
  for (const [start, end] of windows) {
    const length = Math.round((end - start) * RATE);
    scheduler.addWindow({ startSeconds: start, sampleRate: RATE, left: new Float32Array(length), right: new Float32Array(length) });
  }
  const buffers = new Map(scheduler.windows.map((w) => [w.buffer, w.start]));
  for (let step = 0; step * 0.05 <= until; step++) {
    clock.now = step * 0.05;
    context.currentTime = clock.now;
    video.currentTime = clock.now;
    scheduler.tick({ allowProcessed: true });
  }
  return sources.map((source) => ({ source, windowStart: buffers.get(source.buffer) }));
}

function assertSeamless(played, { from, to, latency = 0 }) {
  for (let t = from; t < to; t += 0.005) {
    const active = played.filter(({ source }) => source.when <= t && t < Math.min(source.when + source.duration, source.stopAt));
    for (const { source, windowStart } of active) {
      const media = windowStart + source.offset + (t - source.when);
      assert.ok(Math.abs(media - (t + latency)) < 1e-6, `source at ${windowStart} plays ${media} at ${t}`);
    }
    const sum = active.reduce((total, { source }) => total + source.gainNode.gain.valueAt(t), 0);
    assert.ok(sum >= 0.85 && sum <= 1.15, `gain sum ${sum.toFixed(3)} at ${t.toFixed(3)} s`);
  }
}

test('windows overlapping by 7 s keep the gain sum near 1', () => {
  const windows = [[0, 10], [3, 13], [6, 16], [9, 19], [12, 22]];
  assertSeamless(play(windows, { until: 22 }), { from: 0.1, to: 21.9 });
});

test('windows shorter than 2 s keep the gain sum near 1', () => {
  const windows = [[0, 2], [1, 2.5], [1.8, 3.3], [2.8, 4], [3.5, 5], [4.2, 5.6], [5.5, 7]];
  assertSeamless(play(windows, { until: 7 }), { from: 0.1, to: 6.9 });
});

test('a short window inside the previous fade does not cut the fade short', () => {
  const windows = [[0, 10], [9.2, 10.8], [9.8, 19.8]];
  assertSeamless(play(windows, { until: 20 }), { from: 0.1, to: 19.7 });
});

test('overlapping windows stay seamless and in sync with output latency', () => {
  const windows = [[0, 10], [3, 13], [11.5, 13.4], [12.2, 22]];
  assertSeamless(play(windows, { until: 22, latency: 0.12 }), { from: 0.3, to: 21.7, latency: 0.12 });
});
