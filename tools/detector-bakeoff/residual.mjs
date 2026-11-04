import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Dpdf } from '../../vendor/dpdf/dpdf.js';
import { createDpdfFilter, wrapDpdf } from '../../src/pipeline/dpdf-filter.js';
import { createVoiceFilter } from '../../src/pipeline/voice-filter.js';

const RATE = 48000;
const repoPath = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const scenes = fileURLToPath(new URL('../../listening/detector/scenes/', import.meta.url));

initSync({ module: readFileSync(repoPath('extension/assets/dpdf_bg.wasm')) });
const engine = wrapDpdf(new Dpdf(new Uint8Array(readFileSync(repoPath('extension/assets/dpdfnet4.onnx')))));
const voiceFilter = createVoiceFilter({ filter: createDpdfFilter({ engine }) });

function decode(file) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'], {
    maxBuffer: 1 << 30,
  });
  return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
}

function encode(samples, file) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
}

for (const name of readdirSync(scenes).filter((f) => /^\d\d\.wav$/.test(f))) {
  const out = scenes + name.replace('.wav', '.dpdf-residual.wav');
  if (existsSync(out)) continue;
  const mix = decode(scenes + name);
  const [voice] = voiceFilter(mix, mix);
  const residual = mix.map((sample, i) => sample - voice[i]);
  encode(residual, out);
  console.log(name);
}
engine.free();
