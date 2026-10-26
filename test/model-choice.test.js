import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeWarmup, selectModel, warmUp } from '../src/worklet/model-choice.js';

test('DPDFNet-4 is kept when its warm-up mean is under 1.7 ms', () => {
  assert.deepEqual(judgeWarmup('dpdfnet4', 1.69), { verdict: 'keep' });
});

test('DPDFNet-4 at 1.7 ms or more falls back to DPDFNet-2', () => {
  assert.deepEqual(judgeWarmup('dpdfnet4', 1.7), { verdict: 'fallback', next: 'dpdfnet2' });
  assert.deepEqual(judgeWarmup('dpdfnet4', 2.16), { verdict: 'fallback', next: 'dpdfnet2' });
});

test('DPDFNet-2 is kept under 2.2 ms and too slow at 2.2 ms or more', () => {
  assert.deepEqual(judgeWarmup('dpdfnet2', 2.19), { verdict: 'keep' });
  assert.deepEqual(judgeWarmup('dpdfnet2', 2.2), { verdict: 'too-slow' });
});

test('an unknown model is rejected', () => {
  assert.throws(() => judgeWarmup('dfn3', 0.5), /dfn3/);
});

function fakeClock() {
  const clock = { time: 0, now: () => clock.time };
  return clock;
}

function fakeEngine(clock, model, costs, log) {
  const engine = {
    model,
    hop: 160,
    hops: 0,
    resets: 0,
    freed: false,
    processHop(input, output) {
      assert.equal(input.length, 160);
      assert.ok(input.every((sample) => sample === 0), 'warm-up hops are silent');
      output.fill(0);
      clock.time += engine.hops === 0 ? 15 : costs[model];
      engine.hops++;
    },
    reset() {
      engine.resets++;
      log.push(`reset ${model}`);
    },
    free() {
      engine.freed = true;
      log.push(`free ${model}`);
    },
  };
  return engine;
}

function choose(costs, from = 'dpdfnet4') {
  const clock = fakeClock();
  const log = [];
  const engines = [];
  const result = selectModel({
    from,
    clock,
    createEngine: (model) => {
      log.push(`create ${model}`);
      const engine = fakeEngine(clock, model, costs, log);
      engines.push(engine);
      return engine;
    },
  });
  return { result, log, engines };
}

test('warm-up runs 50 hops and averages the last 40', () => {
  const clock = fakeClock();
  const engine = fakeEngine(clock, 'dpdfnet4', { dpdfnet4: 2 }, []);
  assert.equal(warmUp(engine, clock), 2);
  assert.equal(engine.hops, 50);
});

test('a fast device keeps DPDFNet-4, reset after warm-up', () => {
  const { result, log, engines } = choose({ dpdfnet4: 1.25, dpdfnet2: 0.75 });
  assert.equal(result.model, 'dpdfnet4');
  assert.equal(result.engine, engines[0]);
  assert.deepEqual(result.warmupMs, { dpdfnet4: 1.25 });
  assert.deepEqual(log, ['create dpdfnet4', 'reset dpdfnet4']);
});

test('a slower device frees DPDFNet-4 and keeps DPDFNet-2, reset after its own warm-up', () => {
  const { result, log, engines } = choose({ dpdfnet4: 2.25, dpdfnet2: 1.375 });
  assert.equal(result.model, 'dpdfnet2');
  assert.equal(result.engine, engines[1]);
  assert.equal(engines[0].freed, true);
  assert.equal(engines[1].hops, 50);
  assert.deepEqual(result.warmupMs, { dpdfnet4: 2.25, dpdfnet2: 1.375 });
  assert.deepEqual(log, ['create dpdfnet4', 'free dpdfnet4', 'create dpdfnet2', 'reset dpdfnet2']);
});

test('a device too slow for DPDFNet-2 gets no engine and nothing is left allocated', () => {
  const { result, engines } = choose({ dpdfnet4: 3.125, dpdfnet2: 2.5 });
  assert.equal(result.model, null);
  assert.equal(result.engine, null);
  assert.deepEqual(result.warmupMs, { dpdfnet4: 3.125, dpdfnet2: 2.5 });
  assert.ok(engines.every((engine) => engine.freed));
});

test('a switch starts the choice at DPDFNet-2', () => {
  const { result, log } = choose({ dpdfnet4: 1, dpdfnet2: 1 }, 'dpdfnet2');
  assert.equal(result.model, 'dpdfnet2');
  assert.deepEqual(log, ['create dpdfnet2', 'reset dpdfnet2']);
});

test('an engine that throws during warm-up is freed and the error propagates', () => {
  const freed = [];
  assert.throws(
    () =>
      selectModel({
        from: 'dpdfnet4',
        clock: fakeClock(),
        createEngine: () => ({
          hop: 160,
          processHop() {
            throw new Error('warm-up exploded');
          },
          reset() {},
          free: () => freed.push(true),
        }),
      }),
    /warm-up exploded/,
  );
  assert.deepEqual(freed, [true]);
});
