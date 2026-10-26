const DEFAULT_WARM_UP_SAMPLES = 12000;

function downmix(left, right) {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = 0.5 * (left[i] + right[i]);
  return mono;
}

export function createVoiceFilter({ filter, warmUpSamples = DEFAULT_WARM_UP_SAMPLES }) {
  return (left, right, { contextBefore } = {}) => {
    const mono = downmix(left, right);
    const [contextLeft, contextRight] = contextBefore ?? [];
    const warmUp = contextLeft?.length
      ? downmix(contextLeft, contextRight)
      : mono.subarray(0, Math.min(warmUpSamples, mono.length));

    filter.reset();
    filter.process(warmUp, new Float32Array(warmUp.length));

    const padded = new Float32Array(mono.length + filter.delay);
    padded.set(mono);
    const output = new Float32Array(padded.length);
    filter.process(padded, output);
    const voice = output.slice(filter.delay);
    return [voice, voice.slice()];
  };
}
