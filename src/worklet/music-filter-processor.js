import { DelayLine } from './delay-line.js';
import { FrameAdapter } from './frame-adapter.js';
import { FrameStats } from './frame-stats.js';

const REPORT_EVERY_FRAMES = 100;
const RENDER_QUANTUM = 128;
// Measured at 48 kHz by cross-correlating input and df_process_frame output for impulses and voiced
// bursts (attenLimDb 1, 6 and 100). With attenLimDb 0 DeepFilterNet returns the input undelayed.
const MODEL_DELAY_SAMPLES = 1440;
const FAIL_MODES = new Set(['silence', 'passthrough']);

function isAllFinite(samples) {
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return false;
  }
  return true;
}

export function defineMusicFilterProcessor({ Base, df, sampleRate, clock }) {
  return class MusicFilterProcessor extends Base {
    constructor(options) {
      super();
      this.isBypassed = false;
      this.hasFailed = false;
      this.hasRenderFailed = false;
      this.failMode = 'silence';
      this.mono = null;
      this.renderDry = null;
      this.reportedStages = new Set();
      this.port.onmessage = ({ data }) => {
        if (data?.type === 'bypass') this.isBypassed = Boolean(data.value);
      };

      try {
        const { wasm, modelBytes, attenLimDb, failMode = 'passthrough' } = options.processorOptions;
        if (!FAIL_MODES.has(failMode)) throw new Error(`unknown failMode ${failMode}`);
        this.failMode = failMode;
        df.initSync(wasm);
        this.handle = df.df_create(new Uint8Array(modelBytes), attenLimDb);
        const frameLength = df.df_get_frame_length(this.handle);
        const modelDelay = attenLimDb === 0 ? 0 : MODEL_DELAY_SAMPLES;
        this.stats = new FrameStats({
          budgetMs: (frameLength / sampleRate) * 1000,
          quantumMs: (RENDER_QUANTUM / sampleRate) * 1000,
        });
        this.dryDelay = new DelayLine(modelDelay);
        this.dryFrame = new Float32Array(frameLength);
        this.silentFrame = new Float32Array(frameLength);
        this.adapter = new FrameAdapter(frameLength, (frame) => this.processFrame(frame));
        this.renderDelay = new DelayLine(this.adapter.latencySamples + modelDelay);
        this.port.postMessage({
          type: 'ready',
          frameLength,
          sampleRate,
          clock: clock.name,
          failMode,
          latencySamples: this.renderDelay.delaySamples,
        });
      } catch (error) {
        this.adapter = null;
        this.reportError('init', error);
      }
    }

    get isSilentOnFailure() {
      return this.failMode === 'silence';
    }

    reportError(stage, error) {
      if (this.reportedStages.has(stage)) return;
      this.reportedStages.add(stage);
      this.port.postMessage({ type: 'error', stage, message: String(error?.message ?? error) });
    }

    processFrame(frame) {
      const dry = this.dryDelay.process(frame, this.dryFrame);
      const fallback = this.isSilentOnFailure ? this.silentFrame : dry;
      if (this.hasFailed) return fallback;

      let processed;
      try {
        const start = clock.now();
        processed = df.df_process_frame(this.handle, frame);
        this.stats.record(clock.now() - start);
      } catch (error) {
        this.failProcessing(error);
        return fallback;
      }
      if (!isAllFinite(processed)) {
        this.failProcessing(new Error('df_process_frame returned a non-finite sample'));
        return fallback;
      }
      if (this.stats.count >= REPORT_EVERY_FRAMES) {
        this.port.postMessage({ type: 'stats', ...this.stats.drain() });
      }
      return this.isBypassed ? dry : processed;
    }

    failProcessing(error) {
      this.reportError('process', error);
      this.hasFailed = true;
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

    delayRenderInput(mono) {
      if (this.renderDry?.length !== mono.length) this.renderDry = new Float32Array(mono.length);
      return this.renderDelay.process(mono, this.renderDry);
    }

    writeFallback(output, dry) {
      for (const channel of output) {
        if (dry && !this.isSilentOnFailure) channel.set(dry.subarray(0, channel.length));
        else channel.fill(0);
      }
    }

    process(inputs, outputs) {
      const input = inputs[0] ?? [];
      const output = outputs[0];
      if (!output?.length) return true;

      if (!this.adapter) {
        if (this.isSilentOnFailure) this.writeFallback(output, null);
        else this.passThrough(input, output);
        return true;
      }

      let dry = null;
      try {
        const mono = this.toMono(input, input[0]?.length ?? output[0].length);
        dry = this.delayRenderInput(mono);
        if (this.hasRenderFailed) {
          this.writeFallback(output, dry);
          return true;
        }
        this.adapter.process(mono, output[0]);
        for (let channel = 1; channel < output.length; channel++) output[channel].set(output[0]);
      } catch (error) {
        this.reportError('render', error);
        this.hasRenderFailed = true;
        this.writeFallback(output, dry);
      }
      return true;
    }
  };
}
