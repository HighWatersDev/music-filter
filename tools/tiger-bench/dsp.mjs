export const N_FFT = 2048;
export const HOP = 512;
export const BINS = N_FFT / 2 + 1;

const hann = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

const bitrev = new Uint32Array(N_FFT);
const levels = Math.log2(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  let r = 0;
  for (let b = 0; b < levels; b++) r = (r << 1) | ((i >> b) & 1);
  bitrev[i] = r;
}
const cosT = new Float64Array(N_FFT / 2);
const sinT = new Float64Array(N_FFT / 2);
for (let i = 0; i < N_FFT / 2; i++) {
  cosT[i] = Math.cos((2 * Math.PI * i) / N_FFT);
  sinT[i] = Math.sin((2 * Math.PI * i) / N_FFT);
}

function fft(re, im, inverse) {
  for (let i = 0; i < N_FFT; i++) {
    const j = bitrev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1;
    const step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step];
        const wi = sign * sinT[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

export function frameCount(samples) {
  return 1 + Math.floor(samples / HOP);
}

// torch.stft(center=True, pad_mode='reflect', window=hann, onesided) as [1, 2, BINS, frames].
export function stft(x) {
  const frames = frameCount(x.length);
  const pad = N_FFT / 2;
  const out = new Float32Array(2 * BINS * frames);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const at = (i) => {
    let j = i - pad;
    if (j < 0) j = -j;
    if (j >= x.length) j = 2 * (x.length - 1) - j;
    return x[j];
  };
  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = at(base + i) * hann[i];
      im[i] = 0;
    }
    fft(re, im, false);
    for (let k = 0; k < BINS; k++) {
      out[k * frames + f] = re[k];
      out[BINS * frames + k * frames + f] = im[k];
    }
  }
  return { data: out, frames };
}

// torch.istft(center=True, window=hann, length) of one stem from re/im planes.
export function istft(specRe, specIm, frames, length) {
  const pad = N_FFT / 2;
  const total = N_FFT + HOP * (frames - 1);
  const y = new Float64Array(total);
  const env = new Float64Array(total);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < BINS; k++) {
      re[k] = specRe[k * frames + f];
      im[k] = k === 0 || k === BINS - 1 ? 0 : specIm[k * frames + f];
    }
    for (let k = 1; k < N_FFT / 2; k++) {
      re[N_FFT - k] = re[k];
      im[N_FFT - k] = -im[k];
    }
    fft(re, im, true);
    const base = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      y[base + i] += (re[i] / N_FFT) * hann[i];
      env[base + i] += hann[i] * hann[i];
    }
  }
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = i + pad;
    out[i] = env[j] > 1e-11 ? y[j] / env[j] : 0;
  }
  return out;
}

// Mix minus music: the sfx + speech stems of the DBS-TIGER output [1, 3, 2, BINS, frames].
export function keepEffects(out, frames, length) {
  const plane = BINS * frames;
  const re = new Float32Array(plane);
  const im = new Float32Array(plane);
  for (const stem of [1, 2]) {
    const r = stem * 2 * plane;
    for (let i = 0; i < plane; i++) {
      re[i] += out[r + i];
      im[i] += out[r + plane + i];
    }
  }
  return istft(re, im, frames, length);
}

export function readWavMono(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = { format: view.getUint16(pos + 8, true), channels: view.getUint16(pos + 10, true), rate: view.getUint32(pos + 12, true), bits: view.getUint16(pos + 22, true) };
    } else if (id === 'data') {
      const channels = fmt.channels;
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const o = pos + 8 + (i * channels + c) * bytes;
          sum += fmt.format === 3 ? view.getFloat32(o, true) : view.getInt16(o, true) / 32768;
        }
        out[i] = sum / channels;
      }
      return { rate: fmt.rate, samples: out };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}
