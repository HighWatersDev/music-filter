import { createDpdfFilter } from '../pipeline/dpdf-filter.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';

const FIRST_MODEL = 'dpdfnet4';
const QUICK_MODEL = 'dpdfnet2';
const SLOW_FALLBACK = { dpdfnet4: 'dpdfnet2' };
// After a start or seek one DPDFNet-4 window takes about as long as its audio on a mid-range phone, so the
// first windows of a run use DPDFNet-2 and playback resumes sooner. The ramp's third window starts at 4 s.
const QUICK_START_SECONDS = 10;
export const READ_AHEAD_MAX_RTF = 0.6;
// Above this one window takes longer than the audio it covers, which lengthens every hold after a seek.
export const READ_AHEAD_MAX_WINDOW_RTF = 1;

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
      if (!next) return;
      model = next;
      onModelChange({ model, reason });
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
// later call fails with "recursive use of an object". Any error therefore drops the whole instance, and
// the next window instantiates the module again.
export function createReadAheadFilters({ instantiate, fetchModel }) {
  let runtime = null;
  const filters = new Map();

  function discardRuntime() {
    runtime = null;
    filters.clear();
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

  return {
    load: (name) => filterFor(name),
    async filter(left, right, sampleRate, { contextBefore, model = FIRST_MODEL } = {}) {
      const { voiceFilter } = await filterFor(model);
      try {
        return voiceFilter(left, right, { contextBefore });
      } catch (error) {
        discardRuntime();
        throw error;
      }
    },
  };
}
