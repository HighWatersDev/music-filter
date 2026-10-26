const FACTOR = 3;
const HIGH_RATE = 48000;
const CUTOFF_HZ = 7600;
const KAISER_BETA = 7.0;
const HALF_LENGTH = 144;
const TAPS = 2 * HALF_LENGTH + 1;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; term > 1e-12 * sum; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

function designLowpass() {
  const taps = new Float64Array(TAPS);
  const fc = CUTOFF_HZ / HIGH_RATE;
  const norm = besselI0(KAISER_BETA);
  let sum = 0;
  for (let k = 0; k < TAPS; k++) {
    const t = k - HALF_LENGTH;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const window = besselI0(KAISER_BETA * Math.sqrt(1 - (t / HALF_LENGTH) ** 2)) / norm;
    taps[k] = sinc * window;
    sum += taps[k];
  }
  return taps.map((tap) => tap / sum);
}

const LOWPASS = designLowpass();

function reversed(taps) {
  return Float32Array.from(taps).reverse();
}

// Each sample is written twice, `length` apart, so the newest `length` samples are always
// contiguous and the dot product needs no wrap-around check.
function createHistory(length) {
  const samples = new Float32Array(2 * length);
  let position = 0;
  return {
    push(sample) {
      samples[position] = sample;
      samples[position + length] = sample;
      position = position + 1 === length ? 0 : position + 1;
    },
    dot(oldestFirstTaps) {
      let acc = 0;
      for (let k = 0; k < length; k++) acc += oldestFirstTaps[k] * samples[position + k];
      return acc;
    },
    reset() {
      samples.fill(0);
      position = 0;
    },
  };
}

export function createDownsampler() {
  const taps = reversed(LOWPASS);
  const history = createHistory(TAPS);
  let phase = 0;
  return {
    delay: HALF_LENGTH / FACTOR,
    process(input, output, start = 0, end = input.length) {
      let written = 0;
      for (let i = start; i < end; i++) {
        history.push(input[i]);
        if (phase === 0) output[written++] = history.dot(taps);
        phase = phase + 1 === FACTOR ? 0 : phase + 1;
      }
      return written;
    },
    reset() {
      history.reset();
      phase = 0;
    },
  };
}

export function createUpsampler() {
  const phaseLength = Math.ceil(TAPS / FACTOR);
  const phases = Array.from({ length: FACTOR }, (_, p) => {
    const taps = new Float32Array(phaseLength);
    for (let j = 0; FACTOR * j + p < TAPS; j++) taps[j] = FACTOR * LOWPASS[FACTOR * j + p];
    return reversed(taps);
  });
  const history = createHistory(phaseLength);
  return {
    delay: HALF_LENGTH,
    process(input, output) {
      let written = 0;
      for (let i = 0; i < input.length; i++) {
        history.push(input[i]);
        for (let p = 0; p < FACTOR; p++) output[written++] = history.dot(phases[p]);
      }
      return written;
    },
    reset() {
      history.reset();
    },
  };
}
