export const DFN_DELAY_SAMPLES = 1440;
const DEFAULT_WARM_UP_SAMPLES = 12000;

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

  return (left, right) => {
    const { length } = left;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) mono[i] = 0.5 * (left[i] + right[i]);

    const warmUpEnd = Math.min(warmUpSamples, length);
    for (let offset = 0; offset < warmUpEnd; offset += frameLength) feed(mono, offset, warmUpEnd);

    const voice = new Float32Array(length);
    for (let offset = 0; offset < length + delaySamples; offset += frameLength) {
      const out = feed(mono, offset, length);
      const first = Math.max(0, delaySamples - offset);
      const last = Math.min(frameLength, length + delaySamples - offset);
      for (let j = first; j < last; j++) voice[offset + j - delaySamples] = out[j];
    }
    return [voice, voice.slice()];
  };
}
