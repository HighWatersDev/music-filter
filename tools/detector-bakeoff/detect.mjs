import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, MusicDetector } from '../../vendor/dpdf/dpdf.js';

const RATE = 48000;
// The bake-off zero-padded the clip edges. 2.5 s of silence on each side gives the same first and last frames.
const PAD_FRAMES = 5;
const repoPath = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const scenes = fileURLToPath(new URL('../../listening/detector/scenes/', import.meta.url));

initSync({ module: readFileSync(repoPath('extension/assets/dpdf_bg.wasm')) });
const detector = new MusicDetector(new Uint8Array(readFileSync(repoPath('extension/assets/music-detector-mn05.onnx'))));

function readFloatWav(file) {
  const bytes = readFileSync(file);
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset + 8, bytes.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

let audioSeconds = 0;
let computeMs = 0;
for (const name of readdirSync(scenes).filter((f) => /^\d\d\.dpdf-residual\.wav$/.test(f))) {
  const residual = readFloatWav(scenes + name);
  const pad = (PAD_FRAMES * RATE) / 2;
  const padded = new Float32Array(residual.length + 2 * pad);
  padded.set(residual, pad);
  const startedAt = performance.now();
  const probabilities = detector.frame_probabilities(padded);
  computeMs += performance.now() - startedAt;
  audioSeconds += residual.length / RATE;
  const frames = Array.from(probabilities.slice(PAD_FRAMES, probabilities.length - PAD_FRAMES));
  writeFileSync(scenes + name.replace('.dpdf-residual.wav', '.shipped.json'), JSON.stringify(frames));
}
console.log(`${(computeMs / audioSeconds).toFixed(1)} ms of detector per second of audio`);
