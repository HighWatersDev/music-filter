export class FrameAdapter {
  constructor(frameLength, processFrame) {
    this.frameLength = frameLength;
    this.processFrame = processFrame;
    this.frame = new Float32Array(frameLength);
    this.frameFill = 0;
    this.blockLength = 0;
    this.fifo = null;
    this.readIndex = 0;
    this.available = frameLength;
  }

  get latencySamples() {
    return this.frameLength;
  }

  process(input, output) {
    if (input.length !== output.length) {
      throw new Error(`FrameAdapter: input length ${input.length} differs from output length ${output.length}`);
    }
    if (this.fifo === null) {
      this.blockLength = input.length;
      // Occupancy peaks at frameLength + blockLength just before a block is read out.
      this.fifo = new Float32Array(2 * (this.frameLength + this.blockLength));
    } else if (input.length !== this.blockLength) {
      throw new Error(`FrameAdapter: block length changed from ${this.blockLength} to ${input.length}`);
    }

    for (let i = 0; i < input.length; i++) {
      this.frame[this.frameFill++] = input[i];
      if (this.frameFill === this.frameLength) {
        this.frameFill = 0;
        this.pushFrame(this.processFrame(this.frame));
      }
    }

    for (let i = 0; i < output.length; i++) {
      output[i] = this.fifo[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.fifo.length;
    }
    this.available -= output.length;
  }

  pushFrame(processed) {
    if (processed.length !== this.frameLength) {
      throw new Error(`FrameAdapter: processFrame returned ${processed.length} samples, expected ${this.frameLength}`);
    }
    let writeIndex = (this.readIndex + this.available) % this.fifo.length;
    for (let i = 0; i < processed.length; i++) {
      this.fifo[writeIndex] = processed[i];
      writeIndex = (writeIndex + 1) % this.fifo.length;
    }
    this.available += processed.length;
  }
}
