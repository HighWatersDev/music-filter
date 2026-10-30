import test from 'node:test';
import assert from 'node:assert/strict';
import { iconLook, isIconVisible, problemMessage, statusText } from '../src/content/controls-policy.js';

const playing = { state: 'filtered', isPaused: false, secondsSinceActivity: 60 };

test('the icon hides during playback once the pointer has been still for 3 s', () => {
  assert.equal(isIconVisible(playing), false);
  assert.equal(isIconVisible({ ...playing, secondsSinceActivity: 2.9 }), true);
  assert.equal(isIconVisible({ ...playing, secondsSinceActivity: 3 }), false);
});

test('the icon shows while the video is paused, as YouTube shows its controls', () => {
  assert.equal(isIconVisible({ ...playing, isPaused: true }), true);
  assert.equal(isIconVisible({ ...playing, state: 'off', isPaused: true }), true);
});

test('the icon stays visible while the filter is busy, so a held video explains itself', () => {
  for (const state of ['waiting', 'starting', 'filtering']) assert.equal(isIconVisible({ ...playing, state }), true, state);
});

test('a problem does not pin the icon on screen, the message announces it instead', () => {
  for (const state of ['error', 'muted', 'too-slow', 'off']) assert.equal(isIconVisible({ ...playing, state }), false, state);
});

test('iconLook groups states into off, on, busy and problem', () => {
  assert.equal(iconLook('off'), 'off');
  assert.equal(iconLook('filtered'), 'on');
  for (const state of ['waiting', 'starting', 'filtering']) assert.equal(iconLook(state), 'busy', state);
  for (const state of ['error', 'muted', 'too-slow']) assert.equal(iconLook(state), 'problem', state);
});

test('statusText describes each state, with the detail where it helps', () => {
  assert.equal(statusText({ isOn: false, state: 'off' }), '');
  assert.equal(statusText({ isOn: true, state: 'filtered', mode: 'read-ahead', aheadSeconds: 27.6, detail: '' }), 'Filtered · 28 s ready');
  assert.equal(
    statusText({ isOn: true, state: 'filtered', mode: 'live', aheadSeconds: 0, detail: 'live, DPDFNet-2, 98 ms delay' }),
    'Filtered · live, DPDFNet-2, 98 ms delay',
  );
  assert.equal(statusText({ isOn: true, state: 'filtering', detail: 'reloading audio' }), 'Filtering… · reloading audio');
  assert.equal(statusText({ isOn: true, state: 'muted', detail: 'x' }), 'Filter works at Normal speed');
  assert.equal(statusText({ isOn: true, state: 'error', detail: 'unsupported audio type' }), "Can't filter this video: unsupported audio type");
});

test('problemMessage announces entering a problem, and a new error detail, but not staying in one', () => {
  const on = { isOn: true, state: 'filtered', detail: '', mode: 'read-ahead', aheadSeconds: 10 };
  const error = { ...on, state: 'error', detail: 'unsupported audio type' };
  assert.deepEqual(problemMessage(on, error), { text: "Can't filter this video: unsupported audio type", seconds: 5 });
  assert.equal(problemMessage(error, error), null);
  assert.deepEqual(problemMessage(error, { ...error, detail: 'no filtered audio after 30 s' }), {
    text: "Can't filter this video: no filtered audio after 30 s",
    seconds: 5,
  });
  assert.deepEqual(problemMessage(on, { ...on, state: 'muted' }), { text: 'Filter works at Normal speed', seconds: 5 });
  assert.equal(problemMessage(on, { ...on, state: 'filtering' }), null);
  assert.equal(problemMessage(error, { ...on, isOn: false, state: 'off' }), null);
});
