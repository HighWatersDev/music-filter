import { createDpdfFilter } from '../pipeline/dpdf-filter.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';

const FIRST_MODEL = 'dpdfnet4';
const SLOW_FALLBACK = { dpdfnet4: 'dpdfnet2' };
export const READ_AHEAD_MAX_RTF = 0.6;
// Above this one window takes longer than the audio it covers, which lengthens every hold after a seek.
export const READ_AHEAD_MAX_WINDOW_RTF = 1;

export const windowRtf = ({ computeMs, samples, sampleRate }) => computeMs / 1000 / (samples / sampleRate);

export function nextReadAheadModel({ model, rtf }) {
  return rtf > READ_AHEAD_MAX_RTF ? SLOW_FALLBACK[model] ?? model : model;
}

// Short windows and a Worker's first call pay for the cold start, so they would push every phone to
// DPDFNet-2. Windows run in parallel on `workers` Workers, so throughput is the per-window RTF divided by that.
export function createModelPolicy({ workers = 1, minJudgeSeconds = 5, onModelChange = () => {} } = {}) {
  let model = FIRST_MODEL;
  let isJudged = false;
  return {
    get model() {
      return model;
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
        pending.isReady = true;
        return { engine, voiceFilter: createVoiceFilter({ filter: createDpdfFilter({ engine }) }) };
      });
      pending.catch(() => {
        if (filters.get(name) === pending) discardRuntime();
      });
      filters.set(name, pending);
    }
    return filters.get(name);
  }

  // A model still loading was asked for after this window's model, so it is kept for the window after.
  async function freeOthers(name) {
    for (const [other, pending] of filters) {
      if (other === name || !pending.isReady) continue;
      filters.delete(other);
      (await pending).engine.free();
    }
  }

  return {
    load: (name) => filterFor(name),
    async filter(left, right, sampleRate, { contextBefore, model = FIRST_MODEL } = {}) {
      await freeOthers(model);
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
