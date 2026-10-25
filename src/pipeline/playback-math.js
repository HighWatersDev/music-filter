import { addRange, covers } from './ranges.js';

export function outputLatencyOf(context) {
  return context.outputLatency || context.baseLatency || 0;
}

export function mediaToContext({ media, mediaNow, ctxNow, latency = 0 }) {
  return ctxNow + (media - mediaNow) - latency;
}

export function scheduleSpan({ windowStart, windowEnd, mediaNow, ctxNow, lead = 0.05, latency = 0 }) {
  const startMedia = Math.max(windowStart, mediaNow + lead + latency);
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
