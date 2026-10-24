const BATCH_FRAMES = 16384;

class ClipRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.remaining = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.remaining = data.frames;
        this.startBatch();
      }
      if (data.type === 'stop') this.remaining = 0;
    };
  }

  startBatch() {
    const size = Math.min(BATCH_FRAMES, this.remaining);
    this.left = new Float32Array(size);
    this.right = new Float32Array(size);
    this.filled = 0;
  }

  process(inputs) {
    if (this.remaining <= 0) return true;
    const [left, right = left] = inputs[0];
    let offset = 0;
    const blockLength = left?.length ?? 128;
    while (offset < blockLength && this.remaining > 0) {
      const count = Math.min(blockLength - offset, this.left.length - this.filled);
      if (left) {
        this.left.set(left.subarray(offset, offset + count), this.filled);
        this.right.set(right.subarray(offset, offset + count), this.filled);
      }
      this.filled += count;
      this.remaining -= count;
      offset += count;
      if (this.filled === this.left.length) {
        const isLast = this.remaining === 0;
        this.port.postMessage({ type: 'chunk', left: this.left, right: this.right, isLast }, [
          this.left.buffer,
          this.right.buffer,
        ]);
        if (!isLast) this.startBatch();
      }
    }
    return true;
  }
}

registerProcessor('clip-recorder', ClipRecorder);
