export class FrameAdapter {
  constructor(frameLength, processFrame) {
    this.frameLength = frameLength;
    this.processFrame = processFrame;
    this.frame = new Float32Array(frameLength);
    this.frameFill = 0;
    this.fifo = new Float32Array(frameLength * 4);
    this.readIndex = 0;
    this.available = frameLength;
  }

  get latencySamples() {
    return this.frameLength;
  }

  process(input, output) {
    for (let i = 0; i < input.length; i++) {
      this.frame[this.frameFill++] = input[i];
      if (this.frameFill === this.frameLength) {
        this.pushFrame(this.processFrame(this.frame));
        this.frameFill = 0;
      }
    }

    for (let i = 0; i < output.length; i++) {
      output[i] = this.fifo[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.fifo.length;
    }
    this.available -= output.length;
  }

  pushFrame(processed) {
    let writeIndex = (this.readIndex + this.available) % this.fifo.length;
    for (let i = 0; i < processed.length; i++) {
      this.fifo[writeIndex] = processed[i];
      writeIndex = (writeIndex + 1) % this.fifo.length;
    }
    this.available += processed.length;
  }
}
