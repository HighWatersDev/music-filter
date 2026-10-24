import separate, { models, REVISIONS } from '@audio/neural-separate';
import { backends, fetchModel, load } from '@audio/neural-runtime';

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
  const store = await caches.open(CACHE_NAME);
  const source = (await store.match(url)) ? 'cache' : 'download';
  const startedAt = performance.now();
  let lastReport = 0;
  const bytes = await fetchModel(url, {
    progress: ({ loaded, total }) => {
      const now = performance.now();
      if (now - lastReport < DOWNLOAD_REPORT_MS && loaded !== total) return;
      lastReport = now;
      report({ stage: 'download', loaded, total });
    },
  });
  if ((await sha256Hex(bytes)) !== models[model].sha256) {
    await store.delete(url);
    throw new Error(`${model} weights failed the SHA-256 check, cache entry cleared, try again`);
  }
  return { bytes, source, downloadMs: performance.now() - startedAt };
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
  const { stems } = await separate([left, right], {
    model,
    sampleRate,
    targets: ['music'],
    session: async () => ready.session,
    progress: ({ chunk, totalChunks }) =>
      report({ stage: 'separate', chunk, totalChunks, elapsedMs: performance.now() - separateStart }),
  });
  const separateMs = performance.now() - separateStart;

  const [musicLeft, musicRight] = stems.music;
  for (let i = 0; i < left.length; i++) {
    left[i] -= musicLeft[i];
    right[i] -= musicRight[i];
  }

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
      left,
      right,
    },
    [left.buffer, right.buffer],
  );
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
  handle(data).catch((error) => post({ type: 'error', id: data.id, message: error.message }));
};
