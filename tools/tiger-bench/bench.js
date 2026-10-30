import { readWavMono } from './dsp.mjs';

const params = new URLSearchParams(location.search);
const opt = {
  model: params.get('model') ?? 'dbs6_fp32.onnx',
  seconds: Number(params.get('seconds') ?? 6),
  ep: params.get('ep') ?? 'wasm',
  threads: Number(params.get('threads') ?? 1),
  workers: (params.get('workers') ?? '1,2,3').split(',').map(Number),
  chunks: Number(params.get('chunks') ?? 3),
  clip: params.get('clip') ?? 'synth-6db.wav',
  label: params.get('label') ?? '',
  isolated: params.get('isolated') === '1',
};
const logEl = document.getElementById('log');
const log = (line) => {
  logEl.textContent += line + '\n';
};

async function gpuInfo() {
  if (!('gpu' in navigator)) return { available: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: true, adapter: null };
    const info = adapter.info ?? {};
    return { available: true, adapter: { vendor: info.vendor, architecture: info.architecture, description: info.description }, shaderF16: adapter.features.has('shader-f16') };
  } catch (error) {
    return { available: true, error: String(error) };
  }
}

async function runConfig(audioSets, n) {
  const workers = [];
  const ready = [];
  for (let w = 0; w < n; w++) {
    const worker = new Worker(`worker.js${opt.isolated ? '?isolated=1' : ''}`, { type: 'module' });
    workers.push(worker);
    ready.push(new Promise((resolveReady, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'debug') reject(new Error(`debug: ${JSON.stringify(data)}`));
        else if (data.type === 'ready') resolveReady(data);
        else reject(new Error(data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'worker error'));
    }));
    worker.postMessage({
      type: 'init',
      modelUrl: `models/${opt.model}`,
      ep: opt.ep,
      threads: opt.threads,
      chunks: opt.chunks,
      audio: audioSets[w],
      debug: params.get('debug') === '1',
      refUrl: w === 0 && params.get('ref') ? `clips/${params.get('ref')}` : null,
    });
  }
  const readyInfo = await Promise.all(ready);
  const done = workers.map((worker) => new Promise((resolveDone, reject) => {
    worker.onmessage = ({ data }) => (data.type === 'done' ? resolveDone(data) : reject(new Error(data.message)));
  }));
  workers.forEach((worker) => worker.postMessage({ type: 'go' }));
  const results = await Promise.all(done);
  workers.forEach((worker) => worker.terminate());

  const chunks = results.flatMap((r) => r.chunks);
  const wall = (Math.max(...chunks.map((c) => c.end)) - Math.min(...chunks.map((c) => c.start))) / 1000;
  const perChunk = chunks.map((c) => (c.end - c.start) / 1000 / opt.seconds);
  const firstChunk = Math.max(...results.map((r) => r.chunks[0].end)) - Math.min(...chunks.map((c) => c.start));
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    workers: n,
    chunksTotal: chunks.length,
    rtfPerChunkMean: +mean(perChunk).toFixed(2),
    rtfPerChunkMax: +Math.max(...perChunk).toFixed(2),
    modelMsMean: Math.round(mean(chunks.map((c) => c.modelMs))),
    dspMsMean: Math.round(mean(chunks.map((c) => c.stftMs + c.istftMs))),
    audioPerWallSecond: +((chunks.length * opt.seconds) / wall).toFixed(3),
    firstRoundSeconds: +(firstChunk / 1000).toFixed(1),
    createMs: readyInfo.map((r) => Math.round(r.createMs)),
    warmMs: readyInfo.map((r) => Math.round(r.warmMs)),
    heapMb: results.map((r) => r.heapMb),
    keepSnrDb: readyInfo[0].keepSnrDb,
  };
}

async function main() {
  const env = {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated,
    gpu: await gpuInfo(),
  };
  log(JSON.stringify(env));
  const { rate, samples } = readWavMono(await (await fetch(`clips/${opt.clip}`)).arrayBuffer());
  if (rate !== 44100) throw new Error(`clip must be 44.1 kHz, got ${rate}`);
  const length = Math.round(opt.seconds * rate);
  const maxWorkers = Math.max(...opt.workers);
  // Each Worker filters different audio, starting at 10 s, in consecutive windows.
  const audioSets = [];
  for (let w = 0; w < maxWorkers; w++) {
    const set = [];
    for (let c = 0; c < opt.chunks; c++) {
      const start = (10 * rate + (w * opt.chunks + c) * length) % (samples.length - length);
      set.push(samples.slice(start, start + length));
    }
    audioSets.push(set);
  }
  const configs = [];
  for (const n of opt.workers) {
    log(`running ${n} worker(s)...`);
    const result = await runConfig(audioSets, n);
    log(JSON.stringify(result));
    configs.push(result);
  }
  return { env, configs };
}

const report = { id: params.get('id') ?? String(Date.now()), opt };
main()
  .then((r) => Object.assign(report, r))
  .catch((error) => {
    report.error = String(error?.stack ?? error);
    log(report.error);
  })
  .finally(async () => {
    window.__result = report;
    await fetch('report', { method: 'POST', body: JSON.stringify(report) }).catch(() => {});
    document.title = 'done';
    if (params.get('close') === '1') window.close();
  });
