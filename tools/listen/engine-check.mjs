import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, Dpdf } from '../../vendor/dpdf/dpdf.js';
import { createDpdfFilter, wrapDpdf } from '../../src/pipeline/dpdf-filter.js';
import { StreamEngine } from '../../src/pipeline/stream-engine.js';
import { createVoiceFilter } from '../../src/pipeline/voice-filter.js';

const RATE = 48000;
const LAG_SEARCH = 2400;
const LAG_PROBE_SECONDS = 5;
const repoPath = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

const [
  input = repoPath('listening/synth-6db-original.wav'),
  reference = repoPath('listening/synth-6db-dpdfnet4-16.wav'),
  output = 'engine-check.wav',
] = process.argv.slice(2);

const asset = (name) => readFileSync(repoPath(`extension/assets/${name}`));
initSync({ module: asset('dpdf_bg.wasm') });
const engine = wrapDpdf(new Dpdf(new Uint8Array(asset('dpdfnet4.onnx'))));
const dpdfFilter = createDpdfFilter({ engine });
const voiceFilter = createVoiceFilter({ filter: dpdfFilter });

// ffmpeg's own -ac 1 downmix scales by about 1.41, while the engine averages the two channels.
function decodeMono(file, decoder = []) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', ...decoder, '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-'], {
    maxBuffer: 1 << 30,
  });
  const stereo = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  return Float32Array.from({ length: stereo.length / 2 }, (_, i) => 0.5 * (stereo[2 * i] + stereo[2 * i + 1]));
}

function snrDb(clean, test) {
  let signal = 0;
  let error = 0;
  for (let i = 0; i < clean.length; i++) {
    signal += clean[i] ** 2;
    error += (clean[i] - test[i]) ** 2;
  }
  return 10 * Math.log10(signal / Math.max(error, 1e-20));
}

function bestLag(clean, test) {
  const from = Math.floor(clean.length / 2);
  const length = LAG_PROBE_SECONDS * RATE;
  let best = { lag: 0, score: -Infinity };
  for (let lag = -LAG_SEARCH; lag <= LAG_SEARCH; lag++) {
    let score = 0;
    for (let i = from; i < from + length; i++) score += clean[i] * test[i + lag];
    if (score > best.score) best = { lag, score };
  }
  return best.lag;
}

function aligned(clean, test, lag) {
  const start = Math.max(0, -lag);
  const end = Math.min(clean.length, test.length - lag);
  return [clean.subarray(start, end), test.subarray(start + lag, end + lag), start];
}

const scratch = mkdtempSync(join(tmpdir(), 'engine-check-'));
const webm = join(scratch, 'input.webm');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm', webm]);
const bytes = new Uint8Array(readFileSync(webm));
const opusDecoded = decodeMono(webm, ['-c:a', 'libopus']);
rmSync(scratch, { recursive: true, force: true });

const windows = [];
const timings = [];
const stream = new StreamEngine({
  separate: async (left, right, sampleRate, options) => voiceFilter(left, right, options),
  onWindow: (w) => windows.push(w),
  onStatus: (s) => {
    if (s.stage !== 'window') return;
    const rtf = s.computeMs / (s.durationSeconds * 1000);
    timings.push({ ...s, rtf });
    console.log(
      `window ${s.startSeconds.toFixed(2)} s +${s.durationSeconds.toFixed(2)} s: ${s.computeMs} ms, RTF ${rtf.toFixed(3)}`,
    );
  },
  config: { lookaheadSeconds: 3600, urgencySeconds: 3600, keepAheadSeconds: 3600 },
});
stream.pushChunk(bytes);
stream.setPlayhead(0, true);
await stream.ready;
while (stream.inFlight || !stream.isIdle()) await new Promise((r) => setTimeout(r, 100));
const [continuous] = voiceFilter(opusDecoded, opusDecoded);
engine.free();

const overlap = stream.config.overlapSeconds * RATE;
const dbfs = (value) => (20 * Math.log10(Math.max(value, 1e-9))).toFixed(1);
const rms = (samples) => Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / Math.max(1, samples.length));
const total = Math.ceil(Math.max(...windows.map((w) => w.startSeconds * RATE + w.left.length)));
const out = [new Float32Array(total), new Float32Array(total)];
const joins = [];
windows.forEach((w, index) => {
  const start = Math.round(w.startSeconds * RATE);
  const next = windows[index + 1];
  const nextStart = next ? Math.round(next.startSeconds * RATE) : Infinity;
  if (next) {
    joins.push(nextStart);
    const mine = w.left.subarray(nextStart - start);
    const theirs = next.left.subarray(0, mine.length);
    const difference = mine.map((s, i) => s - theirs[i]);
    const level = Math.max(rms(mine), 1e-9);
    console.log(
      `join ${(nextStart / RATE).toFixed(2)} s: overlap mismatch ${(20 * Math.log10(rms(difference) / level)).toFixed(1)} dB` +
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

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const rtfs = timings.map((t) => t.rtf);
console.log(
  `\n${windows.length} windows, ${joins.length} joins. Compute RTF mean ${mean(rtfs).toFixed(3)}, max ${Math.max(...rtfs).toFixed(3)}` +
    ` (includes the context warm-up). Reported delay ${dpdfFilter.delay} samples.`,
);

const original = decodeMono(input);
const opusLag = bestLag(original, opusDecoded);
const [originalPart, opusPart] = aligned(original, opusDecoded, opusLag);
console.log(`Opus 128k round trip vs the WAV: lag ${opusLag}, SNR ${snrDb(originalPart, opusPart).toFixed(2)} dB`);

function compare(label, clean, test) {
  const lag = bestLag(clean, test);
  const [cleanPart, testPart, offset] = aligned(clean, test, lag);
  const inCrossfade = (i) => joins.some((join) => i + offset >= join && i + offset < join + overlap);
  const split = { outside: [[], []], inside: [[], []] };
  for (let i = 0; i < cleanPart.length; i++) {
    const part = inCrossfade(i) ? split.inside : split.outside;
    part[0].push(cleanPart[i]);
    part[1].push(testPart[i]);
  }
  console.log(
    `stitched vs ${label}: lag ${lag}, SNR ${snrDb(cleanPart, testPart).toFixed(2)} dB overall,` +
      ` ${snrDb(...split.outside).toFixed(2)} dB outside the crossfades, ${snrDb(...split.inside).toFixed(2)} dB inside them`,
  );
}

compare('one continuous DPDFNet-4 pass over the same Opus audio', continuous, out[0]);
compare(reference.split('/').at(-1), decodeMono(reference), out[0]);

const data = Buffer.alloc(44 + total * 4);
data.write('RIFF', 0);
data.writeUInt32LE(36 + total * 4, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22);
data.writeUInt32LE(RATE, 24);
data.writeUInt32LE(RATE * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[0][i])) * 32767), 44 + i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[1][i])) * 32767), 46 + i * 4);
}
writeFileSync(output, data);
console.log(`→ ${output}`);
