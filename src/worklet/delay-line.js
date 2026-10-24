export class DelayLine {
  constructor(delaySamples) {
    if (!Number.isInteger(delaySamples) || delaySamples < 0) {
      throw new RangeError(`DelayLine: delay must be a non-negative integer, got ${delaySamples}`);
    }
    this.buffer = new Float32Array(delaySamples);
    this.index = 0;
  }

  get delaySamples() {
    return this.buffer.length;
  }

  process(input, output) {
    if (input.length !== output.length) {
      throw new Error(`DelayLine: input length ${input.length} differs from output length ${output.length}`);
    }
    const { buffer } = this;
    if (buffer.length === 0) {
      output.set(input);
      return output;
    }
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      output[i] = buffer[this.index];
      buffer[this.index] = sample;
      this.index = (this.index + 1) % buffer.length;
    }
    return output;
  }
}
