import { readFileSync, writeFileSync } from 'node:fs';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { StreamEngine } from '../../src/pipeline/stream-engine.js';
import { createVoiceFilter } from '../../src/pipeline/voice-filter.js';

const asset = (name) => readFileSync(new URL(`../../extension/assets/${name}`, import.meta.url));
initSync(asset('df_bg.wasm'));
const handle = df_create(new Uint8Array(asset('DeepFilterNet3_onnx.tar.gz')), 100);
const voiceFilter = createVoiceFilter({
  processFrame: (frame) => df_process_frame(handle, frame),
  frameLength: df_get_frame_length(handle),
});

const [input = '../../test-page/fixtures/tone-60s.webm', output = 'engine-check.wav'] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(input));
const windows = [];
const engine = new StreamEngine({
  separate: async (left, right, sampleRate, options) => voiceFilter(left, right, options),
  onWindow: (w) => windows.push(w),
  onStatus: (s) => s.stage === 'window' && console.log(JSON.stringify(s)),
  config: { lookaheadSeconds: 3600, urgencySeconds: 3600 },
});
engine.pushChunk(bytes);
engine.setPlayhead(0, true);
await engine.ready;
while (engine.inFlight || !engine.isIdle()) await new Promise((r) => setTimeout(r, 100));

const rate = 48000;
const overlap = engine.config.overlapSeconds * rate;
const dbfs = (value) => (20 * Math.log10(Math.max(value, 1e-9))).toFixed(1);
const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / Math.max(1, samples.length));
const total = Math.ceil(Math.max(...windows.map((w) => w.startSeconds * rate + w.left.length)));
const out = [new Float32Array(total), new Float32Array(total)];
windows.forEach((w, index) => {
  const start = Math.round(w.startSeconds * rate);
  const next = windows[index + 1];
  const nextStart = next ? Math.round(next.startSeconds * rate) : Infinity;
  if (next) {
    const mine = w.left.subarray(nextStart - start);
    const theirs = next.left.subarray(0, mine.length);
    const difference = mine.map((s, i) => s - theirs[i]);
    const level = Math.max(rms(mine), 1e-9);
    console.log(
      `boundary ${(nextStart / rate).toFixed(2)} s: overlap mismatch ${(20 * Math.log10(rms(difference) / level)).toFixed(1)} dB` +
        ` (this window ${dbfs(rms(mine))} dBFS, next ${dbfs(rms(theirs))} dBFS)`,
    );
  }
  for (let i = 0; i < w.left.length; i++) {
    const t = start + i;
    let gain = 1;
    if (index > 0 && i < overlap) gain = i / overlap;
    if (t >= nextStart) gain *= 1 - (t - nextStart) / overlap;
    out[0][t] += w.left[i] * gain;
    out[1][t] += w.right[i] * gain;
  }
});

const data = Buffer.alloc(44 + total * 4);
data.write('RIFF', 0);
data.writeUInt32LE(36 + total * 4, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22);
data.writeUInt32LE(rate, 24);
data.writeUInt32LE(rate * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[0][i])) * 32767), 44 + i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[1][i])) * 32767), 46 + i * 4);
}
writeFileSync(output, data);
console.log(`${windows.length} windows → ${output}`);
