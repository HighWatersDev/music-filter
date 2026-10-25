import { contiguousEnd, nextRangeStart } from './ranges.js';

export function planNextWindow({
  playhead,
  decoded,
  processed,
  firstWindow,
  window,
  overlap,
  minWindow,
  lookahead,
  urgency,
  maxStartGap,
}) {
  const processedStart = nextRangeStart(processed, playhead);
  const processedEnd =
    processedStart !== null && processedStart - playhead <= maxStartGap ? contiguousEnd(processed, processedStart) : playhead;
  if (processedEnd - playhead >= lookahead) return null;

  const continuing = processedEnd > playhead;
  let start = continuing ? processedEnd - overlap : playhead;
  const decodedStart = nextRangeStart(decoded, start);
  if (decodedStart === null || decodedStart - start > maxStartGap) return null;
  start = decodedStart;

  const target = start + (continuing ? window : firstWindow);
  const decodedEnd = contiguousEnd(decoded, start);
  if (decodedEnd >= target) return { start, end: target };
  if (decodedEnd <= processedEnd) return null;

  const isUrgent = (continuing ? processedEnd : start) - playhead <= urgency;
  if (!isUrgent || decodedEnd - start < minWindow) return null;
  return { start, end: decodedEnd };
}
