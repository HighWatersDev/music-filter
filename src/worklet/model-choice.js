export const WARMUP_SAMPLE_RATE = 16000;
const WARMUP_HOPS = 70;
const TIMED_HOPS = 40;
const SIGNAL_SEED = 0x5eed;
const MUSIC_NOTES_HZ = [110, 220, 261.63, 329.63];
const MUSIC_HARMONICS = 6;
const MUSIC_LEVEL = 0.045;
const VOICE_HARMONICS = 16;
const VOICE_LEVEL = 0.13;
const FORMANTS = [
  { hz: 700, width: 250, gain: 3 },
  { hz: 1800, width: 400, gain: 1.5 },
  { hz: 2800, width: 500, gain: 0.8 },
];
const NOISE_LEVEL = 0.004;

// The warm-up runs hops back to back, but playback runs one hop every 10 ms, which costs more
// (headless Chrome, M2 Pro, 2026-10-26). Real-audio p99 reached 2.6x the warm-up mean on DPDFNet-4
// and 3.3x on DPDFNet-2. Chrome renders two quanta (256 frames) per device callback, and only
// hops longer than that underran. Each limit keeps the predicted p99 under two quanta.
const MAX_MEAN_MS = { dpdfnet4: 2, dpdfnet2: 1.6 };
const FALLBACK = { dpdfnet4: 'dpdfnet2' };

export const isLiveModel = (model) => Object.hasOwn(MAX_MEAN_MS, model);

export function judgeWarmup(model, meanMs) {
  if (!isLiveModel(model)) throw new Error(`unknown live model ${model}`);
  if (meanMs < MAX_MEAN_MS[model]) return { verdict: 'keep' };
  const next = FALLBACK[model];
  return next ? { verdict: 'fallback', next } : { verdict: 'too-slow' };
}

function formantGain(hz) {
  let gain = 0.3;
  for (const formant of FORMANTS) gain += formant.gain * Math.exp(-(((hz - formant.hz) / formant.width) ** 2));
  return gain;
}

// Speech over music rather than silence, so a data-dependent fast path in the engine or the
// browser cannot flatter the timing. On Chrome and tract 0.23.8 the two cost the same today.
export function createWarmupSignal(length) {
  let seed = SIGNAL_SEED;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const signal = new Float32Array(length);
  const tau = 2 * Math.PI;
  let voicePhase = 0;
  let syllableStart = 0;
  let syllableLength = 0;
  let isVoiced = false;
  let pink0 = 0;
  let pink1 = 0;
  let pink2 = 0;
  for (let i = 0; i < length; i++) {
    const t = i / WARMUP_SAMPLE_RATE;
    let music = 0;
    for (const note of MUSIC_NOTES_HZ) {
      for (let k = 1; k <= MUSIC_HARMONICS; k++) music += Math.sin(tau * note * k * t) / k;
    }
    music *= MUSIC_LEVEL * (0.8 + 0.2 * Math.sin(tau * 0.5 * t));

    if (i >= syllableStart + syllableLength) {
      syllableStart = i;
      syllableLength = Math.round(WARMUP_SAMPLE_RATE * (0.12 + 0.2 * random()));
      isVoiced = !isVoiced || random() < 0.3;
    }
    const pitch = 140 + 35 * Math.sin(tau * 0.6 * t) + 15 * Math.sin(tau * 1.7 * t);
    voicePhase = (voicePhase + (tau * pitch) / WARMUP_SAMPLE_RATE) % tau;
    let voice = 0;
    if (isVoiced) {
      for (let k = 1; k <= VOICE_HARMONICS; k++) voice += (formantGain(k * pitch) * Math.sin(k * voicePhase)) / k;
      voice *= VOICE_LEVEL * Math.sin((Math.PI * (i - syllableStart)) / syllableLength) ** 2;
    }

    const white = 2 * random() - 1;
    pink0 = 0.99765 * pink0 + white * 0.099046;
    pink1 = 0.963 * pink1 + white * 0.2965164;
    pink2 = 0.57 * pink2 + white * 1.0526913;
    const pink = pink0 + pink1 + pink2 + white * 0.1848;

    signal[i] = music + voice + NOISE_LEVEL * pink;
  }
  return signal;
}

let warmupSignal = null;

// The first hops are much slower than steady state (about 15 ms, then 2.6 to 3.4 ms), so only
// the last 40 are timed. Their total keeps a 1 ms clock such as Date.now() precise enough.
export function warmUp(engine, clock) {
  const { hop } = engine;
  if (warmupSignal?.length !== hop * WARMUP_HOPS) warmupSignal = createWarmupSignal(hop * WARMUP_HOPS);
  const input = new Float32Array(hop);
  const output = new Float32Array(hop);
  const runHop = (index) => {
    for (let i = 0, offset = index * hop; i < hop; i++) input[i] = warmupSignal[offset + i];
    engine.processHop(input, output);
  };
  for (let i = 0; i < WARMUP_HOPS - TIMED_HOPS; i++) runHop(i);
  const start = clock.now();
  for (let i = WARMUP_HOPS - TIMED_HOPS; i < WARMUP_HOPS; i++) runHop(i);
  return (clock.now() - start) / TIMED_HOPS;
}

export function selectModel({ from, isPinned = false, createEngine, clock }) {
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
    if (verdict === 'keep' || isPinned) {
      engine.reset();
      return { model, engine, warmupMs };
    }
    engine.free();
    if (verdict === 'too-slow') return { model: null, engine: null, warmupMs };
    model = next;
  }
}
