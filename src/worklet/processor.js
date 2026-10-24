import './text-codec-polyfill.js';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { FrameAdapter } from './frame-adapter.js';
import { FrameStats } from './frame-stats.js';

const REPORT_EVERY_FRAMES = 100;
const RENDER_QUANTUM = 128;

const clock =
  typeof performance === 'object' && typeof performance.now === 'function'
    ? { name: 'performance.now', now: () => performance.now() }
    : { name: 'Date.now', now: () => Date.now() };

class MusicFilterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.isBypassed = false;
    this.hasFailed = false;
    this.mono = null;
    this.reportedStages = new Set();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'bypass' && !this.hasFailed) this.isBypassed = Boolean(data.value);
    };

    try {
      const { wasm, modelBytes, attenLimDb } = options.processorOptions;
      initSync(wasm);
      this.handle = df_create(new Uint8Array(modelBytes), attenLimDb);
      const frameLength = df_get_frame_length(this.handle);
      this.stats = new FrameStats({
        budgetMs: (frameLength / sampleRate) * 1000,
        quantumMs: (RENDER_QUANTUM / sampleRate) * 1000,
      });
      this.adapter = new FrameAdapter(frameLength, (frame) => this.processFrame(frame));
      this.port.postMessage({ type: 'ready', frameLength, sampleRate, clock: clock.name });
    } catch (error) {
      this.reportError('init', error);
    }
  }

  reportError(stage, error) {
    if (this.reportedStages.has(stage)) return;
    this.reportedStages.add(stage);
    this.port.postMessage({ type: 'error', stage, message: String(error?.message ?? error) });
  }

  processFrame(frame) {
    if (this.isBypassed) return frame;
    try {
      const start = clock.now();
      const processed = df_process_frame(this.handle, frame);
      this.stats.record(clock.now() - start);
      if (this.stats.count >= REPORT_EVERY_FRAMES) {
        this.port.postMessage({ type: 'stats', ...this.stats.drain() });
      }
      return processed;
    } catch (error) {
      this.reportError('process', error);
      this.hasFailed = true;
      this.isBypassed = true;
      return frame;
    }
  }

  toMono(input, length) {
    const [left, right] = input;
    if (left && !right) return left;
    if (this.mono?.length !== length) this.mono = new Float32Array(length);
    if (!left) return this.mono.fill(0);
    for (let i = 0; i < length; i++) this.mono[i] = 0.5 * (left[i] + right[i]);
    return this.mono;
  }

  passThrough(input, output) {
    try {
      const mono = this.toMono(input, output[0].length);
      for (const channel of output) channel.set(mono.subarray(0, channel.length));
    } catch {
      for (const channel of output) channel.fill(0);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    if (!output?.length) return true;

    if (!this.adapter) {
      this.passThrough(input, output);
      return true;
    }

    try {
      this.adapter.process(this.toMono(input, input[0]?.length ?? output[0].length), output[0]);
      for (let channel = 1; channel < output.length; channel++) output[channel].set(output[0]);
    } catch (error) {
      this.reportError('render', error);
      this.passThrough(input, output);
    }
    return true;
  }
}

registerProcessor('music-filter', MusicFilterProcessor);
