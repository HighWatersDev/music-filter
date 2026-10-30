import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import ort from 'onnxruntime-node';
import { frameCount, keepEffects, readWavMono, stft } from './dsp.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string' },
    clip: { type: 'string' },
    offset: { type: 'string', default: '20' },
    runs: { type: 'string', default: '3' },
    ref: { type: 'string' },
    'write-keep': { type: 'string' },
  },
});
if (!values.models || !values.clip || positionals.length === 0) {
  console.error('usage: node node-bench.mjs --models <dir> --clip <44.1k wav> [--ref keep.f32] <file.onnx:seconds> ...');
  process.exit(1);
}

const { rate, samples } = readWavMono(readFileSync(values.clip));
if (rate !== 44100) throw new Error(`clip must be 44.1 kHz, got ${rate}`);
const start = Math.round(Number(values.offset) * rate);

function snr(ref, est) {
  let s = 0;
  let e = 0;
  for (let i = 0; i < ref.length; i++) {
    s += ref[i] * ref[i];
    e += (ref[i] - est[i]) ** 2;
  }
  return 10 * Math.log10(s / Math.max(e, 1e-30));
}

for (const spec of positionals) {
  const [file, secondsText] = spec.split(':');
  const seconds = Number(secondsText);
  const length = Math.round(seconds * rate);
  const chunk = samples.subarray(start, start + length);
  const session = await ort.InferenceSession.create(join(values.models, file), {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const inputName = session.inputNames[0];
  const isDbs = inputName === 'spec';
  const times = [];
  let modelMs = 0;
  let keep = null;
  for (let run = 0; run <= Number(values.runs); run++) {
    const t0 = performance.now();
    const { data, frames } = stft(chunk);
    const tensor = new ort.Tensor('float32', data, [1, 2, 1025, frames]);
    const t1 = performance.now();
    const result = await session.run({ [inputName]: tensor });
    const t2 = performance.now();
    const out = result[session.outputNames[0]].data;
    if (isDbs) keep = keepEffects(out, frameCount(length), length);
    const t3 = performance.now();
    if (run > 0) {
      times.push(t3 - t0);
      modelMs += t2 - t1;
    }
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const line = {
    model: basename(file),
    chunkSeconds: seconds,
    meanMs: Math.round(mean),
    modelOnlyMs: Math.round(modelMs / times.length),
    rtfPerChunk: +(mean / 1000 / seconds).toFixed(2),
  };
  if (values.ref && isDbs && Math.abs(seconds - 6) < 1e-6) {
    const ref = new Float32Array(readFileSync(values.ref).buffer.slice(0));
    line.keepEffectsSnrDb = +snr(ref, keep).toFixed(1);
  }
  if (values['write-keep'] && keep) writeFileSync(join(values['write-keep'], `${basename(file, '.onnx')}.keep.f32`), keep);
  console.log(JSON.stringify(line));
  await session.release();
}
