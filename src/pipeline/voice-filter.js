export const DFN_DELAY_SAMPLES = 1440;
const DEFAULT_WARM_UP_SAMPLES = 12000;

function downmix(left, right, contextBefore) {
  const [contextLeft, contextRight] = contextBefore ?? [];
  const before = contextLeft?.length ?? 0;
  const mono = new Float32Array(before + left.length);
  for (let i = 0; i < before; i++) mono[i] = 0.5 * (contextLeft[i] + contextRight[i]);
  for (let i = 0; i < left.length; i++) mono[before + i] = 0.5 * (left[i] + right[i]);
  return { mono, before };
}

export function createVoiceFilter({
  processFrame,
  frameLength,
  delaySamples = DFN_DELAY_SAMPLES,
  warmUpSamples = DEFAULT_WARM_UP_SAMPLES,
}) {
  const frame = new Float32Array(frameLength);

  const feed = (mono, offset, end) => {
    frame.fill(0);
    if (offset < end) frame.set(mono.subarray(offset, Math.min(offset + frameLength, end)));
    return processFrame(frame);
  };

  return (left, right, { contextBefore } = {}) => {
    const { mono, before } = downmix(left, right, contextBefore);
    const total = mono.length;

    if (before === 0) {
      const warmUpEnd = Math.min(warmUpSamples, total);
      for (let offset = 0; offset < warmUpEnd; offset += frameLength) feed(mono, offset, warmUpEnd);
    }

    const voice = new Float32Array(left.length);
    const skip = before + delaySamples;
    for (let offset = 0; offset < total + delaySamples; offset += frameLength) {
      const out = feed(mono, offset, total);
      const first = Math.max(0, skip - offset);
      const last = Math.min(frameLength, total + delaySamples - offset);
      for (let j = first; j < last; j++) voice[offset + j - skip] = out[j];
    }
    return [voice, voice.slice()];
  };
}
