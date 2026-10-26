import { createDpdfFilter } from '../pipeline/dpdf-filter.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';

const FIRST_MODEL = 'dpdfnet4';
const SLOW_FALLBACK = { dpdfnet4: 'dpdfnet2' };
export const READ_AHEAD_MAX_RTF = 0.6;

export const windowRtf = ({ computeMs, samples, sampleRate }) => computeMs / 1000 / (samples / sampleRate);

export function nextReadAheadModel({ model, rtf }) {
  return rtf > READ_AHEAD_MAX_RTF ? SLOW_FALLBACK[model] ?? model : model;
}

// A wasm trap leaves the instance unusable: wasm-bindgen's borrow flag on the engine stays set, so every
// later call fails with "recursive use of an object". Any error therefore drops the whole instance, and
// the next window instantiates the module again.
export function createReadAheadFilters({ instantiate, fetchModel, now = () => performance.now(), onModelChange = () => {} }) {
  let runtime = null;
  const filters = new Map();
  let model = FIRST_MODEL;
  let isJudged = false;

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

  async function switchTo(next) {
    const previous = filters.get(model);
    filters.delete(model);
    model = next;
    (await previous)?.engine.free();
  }

  return {
    load: () => filterFor(model),
    get isLoading() {
      return !filters.has(model);
    },
    async filter(left, right, sampleRate, options = {}) {
      const name = model;
      const { voiceFilter } = await filterFor(name);
      const startedAt = now();
      let result;
      try {
        result = voiceFilter(left, right, options);
      } catch (error) {
        discardRuntime();
        throw error;
      }
      if (isJudged) return result;
      isJudged = true;
      const contextSamples = options.contextBefore?.[0]?.length ?? 0;
      const rtf = windowRtf({ computeMs: now() - startedAt, samples: left.length + contextSamples, sampleRate });
      const next = nextReadAheadModel({ model: name, rtf });
      if (next !== name) {
        await switchTo(next);
        onModelChange({ model: next, rtf });
      }
      return result;
    },
    get model() {
      return model;
    },
  };
}
