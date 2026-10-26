const WARMUP_HOPS = 50;
const TIMED_HOPS = 40;
const MAX_MEAN_MS = { dpdfnet4: 1.7, dpdfnet2: 2.2 };
const FALLBACK = { dpdfnet4: 'dpdfnet2' };

export function judgeWarmup(model, meanMs) {
  if (!(model in MAX_MEAN_MS)) throw new Error(`unknown live model ${model}`);
  if (meanMs < MAX_MEAN_MS[model]) return { verdict: 'keep' };
  const next = FALLBACK[model];
  return next ? { verdict: 'fallback', next } : { verdict: 'too-slow' };
}

// The first hops are much slower than steady state (about 15 ms, then 2.6 to 3.4 ms), so only
// the last 40 are timed. Their total keeps a 1 ms clock such as Date.now() precise enough.
export function warmUp(engine, clock) {
  const input = new Float32Array(engine.hop);
  const output = new Float32Array(engine.hop);
  for (let i = 0; i < WARMUP_HOPS - TIMED_HOPS; i++) engine.processHop(input, output);
  const start = clock.now();
  for (let i = 0; i < TIMED_HOPS; i++) engine.processHop(input, output);
  return (clock.now() - start) / TIMED_HOPS;
}

export function selectModel({ from, createEngine, clock }) {
  const warmupMs = {};
  let model = from;
  for (;;) {
    const engine = createEngine(model);
    let meanMs;
    try {
      meanMs = warmUp(engine, clock);
    } catch (error) {
      engine.free();
      throw error;
    }
    warmupMs[model] = meanMs;
    const { verdict, next } = judgeWarmup(model, meanMs);
    if (verdict === 'keep') {
      engine.reset();
      return { model, engine, warmupMs };
    }
    engine.free();
    if (verdict === 'too-slow') return { model: null, engine: null, warmupMs };
    model = next;
  }
}
