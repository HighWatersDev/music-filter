import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crossfadeSpan,
  measureDrift,
  mediaToContext,
  outputLatencyOf,
  overlapPlan,
  scheduleSpan,
  trackPlayhead,
} from '../src/pipeline/playback-math.js';

test('scheduleSpan starts a future window at its start', () => {
  assert.deepEqual(scheduleSpan({ windowStart: 12, windowEnd: 22, mediaNow: 10, ctxNow: 100 }), {
    when: 102,
    offset: 0,
    duration: 10,
    startMedia: 12,
  });
});

test('scheduleSpan joins a window already under the playhead', () => {
  const span = scheduleSpan({ windowStart: 8, windowEnd: 18, mediaNow: 10, ctxNow: 100, lead: 0.05 });
  assert.ok(Math.abs(span.when - 100.05) < 1e-9);
  assert.ok(Math.abs(span.offset - 2.05) < 1e-9);
  assert.ok(Math.abs(span.duration - 7.95) < 1e-9);
});

test('scheduleSpan skips a window that has passed', () => {
  assert.equal(scheduleSpan({ windowStart: 0, windowEnd: 10, mediaNow: 10, ctxNow: 100 }), null);
});

test('crossfadeSpan covers the future part of the overlap', () => {
  assert.deepEqual(crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 5 }), { from: 12, to: 13 });
  const late = crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 12.5, lead: 0.05 });
  assert.ok(Math.abs(late.from - 12.55) < 1e-9);
  assert.equal(crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 13 }), null);
});

test('measureDrift is positive when audio runs ahead of video', () => {
  assert.ok(Math.abs(measureDrift({ anchorCtx: 100, anchorMedia: 10, ctxNow: 105.1, mediaNow: 15 }) - 0.1) < 1e-9);
});

test('scheduleSpan plays early by the output latency so audio is heard in sync', () => {
  const future = scheduleSpan({ windowStart: 12, windowEnd: 22, mediaNow: 10, ctxNow: 100, latency: 0.1 });
  assert.ok(Math.abs(future.when - 101.9) < 1e-9);
  assert.equal(future.offset, 0);
  assert.equal(future.startMedia, 12);

  const joined = scheduleSpan({ windowStart: 8, windowEnd: 18, mediaNow: 10, ctxNow: 100, lead: 0.05, latency: 0.1 });
  assert.ok(Math.abs(joined.when - 100.05) < 1e-9);
  assert.ok(Math.abs(joined.startMedia - 10.15) < 1e-9);
  assert.ok(Math.abs(joined.offset - 2.15) < 1e-9);
});

test('mediaToContext maps media time to the context time it must be scheduled at', () => {
  assert.ok(Math.abs(mediaToContext({ media: 12, mediaNow: 10, ctxNow: 100 }) - 102) < 1e-9);
  assert.ok(Math.abs(mediaToContext({ media: 12, mediaNow: 10, ctxNow: 100, latency: 0.2 }) - 101.8) < 1e-9);
});

test('crossfadeSpan starts no earlier than the latency-adjusted lead', () => {
  const fade = crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 12.5, lead: 0.05, latency: 0.1 });
  assert.ok(Math.abs(fade.from - 12.65) < 1e-9);
  assert.equal(crossfadeSpan({ previousEnd: 13, nextStart: 12, mediaNow: 12.9, latency: 0.1 }), null);
});

test('outputLatencyOf prefers outputLatency, then baseLatency, then 0', () => {
  assert.equal(outputLatencyOf({ outputLatency: 0.15, baseLatency: 0.01 }), 0.15);
  assert.equal(outputLatencyOf({ outputLatency: 0, baseLatency: 0.01 }), 0.01);
  assert.equal(outputLatencyOf({}), 0);
});

test('overlapPlan skips a window whose remaining span is already playing', () => {
  const playing = [{ start: 10, end: 20 }];
  assert.deepEqual(overlapPlan({ startMedia: 12, windowEnd: 15, playing }), { skip: true, previous: -1 });
  assert.deepEqual(overlapPlan({ startMedia: 12, windowEnd: 20, playing }), { skip: true, previous: -1 });
  const joined = [{ start: 10, end: 16 }, { start: 15, end: 25 }];
  assert.equal(overlapPlan({ startMedia: 12, windowEnd: 24, playing: joined }).skip, true);
});

test('overlapPlan crossfades from the playing window that ends inside the new one', () => {
  assert.deepEqual(overlapPlan({ startMedia: 12, windowEnd: 22, playing: [{ start: 2, end: 13 }] }), { skip: false, previous: 0 });
  assert.deepEqual(overlapPlan({ startMedia: 12.05, windowEnd: 25, playing: [{ start: 10, end: 20 }] }), {
    skip: false,
    previous: 0,
  });
  assert.deepEqual(
    overlapPlan({ startMedia: 12, windowEnd: 30, playing: [{ start: 0, end: 13 }, { start: 5, end: 18 }] }),
    { skip: false, previous: 1 },
  );
  assert.deepEqual(overlapPlan({ startMedia: 12, windowEnd: 22, playing: [{ start: 0, end: 12 }] }), { skip: false, previous: -1 });
  assert.deepEqual(overlapPlan({ startMedia: 12, windowEnd: 22, playing: [] }), { skip: false, previous: -1 });
});

test('trackPlayhead flags a playhead that has not moved for longer than the limit', () => {
  let state = trackPlayhead(null, 10, 100);
  assert.equal(state.isFrozen, false);
  state = trackPlayhead(state.lastMoved, 10, 100.3);
  assert.equal(state.isFrozen, false);
  state = trackPlayhead(state.lastMoved, 10, 100.6);
  assert.equal(state.isFrozen, true);
  state = trackPlayhead(state.lastMoved, 10.6, 100.7);
  assert.equal(state.isFrozen, false);
  assert.deepEqual(state.lastMoved, { media: 10.6, ctx: 100.7 });
});
