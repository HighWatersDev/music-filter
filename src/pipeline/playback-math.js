import { addRange, covers } from './ranges.js';

export function outputLatencyOf(context) {
  return context.outputLatency || context.baseLatency || 0;
}

export function mediaToContext({ media, mediaNow, ctxNow, latency = 0 }) {
  return ctxNow + (media - mediaNow) - latency;
}

export function scheduleSpan({ windowStart, windowEnd, mediaNow, ctxNow, lead = 0.05, latency = 0, notBefore = windowStart }) {
  const startMedia = Math.max(windowStart, notBefore, mediaNow + lead + latency);
  if (startMedia >= windowEnd) return null;
  return {
    when: mediaToContext({ media: startMedia, mediaNow, ctxNow, latency }),
    offset: startMedia - windowStart,
    duration: windowEnd - startMedia,
    startMedia,
  };
}

export function crossfadeSpan({ previousEnd, nextStart, mediaNow, lead = 0.05, latency = 0 }) {
  const from = Math.max(nextStart, mediaNow + lead + latency);
  if (from >= previousEnd) return null;
  return { from, to: previousEnd };
}

export function crossfadeStart({ previousEnd, previousSettled, overlap }) {
  return Math.max(previousEnd - overlap, previousSettled);
}

export class GainEnvelope {
  constructor(param) {
    this.param = param;
    this.initial = param.value;
    this.events = [];
  }

  set(value, time) {
    this.param.setValueAtTime(value, time);
    this.insert({ type: 'set', value, time });
  }

  ramp(value, time) {
    this.param.linearRampToValueAtTime(value, time);
    this.insert({ type: 'ramp', value, time });
  }

  holdAt(time) {
    const value = this.valueAt(time);
    this.param.cancelScheduledValues(time);
    this.events = this.events.filter((event) => event.time < time);
    this.ramp(value, time);
  }

  insert(event) {
    const at = this.events.findIndex((other) => other.time > event.time);
    this.events.splice(at === -1 ? this.events.length : at, 0, event);
  }

  valueAt(time) {
    let before = null;
    for (const event of this.events) {
      if (event.time > time) {
        if (event.type !== 'ramp') break;
        const from = before ?? { time: 0, value: this.initial };
        if (event.time === from.time) return event.value;
        return from.value + ((event.value - from.value) * (time - from.time)) / (event.time - from.time);
      }
      before = event;
    }
    return before ? before.value : this.initial;
  }
}

export function overlapPlan({ startMedia, windowEnd, playing }) {
  const union = playing.reduce((ranges, { start, end }) => addRange(ranges, start, end), []);
  if (covers(union, startMedia, windowEnd)) return { skip: true, previous: -1 };
  let previous = -1;
  playing.forEach(({ end }, index) => {
    if (end <= startMedia || end >= windowEnd) return;
    if (previous === -1 || end > playing[previous].end) previous = index;
  });
  return { skip: false, previous };
}

export function measureDrift({ anchorCtx, anchorMedia, ctxNow, mediaNow }) {
  return ctxNow - anchorCtx - (mediaNow - anchorMedia);
}

export function trackPlayhead(lastMoved, mediaNow, ctxNow, limitSeconds = 0.5) {
  if (!lastMoved || mediaNow !== lastMoved.media) return { lastMoved: { media: mediaNow, ctx: ctxNow }, isFrozen: false };
  return { lastMoved, isFrozen: ctxNow - lastMoved.ctx > limitSeconds };
}
