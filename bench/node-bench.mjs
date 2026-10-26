import { readFileSync } from 'node:fs';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../vendor/df/df.js';
import { FrameStats } from '../src/worklet/frame-stats.js';

const SAMPLE_RATE = 48000;
const SECONDS = 60;
const ATTEN_LIM_DB = 100;

const wasm = readFileSync(new URL('../vendor/df/df_bg.wasm', import.meta.url));
const model = readFileSync(new URL('../vendor/df/DeepFilterNet3_onnx.tar.gz', import.meta.url));

initSync(wasm);
const handle = df_create(new Uint8Array(model), ATTEN_LIM_DB);
const frameLength = df_get_frame_length(handle);
const frameCount = Math.floor((SECONDS * SAMPLE_RATE) / frameLength);

const stats = new FrameStats({
  budgetMs: (frameLength / SAMPLE_RATE) * 1000,
  quantumMs: (128 / SAMPLE_RATE) * 1000,
});

const frame = new Float32Array(frameLength);
for (let f = 0; f < frameCount; f++) {
  for (let i = 0; i < frameLength; i++) {
    const t = (f * frameLength + i) / SAMPLE_RATE;
    frame[i] = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * (Math.random() * 2 - 1);
  }
  const start = performance.now();
  df_process_frame(handle, frame);
  stats.record(performance.now() - start);
}

const summary = stats.drain();
console.log(JSON.stringify({ frameLength, realtimeFactor: summary.meanMs / summary.budgetMs, ...summary }, null, 2));
