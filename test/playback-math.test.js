import test from 'node:test';
import assert from 'node:assert/strict';
import { crossfadeSpan, measureDrift, scheduleSpan } from '../src/pipeline/playback-math.js';

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
