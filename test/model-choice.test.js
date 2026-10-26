import test from 'node:test';
import assert from 'node:assert/strict';
import { WARMUP_SAMPLE_RATE, createWarmupSignal, judgeWarmup, selectModel, warmUp } from '../src/worklet/model-choice.js';

test('DPDFNet-4 is kept when its warm-up mean is under 2 ms', () => {
  assert.deepEqual(judgeWarmup('dpdfnet4', 1.99), { verdict: 'keep' });
});

test('DPDFNet-4 at 2 ms or more falls back to DPDFNet-2', () => {
  assert.deepEqual(judgeWarmup('dpdfnet4', 2), { verdict: 'fallback', next: 'dpdfnet2' });
  assert.deepEqual(judgeWarmup('dpdfnet4', 2.25), { verdict: 'fallback', next: 'dpdfnet2' });
});

test('DPDFNet-2 is kept under 2 ms and too slow at 2 ms or more', () => {
  assert.deepEqual(judgeWarmup('dpdfnet2', 1.99), { verdict: 'keep' });
  assert.deepEqual(judgeWarmup('dpdfnet2', 2), { verdict: 'too-slow' });
  assert.deepEqual(judgeWarmup('dpdfnet2', 2.19), { verdict: 'too-slow' });
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
    inputs: [],
    resets: 0,
    freed: false,
    processHop(input, output) {
      assert.equal(input.length, 160);
      engine.inputs.push(Float32Array.from(input));
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

function choose(costs, from = 'dpdfnet4', isPinned = false) {
  const clock = fakeClock();
  const log = [];
  const engines = [];
  const result = selectModel({
    from,
    isPinned,
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

test('warm-up runs 70 hops of the warm-up signal and averages the last 40', () => {
  const clock = fakeClock();
  const engine = fakeEngine(clock, 'dpdfnet4', { dpdfnet4: 2 }, []);
  assert.equal(warmUp(engine, clock), 2);
  assert.equal(engine.hops, 70);
  const signal = createWarmupSignal(160 * 70);
  engine.inputs.forEach((input, hop) => assert.deepEqual(input, signal.subarray(hop * 160, (hop + 1) * 160)));
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
  assert.equal(engines[1].hops, 70);
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

test('a pinned model is kept and reset however slow its warm-up is', () => {
  const { result, log } = choose({ dpdfnet4: 3.125, dpdfnet2: 2.5 }, 'dpdfnet4', true);
  assert.equal(result.model, 'dpdfnet4');
  assert.deepEqual(result.warmupMs, { dpdfnet4: 3.125 });
  assert.deepEqual(log, ['create dpdfnet4', 'reset dpdfnet4']);
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

const rms = (samples) => Math.sqrt(samples.reduce((total, x) => total + x * x, 0) / samples.length);
const dbfs = (level) => 20 * Math.log10(level);

function bandLevel(samples, frequency) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const phase = (2 * Math.PI * frequency * i) / WARMUP_SAMPLE_RATE;
    re += samples[i] * Math.cos(phase);
    im += samples[i] * Math.sin(phase);
  }
  return Math.hypot(re, im) / samples.length;
}

test('the warm-up signal is deterministic', () => {
  assert.deepEqual(createWarmupSignal(160 * 70), createWarmupSignal(160 * 70));
});

test('the warm-up signal sits at a typical programme level without clipping', () => {
  const signal = createWarmupSignal(160 * 70);
  assert.equal(signal.length, 160 * 70);
  const level = dbfs(rms(signal));
  assert.ok(level > -26 && level < -14, `level ${level.toFixed(1)} dBFS`);
  assert.ok(signal.every((x) => Math.abs(x) < 0.9));
});

test('every warm-up hop carries sound, and the level moves like speech does', () => {
  const signal = createWarmupSignal(160 * 70);
  const hopLevels = [];
  for (let start = 0; start < signal.length; start += 160) hopLevels.push(dbfs(rms(signal.subarray(start, start + 160))));
  assert.ok(Math.min(...hopLevels) > -45, `quietest hop ${Math.min(...hopLevels).toFixed(1)} dBFS`);
  assert.ok(Math.max(...hopLevels) - Math.min(...hopLevels) > 6, 'the envelope is flat');
});

test('the warm-up signal has tonal peaks over a noise floor across the band', () => {
  const signal = createWarmupSignal(160 * 70);
  const tonal = bandLevel(signal, 220);
  const between = bandLevel(signal, 1234.5);
  const high = bandLevel(signal, 6000);
  assert.ok(tonal > 10 * between, `220 Hz ${tonal} vs 1234.5 Hz ${between}`);
  assert.ok(between > 0 && high > 0, 'no broadband noise');
});
