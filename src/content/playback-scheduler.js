import { readyAheadSeconds } from '../pipeline/hold-policy.js';
import { crossfadeSpan, measureDrift, scheduleSpan } from '../pipeline/playback-math.js';
import { addRange } from '../pipeline/ranges.js';

const HORIZON_SECONDS = 2;
const KEEP_BEHIND_SECONDS = 30;
const KEEP_AHEAD_SECONDS = 90;
const DRIFT_LIMIT_SECONDS = 0.08;

export class PlaybackScheduler {
  constructor(context, video) {
    this.context = context;
    this.video = video;
    this.bus = new GainNode(context, { gain: 1 });
    this.bus.connect(context.destination);
    this.windows = [];
    this.ranges = [];
    this.playing = new Map();
    this.anchor = null;
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
      return;
    }
    if (this.anchor && Math.abs(measureDrift({ ...this.anchor, ctxNow, mediaNow })) > DRIFT_LIMIT_SECONDS) this.stopAll();
    for (const window of this.windows) {
      if (this.playing.has(window) || window.end <= mediaNow || window.start > mediaNow + HORIZON_SECONDS) continue;
      this.start(window, mediaNow, ctxNow);
    }
  }

  start(window, mediaNow, ctxNow) {
    const span = scheduleSpan({ windowStart: window.start, windowEnd: window.end, mediaNow, ctxNow });
    if (!span) return;
    const toContext = (media) => ctxNow + (media - mediaNow);
    const source = new AudioBufferSourceNode(this.context, { buffer: window.buffer });
    const gain = new GainNode(this.context, { gain: 1 });
    source.connect(gain).connect(this.bus);

    const previous = [...this.playing.entries()].find(([other]) => other.start < window.start && other.end > span.startMedia);
    if (previous) {
      const fade = crossfadeSpan({ previousEnd: previous[0].end, nextStart: window.start, mediaNow });
      if (fade) {
        gain.gain.setValueAtTime(0, ctxNow);
        gain.gain.setValueAtTime(0, toContext(fade.from));
        gain.gain.linearRampToValueAtTime(1, toContext(fade.to));
        previous[1].gain.gain.setValueAtTime(1, toContext(fade.from));
        previous[1].gain.gain.linearRampToValueAtTime(0, toContext(fade.to));
      }
    }

    source.start(span.when, span.offset, span.duration);
    source.onended = () => {
      if (this.playing.get(window)?.source === source) this.playing.delete(window);
    };
    this.playing.set(window, { source, gain });
    this.anchor ??= { anchorCtx: ctxNow, anchorMedia: mediaNow };
  }

  stopAll() {
    for (const { source } of this.playing.values()) {
      try {
        source.stop();
      } catch {}
    }
    this.playing.clear();
    this.anchor = null;
  }

  reset() {
    this.stopAll();
    this.windows = [];
    this.ranges = [];
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
