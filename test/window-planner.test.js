import test from 'node:test';
import assert from 'node:assert/strict';
import { isStarved, planNextWindow } from '../src/pipeline/window-planner.js';

const S = 48000;
const base = {
  firstWindow: 4 * S,
  window: 10 * S,
  overlap: 1 * S,
  minWindow: 2 * S,
  lookahead: 30 * S,
  urgency: 5 * S,
  maxStartGap: S / 2,
};

test('first window starts at the playhead and is short', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[0, 60 * S]], processed: [] });
  assert.deepEqual(plan, { start: 0, end: 4 * S });
});

test('a small gap before decoded audio is skipped', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[312, 60 * S]], processed: [] });
  assert.deepEqual(plan, { start: 312, end: 312 + 4 * S });
});

test('next window overlaps the processed end and is full length', () => {
  const plan = planNextWindow({ ...base, playhead: 1 * S, decoded: [[0, 60 * S]], processed: [[0, 4 * S]] });
  assert.deepEqual(plan, { start: 3 * S, end: 13 * S });
});

test('a small gap before processed audio still counts as processed', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[312, 60 * S]], processed: [[312, 312 + 4 * S]] });
  assert.deepEqual(plan, { start: 312 + 3 * S, end: 312 + 13 * S });
});

test('stops when enough is processed ahead', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[0, 60 * S]], processed: [[0, 31 * S]] });
  assert.equal(plan, null);
});

test('waits for more decoded audio unless the window is urgent', () => {
  const notUrgent = planNextWindow({ ...base, playhead: 0, decoded: [[0, 15 * S]], processed: [[0, 10 * S]] });
  assert.equal(notUrgent, null);
  const urgent = planNextWindow({ ...base, playhead: 7 * S, decoded: [[0, 15 * S]], processed: [[0, 10 * S]] });
  assert.deepEqual(urgent, { start: 9 * S, end: 15 * S });
});

test('an urgent window needs the minimum of new audio past the processed end, not counting the overlap', () => {
  const tooShort = planNextWindow({ ...base, playhead: 7 * S, decoded: [[0, 11.5 * S]], processed: [[0, 10 * S]] });
  assert.equal(tooShort, null);
  const exactlyMinimum = planNextWindow({ ...base, playhead: 7 * S, decoded: [[0, 12 * S]], processed: [[0, 10 * S]] });
  assert.deepEqual(exactlyMinimum, { start: 9 * S, end: 12 * S });
});

test('a first window needs the minimum of decoded audio from its start', () => {
  assert.equal(planNextWindow({ ...base, playhead: 0, decoded: [[0, 1.5 * S]], processed: [] }), null);
  assert.deepEqual(planNextWindow({ ...base, playhead: 0, decoded: [[0, 2 * S]], processed: [] }), { start: 0, end: 2 * S });
});

test('when the playhead is within the minimum of the processed end, any new audio is planned', () => {
  const plan = planNextWindow({ ...base, playhead: 9.2 * S, decoded: [[0, 10.5 * S]], processed: [[0, 10 * S]] });
  assert.deepEqual(plan, { start: 9 * S, end: 10.5 * S });
});

test('a tiny hole in decoded audio is bridged so the next window continues the processed range', () => {
  const decoded = [[0, 5 * S], [5 * S + 360, 60 * S]];
  for (const playhead of [1 * S, 4 * S]) {
    const plan = planNextWindow({ ...base, playhead, decoded, processed: [[0, 5 * S]] });
    assert.deepEqual(plan, { start: 4 * S, end: 14 * S });
    assert.ok(plan.end > 5 * S + 360);
  }
});

test('a re-sent init that leaves a hole does not stop planning', () => {
  const decoded = [[312, 239040], [239400, 576960]];
  const plan = planNextWindow({ ...base, playhead: 1 * S, decoded, processed: [[312, 239040]] });
  assert.deepEqual(plan, { start: 239040 - S, end: 576960 });
});

test('a first window bridges a tiny hole too', () => {
  const plan = planNextWindow({ ...base, playhead: 0, decoded: [[0, 1 * S], [1 * S + 360, 60 * S]], processed: [] });
  assert.deepEqual(plan, { start: 0, end: 4 * S });
});

test('a hole wider than maxStartGap is not bridged', () => {
  const plan = planNextWindow({ ...base, playhead: 1 * S, decoded: [[0, 5 * S], [6 * S, 60 * S]], processed: [[0, 5 * S]] });
  assert.equal(plan, null);
});

test('after a seek, plans from the new playhead', () => {
  const plan = planNextWindow({ ...base, playhead: 40 * S, decoded: [[0, 60 * S]], processed: [[0, 14 * S]] });
  assert.deepEqual(plan, { start: 40 * S, end: 44 * S });
});

test('nothing decoded at the playhead means no plan', () => {
  assert.equal(planNextWindow({ ...base, playhead: 40 * S, decoded: [[0, 20 * S]], processed: [] }), null);
});

test('the end of the decoded audio is not planned again when the overlap equals the minimum', () => {
  const plan = planNextWindow({ ...base, minWindow: 1 * S, playhead: 55 * S, decoded: [[0, 60 * S]], processed: [[0, 60 * S]] });
  assert.equal(plan, null);
});

const starving = { lookahead: 30 * S, maxStartGap: S / 2 };

test('starved when no decoded audio covers or starts just after the playhead', () => {
  assert.equal(isStarved({ ...starving, playhead: 5 * S, decoded: [[20 * S, 60 * S]], processed: [] }), true);
  assert.equal(isStarved({ ...starving, playhead: 70 * S, decoded: [[20 * S, 60 * S]], processed: [] }), true);
  assert.equal(isStarved({ ...starving, playhead: 5 * S, decoded: [[5 * S + 312, 60 * S]], processed: [] }), false);
  assert.equal(isStarved({ ...starving, playhead: 30 * S, decoded: [[20 * S, 60 * S]], processed: [] }), false);
});

test('not starved while enough processed audio is ahead', () => {
  assert.equal(isStarved({ ...starving, playhead: 5 * S, decoded: [], processed: [[5 * S, 36 * S]] }), false);
});

test('decoded audio that ends ahead of the playhead is not starvation', () => {
  assert.equal(isStarved({ ...starving, playhead: 10 * S, processed: [[10 * S, 20 * S]], decoded: [[0, 25 * S]] }), false);
});
