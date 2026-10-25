import test from 'node:test';
import assert from 'node:assert/strict';
import { decideHold, readyAheadSeconds } from '../src/pipeline/hold-policy.js';

const playing = {
  failure: null,
  hasStream: true,
  playbackRate: 1,
  isPaused: false,
  isHeld: false,
  heldSeconds: 0,
  isAudioRunning: true,
  processed: [],
  now: 40,
  duration: 60,
};

test('readyAheadSeconds counts from the playhead and allows a small gap before the first window', () => {
  const processed = [[0.0065, 2.0065], [5, 9]];
  assert.ok(Math.abs(readyAheadSeconds(processed, 0) - 2.0065) < 1e-9);
  assert.ok(Math.abs(readyAheadSeconds(processed, 1) - 1.0065) < 1e-9);
  assert.equal(readyAheadSeconds(processed, 4), 0);
  assert.ok(Math.abs(readyAheadSeconds(processed, 4.6) - 4.4) < 1e-9);
  assert.equal(readyAheadSeconds(processed, 10), 0);
});

test('playing without filtered audio at the playhead pauses', () => {
  assert.deepEqual(decideHold({ ...playing, processed: [[40, 40.2]] }), { action: 'pause', state: 'filtering' });
  assert.deepEqual(decideHold({ ...playing, processed: [[40, 40.4]] }), { action: 'none', state: 'filtered' });
});

test('a held video resumes once 2 s are ready, or the rest of the video', () => {
  const held = { ...playing, isPaused: true, isHeld: true };
  assert.deepEqual(decideHold({ ...held, processed: [[40, 41.9]] }), { action: 'none', state: 'filtering' });
  assert.deepEqual(decideHold({ ...held, processed: [[40, 42]] }), { action: 'resume', state: 'filtered' });
  assert.deepEqual(decideHold({ ...held, now: 58.8, processed: [[50, 59.98]] }), { action: 'resume', state: 'filtered' });
});

test('pressing play while held and not ready pauses again', () => {
  assert.deepEqual(decideHold({ ...playing, isHeld: true, processed: [[40, 41]] }), { action: 'pause', state: 'filtering' });
});

test('a pause the user made is left alone', () => {
  const paused = { ...playing, isPaused: true };
  assert.deepEqual(decideHold(paused), { action: 'none', state: 'waiting' });
  assert.deepEqual(decideHold({ ...paused, processed: [[40, 50]] }), { action: 'none', state: 'filtered' });
});

test('speeds other than 1x mute instead of holding and release a hold', () => {
  assert.deepEqual(decideHold({ ...playing, playbackRate: 1.5 }), { action: 'none', state: 'muted' });
  assert.deepEqual(decideHold({ ...playing, playbackRate: 1.5, isPaused: true, isHeld: true }), {
    action: 'resume',
    state: 'muted',
  });
});

test('a failure or a hold that lasts too long releases the video', () => {
  const held = { ...playing, isPaused: true, isHeld: true };
  assert.deepEqual(decideHold({ ...held, failure: 'codec A_AAC is not supported' }), { action: 'resume', state: 'error' });
  assert.deepEqual(decideHold({ ...held, heldSeconds: 30 }), {
    action: 'resume',
    state: 'error',
    failure: 'no filtered audio after 30 s',
  });
});

test('no stream or a stopped audio context is never treated as ready', () => {
  assert.deepEqual(decideHold({ ...playing, hasStream: false }), { action: 'none', state: 'waiting' });
  assert.deepEqual(decideHold({ ...playing, isAudioRunning: false, processed: [[40, 50]] }), {
    action: 'pause',
    state: 'filtering',
  });
});
