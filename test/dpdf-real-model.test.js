import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createDpdfFilter, wrapDpdf } from '../src/pipeline/dpdf-filter.js';

const DPDF_JS = new URL('../vendor/dpdf/dpdf.js', import.meta.url);
const DPDF_WASM = new URL('../extension/assets/dpdf_bg.wasm', import.meta.url);
const MODEL = new URL('../extension/assets/dpdfnet4.onnx', import.meta.url);
const ORIGINAL = new URL('../listening/synth-6db-original.wav', import.meta.url);
const REFERENCE = new URL('../listening/synth-6db-dpdfnet4-16.wav', import.meta.url);
const missing = [DPDF_JS, DPDF_WASM, MODEL, ORIGINAL, REFERENCE].filter((url) => !existsSync(url));

// The reference put x16[0] on a hop boundary. Our downsampler delays by 48 samples at 16 kHz,
// so 112 more (336 at 48 kHz) put the clip on the same hop grid and the model sees the same frames.
const HOP_GRID_LEAD = 336;

function readWavMono(url) {
  const bytes = readFileSync(url);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let channels;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      assert.equal(bytes.readUInt16LE(body), 1, 'PCM');
      channels = bytes.readUInt16LE(body + 2);
      assert.equal(bytes.readUInt32LE(body + 4), 48000);
      assert.equal(bytes.readUInt16LE(body + 14), 16);
    } else if (id === 'data') {
      const frames = size / (2 * channels);
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += bytes.readInt16LE(body + 2 * (i * channels + c)) / 32768;
        mono[i] = sum / channels;
      }
      return mono;
    }
    offset = body + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function snrDb(reference, actual) {
  let signal = 0;
  let error = 0;
  for (let i = 0; i < reference.length; i++) {
    signal += reference[i] ** 2;
    error += (reference[i] - actual[i]) ** 2;
  }
  return 10 * Math.log10(signal / error);
}

test('DPDFNet-4 through the JS resampler matches the offline reference render', { skip: missing.length > 0 && `missing ${missing.map((url) => url.pathname).join(', ')}` }, async (t) => {
  const { initSync, Dpdf } = await import(DPDF_JS);
  initSync({ module: readFileSync(DPDF_WASM) });
  const engine = wrapDpdf(new Dpdf(new Uint8Array(readFileSync(MODEL))));
  try {
    const filter = createDpdfFilter({ engine });
    const original = readWavMono(ORIGINAL);
    const reference = readWavMono(REFERENCE);
    const offset = HOP_GRID_LEAD + filter.delay;
    const input = new Float32Array(offset + original.length);
    input.set(original, HOP_GRID_LEAD);
    const output = new Float32Array(input.length);
    for (let start = 0; start < input.length; start += 128) {
      const end = Math.min(start + 128, input.length);
      filter.process(input.subarray(start, end), output.subarray(start, end));
    }
    const rendered = output.subarray(offset);

    const scores = [];
    for (let lag = -8; lag <= 8; lag++) {
      const from = 48000 + lag;
      scores.push([lag, snrDb(reference.subarray(48000, reference.length - 48000), rendered.subarray(from, from + reference.length - 96000))]);
    }
    const [bestLag] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
    const snr = snrDb(reference, rendered);
    t.diagnostic(`DPDFNet-4 vs reference: SNR ${snr.toFixed(2)} dB over ${(reference.length / 48000).toFixed(1)} s, best lag ${bestLag}`);
    assert.equal(bestLag, 0);
    assert.ok(snr >= 35, `SNR ${snr.toFixed(2)} dB`);
  } finally {
    engine.free();
  }
});
