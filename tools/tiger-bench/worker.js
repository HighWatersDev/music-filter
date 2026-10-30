import { frameCount, keepEffects, stft } from './dsp.mjs';

// Grab the wasm heap so the Worker can report its size. ORT creates or instantiates it lazily.
const memories = new Set();
const NativeMemory = WebAssembly.Memory;
WebAssembly.Memory = function (descriptor) {
  const memory = new NativeMemory(descriptor);
  memories.add(memory);
  return memory;
};
WebAssembly.Memory.prototype = NativeMemory.prototype;
for (const name of ['instantiate', 'instantiateStreaming']) {
  const native = WebAssembly[name];
  WebAssembly[name] = async (...args) => {
    const result = await native.apply(WebAssembly, args);
    const memory = (result.instance ?? result)?.exports?.memory;
    if (memory instanceof NativeMemory) memories.add(memory);
    return result;
  };
}

const now = () => performance.timeOrigin + performance.now();
const heapMb = () => (memories.size ? +(Math.max(...[...memories].map((m) => m.buffer.byteLength)) / 1048576).toFixed(1) : null);

let session = null;
let ort = null;
let config = null;

async function runChunk(audio) {
  const t0 = now();
  const { data, frames } = stft(audio);
  const t1 = now();
  const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 2, 1025, frames]) });
  const t2 = now();
  const out = result[session.outputNames[0]].data;
  const keep = session.inputNames[0] === 'spec' ? keepEffects(out, frameCount(audio.length), audio.length) : null;
  for (const tensor of Object.values(result)) tensor.dispose?.();
  const t3 = now();
  return { start: t0, end: t3, stftMs: t1 - t0, modelMs: t2 - t1, istftMs: t3 - t2, keep };
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      config = msg;
      ort = await import('./node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs');
      ort.env.wasm.wasmPaths = new URL('./node_modules/onnxruntime-web/dist/', self.location.href).href;
      ort.env.wasm.numThreads = msg.threads;
      ort.env.wasm.proxy = false;
      const t0 = now();
      const bytes = await (await fetch(msg.modelUrl)).arrayBuffer();
      const t1 = now();
      const ep = msg.ep === 'webgpu' ? ['webgpu'] : ['wasm'];
      session = await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: ep,
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });
      const t2 = now();
      if (msg.debug) {
        const { data, frames } = stft(msg.audio[0]);
        const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 2, 1025, frames]) });
        const bad = session.outputNames.filter((name) => result[name].data.some((v) => !Number.isFinite(v)));
        const stats = {};
        for (const name of session.outputNames) {
          let lo = Infinity;
          let hi = -Infinity;
          let sum = 0;
          for (const v of result[name].data) {
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
            sum += v;
          }
          stats[name] = [lo, hi, sum / result[name].data.length];
        }
        self.postMessage({ type: 'debug', bad, outputs: session.outputNames.length, stats });
        return;
      }
      const warm = await runChunk(msg.audio[0]);
      let keepSnrDb = null;
      if (msg.refUrl && warm.keep) {
        const ref = new Float32Array(await (await fetch(msg.refUrl)).arrayBuffer());
        let signal = 0;
        let noise = 0;
        for (let i = 0; i < ref.length; i++) {
          signal += ref[i] * ref[i];
          noise += (ref[i] - warm.keep[i]) ** 2;
        }
        keepSnrDb = +(10 * Math.log10(signal / Math.max(noise, 1e-30))).toFixed(1);
      }
      self.postMessage({ type: 'ready', fetchMs: t1 - t0, createMs: t2 - t1, warmMs: warm.end - warm.start, heapMb: heapMb(), keepSnrDb });
    } else if (msg.type === 'go') {
      const chunks = [];
      for (let i = 0; i < config.chunks; i++) {
        const { keep, ...timing } = await runChunk(config.audio[i % config.audio.length]);
        chunks.push(timing);
      }
      self.postMessage({ type: 'done', chunks, heapMb: heapMb() });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.stack ?? error) });
  }
};
