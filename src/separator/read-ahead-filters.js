import { createDpdfFilter } from '../pipeline/dpdf-filter.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';
import { GATE, gateCurve, mixGate, openFrames, passthroughRanges } from '../pipeline/music-gate.js';

const FIRST_MODEL = 'dpdfnet4';
const QUICK_MODEL = 'dpdfnet2';
const SLOW_FALLBACK = { dpdfnet4: 'dpdfnet2' };
// After a start or seek one DPDFNet-4 window takes about as long as its audio on a mid-range phone, so the
// first windows of a run use DPDFNet-2 and playback resumes sooner. The ramp's third window starts at 4 s.
const QUICK_START_SECONDS = 10;
export const READ_AHEAD_MAX_RTF = 0.6;
// Above this one window takes longer than the audio it covers, which lengthens every hold after a seek.
export const READ_AHEAD_MAX_WINDOW_RTF = 1;

const EMPTY = new Float32Array(0);

function join(parts) {
  const out = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const windowRtf = ({ computeMs, samples, sampleRate }) => computeMs / 1000 / (samples / sampleRate);

export function nextReadAheadModel({ model, rtf }) {
  return rtf > READ_AHEAD_MAX_RTF ? SLOW_FALLBACK[model] ?? model : model;
}

// Short windows and a Worker's first call pay for the cold start, so they would push every phone to
// DPDFNet-2. Windows run in parallel on `workers` Workers, so throughput is the per-window RTF divided by that.
export function createModelPolicy({
  workers = 1,
  minJudgeSeconds = 5,
  quickStartSeconds = QUICK_START_SECONDS,
  onModelChange = () => {},
} = {}) {
  let model = FIRST_MODEL;
  let isJudged = false;
  return {
    get model() {
      return model;
    },
    modelFor({ runSeconds }) {
      return runSeconds < quickStartSeconds ? QUICK_MODEL : model;
    },
    fallBack(reason) {
      const next = SLOW_FALLBACK[model];
      if (!next) return false;
      model = next;
      onModelChange({ model, reason });
      return true;
    },
    observe({ model: used, isWarm, computeMs, samples, sampleRate }) {
      if (isJudged || !isWarm || used !== model || samples / sampleRate < minJudgeSeconds) return;
      isJudged = true;
      const rtf = windowRtf({ computeMs, samples, sampleRate });
      const throughputRtf = rtf > READ_AHEAD_MAX_WINDOW_RTF ? Infinity : rtf / workers;
      const next = nextReadAheadModel({ model, rtf: throughputRtf });
      if (next === model) return;
      model = next;
      onModelChange({ model, rtf });
    },
  };
}

// Both models stay built, because quick-start windows use DPDFNet-2 and later windows DPDFNet-4.
// A wasm trap leaves the instance unusable: wasm-bindgen's borrow flag on the engine stays set, so every
// later call fails with "recursive use of an object". Any filter error therefore drops the whole instance, and
// the next window instantiates the module again. A detector that returns an error has not trapped, so only a
// trap there drops the instance.
export function createReadAheadFilters({ instantiate, fetchModel, fetchDetector, onDiscard = () => {} }) {
  let runtime = null;
  let detector = null;
  const filters = new Map();

  function discardRuntime() {
    runtime = null;
    detector = null;
    filters.clear();
    onDiscard();
  }

  function filterFor(name) {
    if (!filters.has(name)) {
      runtime ??= instantiate();
      const pending = Promise.all([runtime, fetchModel(name)]).then(([{ createEngine }, bytes]) => {
        const engine = createEngine(bytes);
        return { engine, voiceFilter: createVoiceFilter({ filter: createDpdfFilter({ engine }) }) };
      });
      pending.catch(() => {
        if (filters.get(name) === pending) discardRuntime();
      });
      filters.set(name, pending);
    }
    return filters.get(name);
  }

  // A detector that fails to load leaves the window filtered, and the next window tries again.
  function detectorFor() {
    if (!detector) {
      runtime ??= instantiate();
      const pending = Promise.all([runtime, fetchDetector()]).then(([{ createDetector }, bytes]) => createDetector(bytes));
      pending.catch(() => {
        if (detector === pending) detector = null;
      });
      detector = pending;
    }
    return detector;
  }

  // The window is filtered together with the audio around it, because the gate needs 1.5 s of scores
  // on each side and each score needs 1 s of audio on each side.
  async function gatedFilter(voiceFilter, left, right, sampleRate, { contextBefore, contextAfter }) {
    const [beforeLeft = EMPTY, beforeRight = EMPTY] = contextBefore ?? [];
    const [afterLeft = EMPTY, afterRight = EMPTY] = contextAfter ?? [];
    const spanLeft = join([beforeLeft, left, afterLeft]);
    const spanRight = join([beforeRight, right, afterRight]);
    const [voice] = voiceFilter(spanLeft, spanRight);
    const start = beforeLeft.length;
    const windowVoice = voice.subarray(start, start + left.length);
    const filtered = () => [windowVoice.slice(), windowVoice.slice(), []];

    const loaded = await detectorFor().catch(() => null);
    if (!loaded) return filtered();
    const residual = new Float32Array(voice.length);
    for (let i = 0; i < voice.length; i++) residual[i] = 0.5 * (spanLeft[i] + spanRight[i]) - voice[i];
    let probabilities;
    try {
      probabilities = loaded.frameProbabilities(residual);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) discardRuntime();
      return filtered();
    }
    const curve = gateCurve(openFrames(probabilities), {
      frameSamples: GATE.frameSeconds * sampleRate,
      length: voice.length,
      fadeSamples: GATE.fadeSeconds * sampleRate,
    }).subarray(start, start + left.length);
    const [outLeft, outRight] = mixGate([left, right], [windowVoice, windowVoice], curve);
    return [outLeft, outRight, passthroughRanges(curve, sampleRate)];
  }

  return {
    load: (name) => filterFor(name),
    loadDetector: () => detectorFor().then(
      () => {},
      () => {},
    ),
    async filter(left, right, sampleRate, { contextBefore, contextAfter, model = FIRST_MODEL, keepOtherSounds = false } = {}) {
      const { voiceFilter } = await filterFor(model);
      try {
        if (keepOtherSounds) return await gatedFilter(voiceFilter, left, right, sampleRate, { contextBefore, contextAfter });
        return voiceFilter(left, right, { contextBefore });
      } catch (error) {
        discardRuntime();
        throw error;
      }
    },
  };
}
