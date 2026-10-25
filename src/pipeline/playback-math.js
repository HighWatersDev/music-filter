export function scheduleSpan({ windowStart, windowEnd, mediaNow, ctxNow, lead = 0.05 }) {
  const startMedia = Math.max(windowStart, mediaNow + lead);
  if (startMedia >= windowEnd) return null;
  return {
    when: ctxNow + (startMedia - mediaNow),
    offset: startMedia - windowStart,
    duration: windowEnd - startMedia,
    startMedia,
  };
}

export function crossfadeSpan({ previousEnd, nextStart, mediaNow, lead = 0.05 }) {
  const from = Math.max(nextStart, mediaNow + lead);
  if (from >= previousEnd) return null;
  return { from, to: previousEnd };
}

export function measureDrift({ anchorCtx, anchorMedia, ctxNow, mediaNow }) {
  return ctxNow - anchorCtx - (mediaNow - anchorMedia);
}
