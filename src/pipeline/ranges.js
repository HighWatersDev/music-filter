export function addRange(ranges, start, end) {
  if (end <= start) return ranges;
  const result = [];
  let merged = [start, end];
  for (const [s, e] of ranges) {
    if (e < merged[0] || s > merged[1]) result.push([s, e]);
    else merged = [Math.min(s, merged[0]), Math.max(e, merged[1])];
  }
  result.push(merged);
  return result.sort((a, b) => a[0] - b[0]);
}

export function contiguousEnd(ranges, point) {
  for (const [s, e] of ranges) if (s <= point && point < e) return e;
  return point;
}

export function covers(ranges, start, end) {
  return end > start && contiguousEnd(ranges, start) >= end;
}

export function nextRangeStart(ranges, point) {
  for (const [s, e] of ranges) {
    if (s <= point && point < e) return point;
    if (s > point) return s;
  }
  return null;
}

export function trimBefore(ranges, point) {
  return ranges.filter(([, e]) => e > point).map(([s, e]) => [Math.max(s, point), e]);
}
