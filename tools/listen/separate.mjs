import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import separate from '@audio/neural-separate';

const SAMPLE_RATE = 44100;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4a', '.mp3', '.wav', '.flac', '.ogg', '.opus', '.aac']);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string', default: 'mrx,tiger' },
    start: { type: 'string', default: '0' },
    seconds: { type: 'string', default: '60' },
  },
});

const [clipsDir, outDir] = positionals;
if (!clipsDir || !outDir) {
  console.error('usage: node separate.mjs <clips-dir> <out-dir> [--models mrx,tiger] [--start 0] [--seconds 60]');
  process.exit(1);
}

function decode(file) {
  const args = ['-v', 'error', '-ss', values.start, '-t', values.seconds, '-i', file, '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'];
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    const chunks = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => (stderr += chunk));
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed on ${file}: ${stderr.trim()}`));
      const bytes = Buffer.concat(chunks);
      const interleaved = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const frames = interleaved.length / 2;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = interleaved[2 * i];
        right[i] = interleaved[2 * i + 1];
      }
      resolve([left, right]);
    });
  });
}

function writeWav(path, channels) {
  const frames = channels[0].length;
  const dataBytes = frames * channels.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels.length, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * channels.length * 2, 28);
  buffer.writeUInt16LE(channels.length * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      buffer.writeInt16LE(Math.round(sample * 32767), offset);
      offset += 2;
    }
  }
  writeFileSync(path, buffer);
}

function subtract(mix, music) {
  return mix.map((channel, c) => channel.map((sample, i) => sample - music[c][i]));
}

const models = values.models.split(',').map((m) => m.trim()).filter(Boolean);
const clips = readdirSync(clipsDir).filter((name) => MEDIA_EXTENSIONS.has(extname(name).toLowerCase())).sort();
if (clips.length === 0) {
  console.error(`no media files in ${clipsDir}`);
  process.exit(1);
}

const summary = [];
for (const clip of clips) {
  const name = basename(clip, extname(clip));
  const clipOut = join(outDir, name);
  mkdirSync(clipOut, { recursive: true });

  const mix = await decode(join(clipsDir, clip));
  const durationS = mix[0].length / SAMPLE_RATE;
  writeWav(join(clipOut, '0-original.wav'), mix);
  console.log(`\n${clip}: ${durationS.toFixed(1)} s`);

  for (const model of models) {
    const startedAt = performance.now();
    const { stems } = await separate(mix, { sampleRate: SAMPLE_RATE, model });
    const elapsedS = (performance.now() - startedAt) / 1000;
    writeWav(join(clipOut, `${model}-no-music.wav`), subtract(mix, stems.music));
    writeWav(join(clipOut, `${model}-music-removed.wav`), stems.music);
    const rtf = elapsedS / durationS;
    summary.push({ clip, model, seconds: Number(durationS.toFixed(1)), elapsedS: Number(elapsedS.toFixed(1)), rtf: Number(rtf.toFixed(2)) });
    console.log(`  ${model}: ${elapsedS.toFixed(1)} s, RTF ${rtf.toFixed(2)}`);
  }
}

console.log('\n' + JSON.stringify(summary, null, 2));
