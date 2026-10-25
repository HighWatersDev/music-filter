import { readyAheadSeconds } from '../pipeline/hold-policy.js';
import {
  GainEnvelope,
  crossfadeSpan,
  crossfadeStart,
  measureDrift,
  mediaToContext,
  outputLatencyOf,
  overlapPlan,
  scheduleSpan,
  trackPlayhead,
} from '../pipeline/playback-math.js';
import { addRange } from '../pipeline/ranges.js';

const HORIZON_SECONDS = 2;
const KEEP_BEHIND_SECONDS = 30;
const KEEP_AHEAD_SECONDS = 90;
const DRIFT_LIMIT_SECONDS = 0.08;
const STOP_FADE_SECONDS = 0.015;
const CROSSFADE_SECONDS = 1;

export class PlaybackScheduler {
  constructor(context, video) {
    this.context = context;
    this.video = video;
    this.bus = new GainNode(context, { gain: 0 });
    this.bus.connect(context.destination);
    this.windows = [];
    this.ranges = [];
    this.playing = new Map();
    this.anchor = null;
    this.lastMoved = null;
  }

  addWindow({ startSeconds, sampleRate, left, right }) {
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: left.length, sampleRate });
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    this.windows.push({ start: startSeconds, end: startSeconds + left.length / sampleRate, buffer });
    this.windows.sort((a, b) => a.start - b.start);
    this.ranges = addRange(this.ranges, startSeconds, startSeconds + left.length / sampleRate);
  }

  tick({ allowProcessed }) {
    const mediaNow = this.video.currentTime;
    const ctxNow = this.context.currentTime;
    this.evict(mediaNow);
    if (!allowProcessed) {
      this.stopAll();
      this.lastMoved = null;
      return;
    }
    const playhead = trackPlayhead(this.lastMoved, mediaNow, ctxNow);
    this.lastMoved = playhead.lastMoved;
    if (playhead.isFrozen) {
      this.stopAll();
      return;
    }
    if (this.anchor && Math.abs(measureDrift({ ...this.anchor, ctxNow, mediaNow })) > DRIFT_LIMIT_SECONDS) this.stopAll();
    const latency = outputLatencyOf(this.context);
    for (const window of this.windows) {
      if (this.playing.has(window) || window.end <= mediaNow || window.start > mediaNow + HORIZON_SECONDS) continue;
      this.start(window, mediaNow, ctxNow, latency);
    }
  }

  start(window, mediaNow, ctxNow, latency) {
    const timing = { windowStart: window.start, windowEnd: window.end, mediaNow, ctxNow, latency };
    let span = scheduleSpan(timing);
    if (!span) return;
    const playing = [...this.playing.entries()];
    const plan = overlapPlan({
      startMedia: span.startMedia,
      windowEnd: window.end,
      playing: playing.map(([other]) => other),
    });
    if (plan.skip) return;

    const toContext = (media) => mediaToContext({ media, mediaNow, ctxNow, latency });
    const source = new AudioBufferSourceNode(this.context, { buffer: window.buffer });
    const gain = new GainNode(this.context, { gain: 1 });
    const envelope = new GainEnvelope(gain.gain);
    source.connect(gain).connect(this.bus);
    let settled = span.startMedia;

    if (plan.previous !== -1) {
      const [previousWindow, previous] = playing[plan.previous];
      const notBefore = crossfadeStart({ previousEnd: previousWindow.end, previousSettled: previous.settled, overlap: CROSSFADE_SECONDS });
      span = scheduleSpan({ ...timing, notBefore });
      const fade = crossfadeSpan({ previousEnd: previousWindow.end, nextStart: span.startMedia, mediaNow, latency });
      if (fade) {
        envelope.set(0, toContext(fade.from));
        envelope.ramp(1, toContext(fade.to));
        previous.envelope.holdAt(toContext(fade.from));
        previous.envelope.ramp(0, toContext(fade.to));
        settled = fade.to;
      }
    }

    source.start(span.when, span.offset, span.duration);
    source.onended = () => {
      if (this.playing.get(window)?.source === source) this.playing.delete(window);
    };
    this.playing.set(window, { source, gain, envelope, settled });
    this.anchor ??= { anchorCtx: ctxNow, anchorMedia: mediaNow };
  }

  stopAll() {
    const now = this.context.currentTime;
    const stopAt = now + STOP_FADE_SECONDS;
    for (const { source, gain } of this.playing.values()) {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, stopAt);
        source.stop(stopAt);
      } catch {}
    }
    this.playing.clear();
    this.anchor = null;
  }

  reset() {
    this.stopAll();
    this.windows = [];
    this.ranges = [];
    this.lastMoved = null;
  }

  dispose() {
    this.reset();
    this.bus.disconnect();
  }

  setVolume(level) {
    this.bus.gain.setTargetAtTime(level, this.context.currentTime, 0.01);
  }

  secondsAhead() {
    return readyAheadSeconds(this.ranges, this.video.currentTime);
  }

  evict(mediaNow) {
    const keepFrom = mediaNow - KEEP_BEHIND_SECONDS;
    const keepTo = mediaNow + KEEP_AHEAD_SECONDS;
    const kept = this.windows.filter((w) => this.playing.has(w) || (w.end > keepFrom && w.start < keepTo));
    if (kept.length === this.windows.length) return;
    this.windows = kept;
    this.ranges = kept.reduce((ranges, w) => addRange(ranges, w.start, w.end), []);
  }
}
