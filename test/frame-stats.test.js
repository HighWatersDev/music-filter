import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameStats } from '../src/worklet/frame-stats.js';

test('drain summarises recorded durations and resets', () => {
  const stats = new FrameStats({ budgetMs: 90, quantumMs: 50 });
  for (let ms = 1; ms <= 100; ms++) stats.record(ms);

  assert.deepEqual(stats.drain(), {
    count: 100,
    meanMs: 50.5,
    p95Ms: 95,
    maxMs: 100,
    overBudget: 10,
    overQuantum: 50,
    overTwoQuanta: 0,
    budgetMs: 90,
    quantumMs: 50,
  });
  assert.equal(stats.count, 0);
});

test('drain with no samples returns zeros', () => {
  const stats = new FrameStats({ budgetMs: 10, quantumMs: 2.5 });
  assert.deepEqual(stats.drain(), {
    count: 0,
    meanMs: 0,
    p95Ms: 0,
    maxMs: 0,
    overBudget: 0,
    overQuantum: 0,
    overTwoQuanta: 0,
    budgetMs: 10,
    quantumMs: 2.5,
  });
});

test('overTwoQuanta counts frames longer than two render quanta', () => {
  const stats = new FrameStats({ budgetMs: 10, quantumMs: 2.5 });
  for (const ms of [1, 2.6, 4.9, 5, 5.1, 7, 12]) stats.record(ms);
  const summary = stats.drain();
  assert.equal(summary.overQuantum, 6);
  assert.equal(summary.overTwoQuanta, 3);
});
