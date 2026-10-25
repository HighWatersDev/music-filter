import { contiguousEnd, nextRangeStart } from './ranges.js';

export function bridgedEnd(ranges, point, maxGap) {
  let end = contiguousEnd(ranges, point);
  for (const [s, e] of ranges) {
    if (e <= end) continue;
    if (s - end > maxGap) break;
    end = e;
  }
  return end;
}

export function bridgedStart(ranges, point, maxGap) {
  let start = point;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [s, e] = ranges[i];
    if (s >= start) continue;
    if (start - e > maxGap) break;
    start = s;
  }
  return start;
}

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
  const runway = processedEnd - playhead;
  if (runway >= lookahead) return null;

  const continuing = processedEnd > playhead;
  const anchor = continuing ? processedEnd - overlap : playhead;
  const start = nextRangeStart(decoded, anchor);
  if (start === null || start - anchor > maxStartGap) return null;

  const target = start + (continuing ? window : firstWindow);
  const decodedEnd = bridgedEnd(decoded, start, maxStartGap);
  if (decodedEnd >= target) return { start, end: target };

  const fresh = decodedEnd - (continuing ? processedEnd : start);
  if (fresh <= 0) return null;
  if (continuing && runway <= minWindow) return { start, end: decodedEnd };
  if (fresh < minWindow || (continuing ? processedEnd : start) - playhead > urgency) return null;
  return { start, end: decodedEnd };
}
