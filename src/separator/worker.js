import separate, { models, REVISIONS } from '@audio/neural-separate';
import { backends, fetchModel, load } from '@audio/neural-runtime';
import createDpdfBindings from 'dpdf-bindings';
import { wrapDpdf } from '../pipeline/dpdf-filter.js';
import { createSerialQueue, StreamEngine } from '../pipeline/stream-engine.js';
import { createReadAheadFilters } from './read-ahead-filters.js';

const CACHE_NAME = 'audio-neural';
const SESSION_OPTIONS = { enableCpuMemArena: false, enableMemPattern: false };
const DOWNLOAD_REPORT_MS = 250;

let wasmPaths;
let prepared;

const post = (message, transfer = []) => self.postMessage(message, transfer);

function weightsUrl(model) {
  const { repo, file } = models[model];
  return `https://huggingface.co/${repo}/resolve/${REVISIONS[model]}/${file}`;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function describeGpu() {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) return navigator.gpu ? 'no adapter' : 'navigator.gpu missing';
  const { vendor, architecture, isFallbackAdapter } = adapter.info ?? {};
  return `${vendor || '?'} ${architecture || '?'}${isFallbackAdapter ? ' (fallback adapter)' : ''}`;
}

async function fetchWeights(model, report) {
  const url = weightsUrl(model);
  const expected = models[model].sha256;
  const store = await caches.open(CACHE_NAME);
  const startedAt = performance.now();

  const cached = await store.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if ((await sha256Hex(bytes)) === expected) {
      report({ stage: 'download', loaded: bytes.length, total: bytes.length });
      return { bytes, source: 'cache', downloadMs: performance.now() - startedAt };
    }
    await store.delete(url);
  }

  let lastReport = 0;
  const bytes = await fetchModel(url, {
    cache: false,
    progress: ({ loaded, total }) => {
      const now = performance.now();
      if (now - lastReport < DOWNLOAD_REPORT_MS && loaded !== total) return;
      lastReport = now;
      report({ stage: 'download', loaded, total });
    },
  });
  if ((await sha256Hex(bytes)) !== expected) {
    throw new Error(`${model} weights downloaded from ${url} failed the SHA-256 check and were not cached`);
  }
  store
    .put(url, new Response(bytes))
    .catch((error) => console.warn(`[separator] ${model} weights not cached: ${error.message}`));
  return { bytes, source: cached ? 'download (cached copy was corrupt)' : 'download', downloadMs: performance.now() - startedAt };
}

async function createSession(model, requestedDevice, report) {
  const weights = await fetchWeights(model, report);
  const available = await backends();
  let device = requestedDevice === 'webgpu' && available.includes('webgpu') ? 'webgpu' : 'wasm';
  let fallbackReason = requestedDevice === 'webgpu' && device === 'wasm' ? 'no hardware WebGPU adapter' : undefined;

  report({ stage: 'session', device });
  const startedAt = performance.now();
  let session;
  try {
    session = await load(weights.bytes, { backend: device, sessionOptions: SESSION_OPTIONS, wasmPaths });
  } catch (error) {
    if (device !== 'webgpu') throw error;
    fallbackReason = `WebGPU session failed: ${error.message}`;
    device = 'wasm';
    report({ stage: 'session', device });
    session = await load(weights.bytes, { backend: device, sessionOptions: SESSION_OPTIONS, wasmPaths });
  }

  return {
    // separate() frees its session after every call. Keeping it lets the next clip skip download and session setup.
    session: { ...session, free() {} },
    release: () => session.free(),
    device,
    fallbackReason,
    weightsSource: weights.source,
    weightsBytes: weights.bytes.length,
    downloadMs: weights.downloadMs,
    sessionMs: performance.now() - startedAt,
  };
}

