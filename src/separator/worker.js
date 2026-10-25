import separate, { models, REVISIONS } from '@audio/neural-separate';
import { backends, fetchModel, load } from '@audio/neural-runtime';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { createSerialQueue, StreamEngine } from '../pipeline/stream-engine.js';
import { createVoiceFilter } from '../pipeline/voice-filter.js';

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
const DFN_WASM_URL = new URL('../assets/df_bg.wasm', import.meta.url);
const DFN_MODEL_URL = new URL('../assets/DeepFilterNet3_onnx.tar.gz', import.meta.url);
const DFN_ATTEN_LIM_DB = 100;
let stream = null;
let voiceFilter;
const enqueueSeparation = createSerialQueue();

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function loadVoiceFilter(report) {
  if (voiceFilter) return voiceFilter;
  report({ stage: 'loading' });
  voiceFilter = Promise.all([fetchBytes(DFN_WASM_URL), fetchBytes(DFN_MODEL_URL)]).then(async ([wasm, model]) => {
    initSync(await WebAssembly.compile(wasm));
    const handle = df_create(model, DFN_ATTEN_LIM_DB);
    return createVoiceFilter({
      processFrame: (frame) => df_process_frame(handle, frame),
      frameLength: df_get_frame_length(handle),
    });
  });
  voiceFilter.catch(() => {
    voiceFilter = undefined;
  });
  return voiceFilter;
}

function createWindowFilter(model, streamId) {
  if (model === 'fake') return async (left, right) => [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
  if (model !== 'dfn3') throw new Error(`unknown model ${model}`);
  const report = (status) => post({ type: 'stream-status', streamId, ...status });
  loadVoiceFilter(report).catch(() => {});
  return async (left, right) => (await loadVoiceFilter(report))(left, right);
}

function handleStream(data) {
  if (data.type === 'stream-reset') {
    const { streamId, model } = data;
    stream?.engine.reset();
    stream = {
      id: streamId,
      engine: new StreamEngine({
        separate: createWindowFilter(model, streamId),
        enqueue: enqueueSeparation,
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
