export const GATE = { frameSeconds: 0.5, threshold: 0.05, reachFrames: 3, fadeSeconds: 0.2 };

// NaN compares false, so a frame the detector could not score counts as music, and so does any frame
// past either end.
export function openFrames(probabilities, { threshold = GATE.threshold, reachFrames = GATE.reachFrames } = {}) {
  const quiet = Array.from(probabilities, (p) => p < threshold);
  return quiet.map((_, k) => {
    for (let j = k - reachFrames; j <= k + reachFrames; j++) if (!quiet[j]) return false;
    return true;
  });
}

// The fades sit inside the open region, so a closed frame always plays fully filtered.
export function gateCurve(open, { frameSamples, length, fadeSamples }) {
  const curve = new Float32Array(length);
  let sinceClosed = 0;
  for (let i = 0; i < length; i++) {
    sinceClosed = open[Math.floor(i / frameSamples)] ? sinceClosed + 1 : 0;
    curve[i] = sinceClosed;
  }
  let untilClosed = 0;
  for (let i = length - 1; i >= 0; i--) {
    untilClosed = curve[i] > 0 ? untilClosed + 1 : 0;
    curve[i] = Math.min(1, curve[i] / fadeSamples, untilClosed / fadeSamples);
  }
  return curve;
}

export function mixGate([left, right], [voiceLeft, voiceRight], curve) {
  const out = [new Float32Array(left.length), new Float32Array(left.length)];
  for (let i = 0; i < left.length; i++) {
    const g = curve[i];
    out[0][i] = g * left[i] + (1 - g) * voiceLeft[i];
    out[1][i] = g * right[i] + (1 - g) * voiceRight[i];
  }
  return out;
}

export function passthroughRanges(curve, sampleRate) {
  const ranges = [];
  let start = null;
  for (let i = 0; i <= curve.length; i++) {
    const isOpen = i < curve.length && curve[i] >= 0.5;
    if (isOpen && start === null) start = i;
    if (!isOpen && start !== null) {
      ranges.push([start / sampleRate, i / sampleRate]);
      start = null;
    }
  }
  return ranges;
}

export const isPassthrough = (ranges, seconds) => ranges.some(([from, to]) => seconds >= from && seconds < to);
