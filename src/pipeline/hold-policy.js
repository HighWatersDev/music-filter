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
  isAudioRunning,
  processed,
  now,
  duration,
  config = HOLD_CONFIG,
}) {
  const release = (state) => ({ action: isHeld ? 'resume' : 'none', state });
  if (failure) return release('error');
  if (playbackRate !== 1) return release('muted');
  if (!hasStream) {
    if (isHeld && heldSeconds >= config.noStreamTimeoutSeconds) {
      return { action: 'resume', state: 'error', failure: 'no audio stream found' };
    }
    return { action: isPaused ? 'none' : 'pause', state: 'waiting' };
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
  return isPaused ? { action: 'none', state: 'waiting' } : { action: 'pause', state: 'filtering' };
}

export function canPlayProcessed({ state, isPaused, isSeeking, isAudioRunning, readyState }) {
  return state === 'filtered' && !isPaused && !isSeeking && isAudioRunning && readyState >= HAVE_FUTURE_DATA;
}
