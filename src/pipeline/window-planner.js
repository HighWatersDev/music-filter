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

function processedRunEnd(processed, playhead, maxStartGap) {
  const start = nextRangeStart(processed, playhead);
  return start !== null && start - playhead <= maxStartGap ? contiguousEnd(processed, start) : playhead;
}

export function isStarved({ playhead, decoded, processed, lookahead, maxStartGap }) {
  if (processedRunEnd(processed, playhead, maxStartGap) - playhead >= lookahead) return false;
  const start = nextRangeStart(decoded, playhead);
  return start === null || start - playhead > maxStartGap;
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
  ramp = false,
}) {
  const processedEnd = processedRunEnd(processed, playhead, maxStartGap);
  const runway = processedEnd - playhead;
  if (runway >= lookahead) return null;

  const continuing = processedEnd > playhead;
  const anchor = continuing ? processedEnd - overlap : playhead;
  const start = nextRangeStart(decoded, anchor);
  if (start === null || start - anchor > maxStartGap) return null;

  // After a start or a seek the processed run is short, and shorter windows finish sooner, which shortens the
  // holds. The length follows the run, not the runway, so a dip in steady play keeps full windows.
  const runLength = processedEnd - bridgedStart(processed, processedEnd, maxStartGap);
  const continuingLength = ramp ? Math.min(window, Math.max(firstWindow, 2 * runLength)) : window;
  const target = start + (continuing ? continuingLength : firstWindow);
  const decodedEnd = bridgedEnd(decoded, start, maxStartGap);
  if (decodedEnd >= target) return { start, end: target };

  const fresh = decodedEnd - (continuing ? processedEnd : start);
  if (fresh <= 0) return null;
  if (continuing && runway <= minWindow) return { start, end: decodedEnd };
  if (fresh < minWindow || (continuing ? processedEnd : start) - playhead > urgency) return null;
  return { start, end: decodedEnd };
}
