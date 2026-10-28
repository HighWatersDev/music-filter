import { contiguousEnd, nextRangeStart } from './ranges.js';

export const HOLD_CONFIG = {
  playMarginSeconds: 0.3,
  resumeAheadSeconds: 1.5,
  startGapSeconds: 0.5,
  endSlackSeconds: 0.5,
  holdTimeoutSeconds: 30,
  noStreamTimeoutSeconds: 10,
};

const HAVE_FUTURE_DATA = 3;

export function readyAheadSeconds(processed, now, startGapSeconds = HOLD_CONFIG.startGapSeconds) {
  const start = nextRangeStart(processed, now);
  if (start === null || start - now > startGapSeconds) return 0;
  return contiguousEnd(processed, start) - now;
}

export function decideHold({
  failure,
  hasStream,
  playbackRate,
  isPaused,
  isHeld,
  heldSeconds,
  playRequestedSeconds = 0,
  isAudioRunning,
  processed,
  now,
  duration,
  readyState = HAVE_FUTURE_DATA,
  config = HOLD_CONFIG,
}) {
  const release = (state) => ({ action: isHeld ? 'resume' : 'none', state });
  // A video without future data is not advancing, so there is nothing to hold yet. Pausing it then also
  // stops YouTube from recovering when its first source fails to decode, and it never plays again.
  const holdAction = isPaused || readyState < HAVE_FUTURE_DATA ? 'none' : 'pause';
  if (failure) return release('error');
  if (playbackRate !== 1) return release('muted');
  if (!hasStream) {
    const waitedSeconds = Math.max(isHeld ? heldSeconds : 0, playRequestedSeconds);
    if (waitedSeconds >= config.noStreamTimeoutSeconds) return { ...release('error'), failure: 'no audio stream found' };
    return { action: holdAction, state: 'waiting' };
  }

  const remaining = Number.isFinite(duration) ? Math.max(0, duration - now - config.endSlackSeconds) : Infinity;
  const ahead = isAudioRunning ? readyAheadSeconds(processed, now, config.startGapSeconds) : 0;
  if (isHeld) {
    if (ahead >= Math.min(config.resumeAheadSeconds, remaining)) return { action: 'resume', state: 'filtered' };
    if (heldSeconds >= config.holdTimeoutSeconds) {
      return { action: 'resume', state: 'error', failure: `no filtered audio after ${config.holdTimeoutSeconds} s` };
    }
    return { action: isPaused ? 'none' : 'pause', state: 'filtering' };
  }
  const isReady = ahead >= Math.min(config.playMarginSeconds, remaining);
  if (isReady) return { action: 'none', state: 'filtered' };
  return isPaused ? { action: 'none', state: 'waiting' } : { action: holdAction, state: 'filtering' };
}

export function canPlayProcessed({ state, isPaused, isSeeking, isAudioRunning, readyState }) {
  return state === 'filtered' && !isPaused && !isSeeking && isAudioRunning && readyState >= HAVE_FUTURE_DATA;
}
