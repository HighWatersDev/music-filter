import createDpdfBindings from 'dpdf-bindings';
import { wrapDpdf } from '../pipeline/dpdf-filter.js';
import { createSerialQueue } from '../pipeline/stream-engine.js';
import { createReadAheadFilters } from './read-ahead-filters.js';

const DPDF_WASM_URL = new URL('../assets/dpdf_bg.wasm', import.meta.url);
const DPDF_MODEL_URLS = {
  dpdfnet4: new URL('../assets/dpdfnet4.onnx', import.meta.url),
  dpdfnet2: new URL('../assets/dpdfnet2.onnx', import.meta.url),
};
const DPDF_SAMPLE_RATE = 48000;
let dpdfModule;
const warmModels = new Set();
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
  const { Dpdf, initSync } = createDpdfBindings();
  initSync({ module });
  return { createEngine: (modelBytes) => wrapDpdf(new Dpdf(modelBytes)) };
}

const filters = createReadAheadFilters({
  instantiate: instantiateDpdf,
  fetchModel: (model) => fetchBytes(DPDF_MODEL_URLS[model]),
});

async function filterWindow({ model, sampleRate, left, right, contextBefore }) {
  if (sampleRate !== DPDF_SAMPLE_RATE) throw new Error(`DPDFNet needs ${DPDF_SAMPLE_RATE} Hz audio, got ${sampleRate} Hz`);
  if (!Object.hasOwn(DPDF_MODEL_URLS, model)) throw new Error(`unknown model ${model}`);
  // The model choice compares compute time across windows, so loading a model must not count toward it.
  await filters.load(model);
  const isWarm = warmModels.has(model);
  const startedAt = performance.now();
  let output;
  try {
    output = await filters.filter(left, right, sampleRate, { contextBefore, model });
  } catch (error) {
    warmModels.clear();
    throw error;
  }
  warmModels.add(model);
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
      .then(({ output: [left, right], computeMs, isWarm }) =>
        port.postMessage({ type: 'filtered', id: data.id, left, right, computeMs, isWarm }, [...new Set([left.buffer, right.buffer])]),
      )
      .catch((error) => port.postMessage({ type: 'error', id: data.id, message: error.message }));
  };
}

self.onmessage = ({ data, ports }) => {
  if (data.type === 'port' && ports[0]) serve(ports[0]);
};
