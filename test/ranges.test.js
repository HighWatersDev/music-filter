import test from 'node:test';
import assert from 'node:assert/strict';
import { addRange, contiguousEnd, covers, nextRangeStart, trimBefore } from '../src/pipeline/ranges.js';

test('addRange merges overlapping and touching ranges', () => {
  let ranges = [];
  ranges = addRange(ranges, 10, 20);
  ranges = addRange(ranges, 30, 40);
  ranges = addRange(ranges, 20, 25);
  assert.deepEqual(ranges, [[10, 25], [30, 40]]);
  ranges = addRange(ranges, 24, 31);
  assert.deepEqual(ranges, [[10, 40]]);
  assert.deepEqual(addRange(ranges, 5, 5), [[10, 40]]);
});

test('contiguousEnd, covers and nextRangeStart', () => {
  const ranges = [[10, 25], [30, 40]];
  assert.equal(contiguousEnd(ranges, 12), 25);
  assert.equal(contiguousEnd(ranges, 26), 26);
  assert.equal(covers(ranges, 10, 25), true);
  assert.equal(covers(ranges, 20, 31), false);
  assert.equal(nextRangeStart(ranges, 26), 30);
  assert.equal(nextRangeStart(ranges, 12), 12);
  assert.equal(nextRangeStart(ranges, 41), null);
});

test('trimBefore drops and clips', () => {
  assert.deepEqual(trimBefore([[10, 25], [30, 40]], 32), [[32, 40]]);
});
