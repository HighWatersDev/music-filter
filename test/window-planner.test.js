import test from 'node:test';
import assert from 'node:assert/strict';
import { planNextWindow } from '../src/pipeline/window-planner.js';

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

test('never plans a window shorter than the minimum', () => {
  const tooShort = planNextWindow({ ...base, playhead: 9 * S, decoded: [[0, 10.5 * S]], processed: [[0, 10 * S]] });
  assert.equal(tooShort, null);
  const exactlyMinimum = planNextWindow({ ...base, playhead: 9 * S, decoded: [[0, 11 * S]], processed: [[0, 10 * S]] });
  assert.deepEqual(exactlyMinimum, { start: 9 * S, end: 11 * S });
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
