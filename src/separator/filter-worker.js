import createDpdfBindings from 'dpdf-bindings';
import { wrapDpdf } from '../pipeline/dpdf-filter.js';
import { createSerialQueue } from '../pipeline/stream-engine.js';
import { createReadAheadFilters } from './read-ahead-filters.js';

const DPDF_WASM_URL = new URL('../assets/dpdf_bg.wasm', import.meta.url);
const DPDF_MODEL_URLS = {
  dpdfnet4: new URL('../assets/dpdfnet4.onnx', import.meta.url),
  dpdfnet2: new URL('../assets/dpdfnet2.onnx', import.meta.url),
};
const DETECTOR_MODEL_URL = new URL('../assets/music-detector-mn05.onnx', import.meta.url);
const DPDF_SAMPLE_RATE = 48000;
let dpdfModule;
const warmModels = new Set();
let discards = 0;
const oneAtATime = createSerialQueue();

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function compileDpdf() {
  dpdfModule ??= fetchBytes(DPDF_WASM_URL).then((bytes) => WebAssembly.compile(bytes));
  dpdfModule.catch(() => {
    dpdfModule = undefined;
  });
  return dpdfModule;
}

async function instantiateDpdf() {
  const module = await compileDpdf();
  const { Dpdf, MusicDetector, initSync } = createDpdfBindings();
  initSync({ module });
  return {
    createEngine: (modelBytes) => wrapDpdf(new Dpdf(modelBytes)),
    createDetector: (modelBytes) => {
      const detector = new MusicDetector(modelBytes);
      return { frameProbabilities: (samples) => detector.frame_probabilities(samples) };
    },
  };
}

const filters = createReadAheadFilters({
  instantiate: instantiateDpdf,
  fetchModel: (model) => fetchBytes(DPDF_MODEL_URLS[model]),
  fetchDetector: () => fetchBytes(DETECTOR_MODEL_URL),
  onDiscard: () => {
    discards++;
    warmModels.clear();
  },
});

async function filterWindow({ model, sampleRate, left, right, contextBefore, contextAfter, keepOtherSounds }) {
  if (sampleRate !== DPDF_SAMPLE_RATE) throw new Error(`DPDFNet needs ${DPDF_SAMPLE_RATE} Hz audio, got ${sampleRate} Hz`);
  if (!Object.hasOwn(DPDF_MODEL_URLS, model)) throw new Error(`unknown model ${model}`);
  // The model choice compares compute time across windows, so loading a model must not count toward it.
  await filters.load(model);
  if (keepOtherSounds) await filters.loadDetector();
  const isWarm = warmModels.has(model);
  const discardsBefore = discards;
  const startedAt = performance.now();
  const output = await filters.filter(left, right, sampleRate, { contextBefore, contextAfter, model, keepOtherSounds });
  if (discards === discardsBefore) warmModels.add(model);
  return { output, computeMs: performance.now() - startedAt, isWarm };
}

function serve(port) {
  port.onmessage = ({ data }) => {
    if (data.type === 'load') {
      filters.load(data.model).catch(() => {});
      return;
    }
    if (data.type !== 'filter') return;
    oneAtATime(() => filterWindow(data))
      .then(({ output: [left, right, passthrough], computeMs, isWarm }) =>
        port.postMessage({ type: 'filtered', id: data.id, left, right, passthrough, computeMs, isWarm }, [
          ...new Set([left.buffer, right.buffer]),
        ]),
      )
      .catch((error) => port.postMessage({ type: 'error', id: data.id, message: error.message }));
  };
}

self.onmessage = ({ data, ports }) => {
  if (data.type === 'port' && ports[0]) serve(ports[0]);
};
