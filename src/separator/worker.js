import createDpdfBindings from 'dpdf-bindings';
import { wrapDpdf } from '../pipeline/dpdf-filter.js';
import { createSerialQueue, StreamEngine } from '../pipeline/stream-engine.js';
import { createReadAheadFilters } from './read-ahead-filters.js';

const post = (message, transfer = []) => self.postMessage(message, transfer);

const STREAM_MESSAGES = new Set(['stream-reset', 'stream-chunk', 'stream-replay-end', 'stream-abort', 'playhead']);
const DPDF_WASM_URL = new URL('../assets/dpdf_bg.wasm', import.meta.url);
const DPDF_MODEL_URLS = {
  dpdfnet4: new URL('../assets/dpdfnet4.onnx', import.meta.url),
  dpdfnet2: new URL('../assets/dpdfnet2.onnx', import.meta.url),
};
const DPDF_SAMPLE_RATE = 48000;
// 'dfn3' is what the read-ahead content script sent before the DPDFNet swap. It now gets DPDFNet-4 too.
const VOICE_MODELS = new Set(['dpdfnet4', 'dfn3']);
let stream = null;
let dpdfModule;
const enqueueSeparation = createSerialQueue();

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

const readAheadFilters = createReadAheadFilters({
  instantiate: instantiateDpdf,
  fetchModel: (model) => fetchBytes(DPDF_MODEL_URLS[model]),
  onModelChange: ({ model, rtf }) => post({ type: 'stream-status', streamId: stream?.id, stage: 'model', model, rtf }),
});

function createWindowFilter(model, streamId) {
  if (model === 'fake') return async (left, right) => [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
  if (!VOICE_MODELS.has(model)) throw new Error(`unknown model ${model}`);
  if (readAheadFilters.isLoading) post({ type: 'stream-status', streamId, stage: 'loading' });
  readAheadFilters.load().catch(() => {});
  return async (left, right, sampleRate, options) => {
    if (sampleRate !== DPDF_SAMPLE_RATE) throw new Error(`DPDFNet needs ${DPDF_SAMPLE_RATE} Hz audio, got ${sampleRate} Hz`);
    return readAheadFilters.filter(left, right, sampleRate, options);
  };
}

function handleStream(data) {
  if (data.type === 'stream-reset') {
    const { streamId, resetId, model, playheadSeconds = 0 } = data;
    stream?.engine.reset();
    stream = {
      id: streamId,
      engine: new StreamEngine({
        separate: createWindowFilter(model, streamId),
        enqueue: enqueueSeparation,
        playheadSeconds,
        awaitingReplay: true,
        onWindow: (window) => {
          const transfer = [...new Set([window.left.buffer, window.right.buffer])];
          post({ type: 'window', streamId, ...window }, transfer);
        },
        onStatus: (status) => post({ type: 'stream-status', streamId, resetId, ...status }),
        onWarning: (message) => post({ type: 'stream-status', streamId, stage: 'warning', message }),
      }),
    };
    return;
  }
  if (!stream || data.streamId !== stream.id) return;
  if (data.type === 'stream-chunk') stream.engine.pushChunk(new Uint8Array(data.bytes));
  if (data.type === 'stream-replay-end') stream.engine.endReplay();
  if (data.type === 'stream-abort') stream.engine.abort();
  if (data.type === 'playhead') stream.engine.setPlayhead(data.seconds, data.isPlaying);
}

self.onmessage = ({ data }) => {
  if (data.type === 'connect') {
    post({ type: 'ready' });
    return;
  }
  if (!STREAM_MESSAGES.has(data.type)) return;
  try {
    handleStream(data);
  } catch (error) {
    post({ type: 'stream-status', streamId: data.streamId, stage: 'error', message: error.message });
  }
};
