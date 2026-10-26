import { createDpdfFilter } from '../pipeline/dpdf-filter.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';

const MODEL = 'dpdfnet4';

// A wasm trap leaves the instance unusable: wasm-bindgen's borrow flag on the engine stays set, so every
// later call fails with "recursive use of an object". Any error therefore drops the whole instance, and
// the next window instantiates the module again.
export function createReadAheadFilters({ instantiate, fetchModel }) {
  let loaded = null;

  function load() {
    loaded ??= Promise.all([instantiate(), fetchModel(MODEL)]).then(([{ createEngine }, bytes]) =>
      createVoiceFilter({ filter: createDpdfFilter({ engine: createEngine(bytes) }) }),
    );
    const pending = loaded;
    pending.catch(() => {
      if (loaded === pending) loaded = null;
    });
    return pending;
  }

  return {
    load,
    get isLoading() {
      return loaded === null;
    },
    async filter(left, right, sampleRate, options = {}) {
      const pending = load();
      const voiceFilter = await pending;
      try {
        return voiceFilter(left, right, options);
      } catch (error) {
        if (loaded === pending) loaded = null;
        throw error;
      }
    },
  };
}
