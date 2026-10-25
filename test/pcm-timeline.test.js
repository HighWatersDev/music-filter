import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmTimeline } from '../src/pipeline/pcm-timeline.js';

const ramp = (start, length) => Float32Array.from({ length }, (_, i) => start + i);

test('writes across pages and reads back exactly', () => {
  const timeline = new PcmTimeline({ pageSamples: 100 });
  timeline.write(150, [ramp(150, 250), ramp(10150, 250)]);
  assert.deepEqual(timeline.ranges, [[150, 400]]);
  const [left, right] = timeline.read(190, 120);
  assert.deepEqual(Array.from(left), Array.from(ramp(190, 120)));
  assert.deepEqual(Array.from(right), Array.from(ramp(10190, 120)));
});

test('read returns null across a gap and mono input fills both channels', () => {
  const timeline = new PcmTimeline({ pageSamples: 100 });
  timeline.write(0, [ramp(0, 50)]);
  timeline.write(60, [ramp(60, 40)]);
  assert.equal(timeline.read(40, 30), null);
  assert.deepEqual(Array.from(timeline.read(0, 10)[1]), Array.from(ramp(0, 10)));
});

test('evictBefore frees whole pages and trims ranges', () => {
  const timeline = new PcmTimeline({ pageSamples: 100 });
  timeline.write(0, [ramp(0, 350), ramp(0, 350)]);
  timeline.evictBefore(250);
  assert.deepEqual(timeline.ranges, [[200, 350]]);
  assert.equal(timeline.read(150, 10), null);
  assert.equal(timeline.pages.size, 2);
});