function prepare(model, requestedDevice, report) {
  const key = `${model}:${requestedDevice}`;
  if (prepared?.key === key) return prepared.promise;
  prepared?.promise.then((p) => p.release()).catch(() => {});
  const promise = createSession(model, requestedDevice, report);
  prepared = { key, promise };
  promise.catch(() => {
    if (prepared?.key === key) prepared = undefined;
  });
  return promise;
}

async function runSeparation({ id, model, device: requestedDevice, sampleRate, left, right }) {
  const receivedAt = performance.now();
  const report = (status) => post({ type: 'status', id, ...status });
  const ready = await prepare(model, requestedDevice, report);

  const durationS = left.length / sampleRate;
  const separateStart = performance.now();
  report({ stage: 'separate', chunk: 0, totalChunks: null, elapsedMs: 0 });
  const { residual } = await separate([left, right], {
    model,
    sampleRate,
    targets: ['music'],
    session: async () => ready.session,
    progress: ({ chunk, totalChunks }) =>
      report({ stage: 'separate', chunk, totalChunks, elapsedMs: performance.now() - separateStart }),
  });
  const separateMs = performance.now() - separateStart;

  const [withoutMusicLeft, withoutMusicRight] = residual;

  post(
    {
      type: 'done',
      id,
      model,
      requestedDevice,
      device: ready.device,
      fallbackReason: ready.fallbackReason,
      weightsSource: ready.weightsSource,
      weightsBytes: ready.weightsBytes,
      downloadMs: ready.downloadMs,
      sessionMs: ready.sessionMs,
      separateMs,
      workerMs: performance.now() - receivedAt,
      durationS,
      rtf: separateMs / 1000 / durationS,
      sampleRate,
      left: withoutMusicLeft,
      right: withoutMusicRight,
    },
    [withoutMusicLeft.buffer, withoutMusicRight.buffer],
  );
}

const STREAM_MESSAGES = new Set(['stream-reset', 'stream-chunk', 'stream-abort', 'playhead']);
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
    const { streamId, model, playheadSeconds = 0 } = data;
    stream?.engine.reset();
    stream = {
      id: streamId,
      engine: new StreamEngine({
        separate: createWindowFilter(model, streamId),
        enqueue: enqueueSeparation,
        playheadSeconds,
        onWindow: (window) => {
          const transfer = [...new Set([window.left.buffer, window.right.buffer])];
          post({ type: 'window', streamId, ...window }, transfer);
        },
        onStatus: (status) => post({ type: 'stream-status', streamId, ...status }),
        onWarning: (message) => post({ type: 'stream-status', streamId, stage: 'warning', message }),
      }),
    };
    return;
  }
  if (!stream || data.streamId !== stream.id) return;
  if (data.type === 'stream-chunk') stream.engine.pushChunk(new Uint8Array(data.bytes));
  if (data.type === 'stream-abort') stream.engine.abort();
  if (data.type === 'playhead') stream.engine.setPlayhead(data.seconds, data.isPlaying);
}

async function handle(data) {
  if (data.type === 'prepare') {
    const ready = await prepare(data.model, data.device, (status) => post({ type: 'status', id: data.id, ...status }));
    const { session, release, ...summary } = ready;
    post({ type: 'done', id: data.id, ...summary });
    return;
  }
  if (data.type === 'separate') await runSeparation(data);
}

self.onmessage = ({ data }) => {
  if (data.type === 'connect') {
    wasmPaths = data.wasmPaths;
    Promise.all([backends(), describeGpu()]).then(([available, gpu]) =>
      post({
        type: 'ready',
        backends: available,
        gpu,
        crossOriginIsolated: self.crossOriginIsolated,
        hardwareConcurrency: navigator.hardwareConcurrency,
      }),
    );
    return;
  }
  if (STREAM_MESSAGES.has(data.type)) {
    try {
      handleStream(data);
    } catch (error) {
      post({ type: 'stream-status', streamId: data.streamId, stage: 'error', message: error.message });
    }
    return;
  }
  handle(data).catch((error) => post({ type: 'error', id: data.id, message: error.message }));
};
