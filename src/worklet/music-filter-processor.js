import { createDpdfFilter } from '../pipeline/dpdf-filter.js';
import { DelayLine } from './delay-line.js';
import { FrameStats } from './frame-stats.js';
import { releaseBuffer } from './release-buffer.js';
import { isLiveModel, selectModel, switchTargets } from './model-choice.js';

const REPORT_EVERY_HOPS = 100;
const RENDER_QUANTUM = 128;
const HOP_INPUT_SAMPLES = 480;
const FILTER_SAMPLE_RATE = 48000;
const FIRST_MODEL = 'dpdfnet4';
const FAIL_MODES = new Set(['silence', 'passthrough']);

const wasmSourceOf = (wasm) => (wasm instanceof ArrayBuffer || ArrayBuffer.isView(wasm) ? 'bytes' : 'module');

function isAllFinite(samples) {
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return false;
  }
  return true;
}

export function defineMusicFilterProcessor({ Base, engines, sampleRate, clock }) {
  return class MusicFilterProcessor extends Base {
    constructor(options) {
      super();
      this.isBypassed = false;
      this.isIdle = false;
      this.isDisposed = false;
      this.hasFailed = false;
      this.hasRenderFailed = false;
      this.failMode = 'silence';
      this.filter = null;
      this.engine = null;
      this.model = null;
      this.isPinned = false;
      this.mono = null;
      this.renderDry = null;
      this.reportedStages = new Set();
      this.port.onmessage = ({ data }) => this.handleMessage(data);

      try {
        const { wasm, models, failMode = 'silence', model: pinnedModel, from } = options.processorOptions;
        if (!FAIL_MODES.has(failMode)) throw new Error(`unknown failMode ${failMode}`);
        this.failMode = failMode;
        for (const model of [pinnedModel, from]) {
          if (model !== undefined && !isLiveModel(model)) throw new Error(`unknown live model ${model}`);
        }
        this.isPinned = pinnedModel !== undefined;
        if (sampleRate !== FILTER_SAMPLE_RATE) {
          throw new Error(`expected a ${FILTER_SAMPLE_RATE} Hz audio context, got ${sampleRate}`);
        }
        this.models = { ...models };
        engines.init(wasm);
        const choice = this.choose(pinnedModel ?? from ?? FIRST_MODEL);
        if (!choice) return;
        this.port.postMessage({
          type: 'ready',
          model: choice.model,
          isPinned: this.isPinned,
          wasmSource: wasmSourceOf(wasm),
          warmupMs: choice.warmupMs,
          sampleRate,
          clock: clock.name,
          failMode,
          latencySamples: this.filter.delay,
          heldModels: Object.keys(this.models),
          wasmMemoryBytes: engines.memoryBytes?.(),
        });
      } catch (error) {
        this.releaseEngine();
        this.reportError('init', error);
      }
    }

    choose(model) {
      const choice = selectModel({
        from: model,
        isPinned: this.isPinned,
        createEngine: (name) => this.createEngine(name),
        clock,
      });
      this.releaseModelBytes(choice.engine ? switchTargets(choice.model, this.isPinned) : []);
      if (!choice.engine) {
        this.port.postMessage({ type: 'too-slow', warmupMs: choice.warmupMs });
        return null;
      }
      this.useEngine(choice);
      return choice;
    }

    releaseModelBytes(keep) {
      for (const model of Object.keys(this.models)) {
        if (keep.includes(model)) continue;
        releaseBuffer(this.models[model]);
        delete this.models[model];
      }
    }

    createEngine(model) {
      const bytes = this.models[model];
      if (!bytes) throw new Error(`no model bytes for ${model}`);
      return engines.create(bytes);
    }

    useEngine({ model, engine }) {
      this.engine = engine;
      this.model = model;
      this.filter = createDpdfFilter({
        engine: {
          hop: engine.hop,
          processHop: (input, output) => this.runHop(input, output),
          reset: () => engine.reset(),
        },
      });
      this.stats = new FrameStats({
        budgetMs: (HOP_INPUT_SAMPLES / sampleRate) * 1000,
        quantumMs: (RENDER_QUANTUM / sampleRate) * 1000,
      });
      this.dryDelay = new DelayLine(this.filter.delay);
    }

    releaseEngine() {
      const { engine } = this;
      this.engine = null;
      this.filter = null;
      engine?.free();
    }

    switchModel(model) {
      if (!this.filter || this.hasFailed || model === this.model) return;
      try {
        this.releaseEngine();
        const choice = this.choose(model);
        if (!choice) return;
        this.port.postMessage({
          type: 'model',
          model: choice.model,
          warmupMs: choice.warmupMs,
          latencySamples: this.filter.delay,
          heldModels: Object.keys(this.models),
          wasmMemoryBytes: engines.memoryBytes?.(),
        });
      } catch (error) {
        this.engine = null;
        this.filter = null;
        this.reportError('switch', error);
      }
    }

    handleMessage(data) {
      if (this.isDisposed) return;
      if (data?.type === 'bypass' && !this.isSilentOnFailure) this.isBypassed = Boolean(data.value);
      if (data?.type === 'idle') this.setIdle(Boolean(data.value));
      if (data?.type === 'use-model') this.switchModel(data.model);
      if (data?.type === 'dispose') this.dispose();
    }

    setIdle(isIdle) {
      if (isIdle === this.isIdle) return;
      this.isIdle = isIdle;
      if (isIdle || !this.filter) return;
      try {
        this.filter.reset();
        this.dryDelay = new DelayLine(this.filter.delay);
      } catch (error) {
        this.failProcessing(error);
      }
    }

    dispose() {
      if (this.isDisposed) return;
      this.isDisposed = true;
      try {
        this.releaseEngine();
      } catch (error) {
        this.reportError('dispose', error);
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

    runHop(input, output) {
      if (this.hasFailed) {
        output.fill(0);
        return;
      }
      try {
        const start = clock.now();
        this.engine.processHop(input, output);
        this.stats.record(clock.now() - start);
      } catch (error) {
        this.failProcessing(error);
        output.fill(0);
        return;
      }
      if (!isAllFinite(output)) {
        this.failProcessing(new Error('the model returned a non-finite sample'));
        output.fill(0);
        return;
      }
      if (this.stats.count >= REPORT_EVERY_HOPS) {
        this.port.postMessage({ type: 'stats', model: this.model, ...this.stats.drain() });
      }
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

    delayDry(mono) {
      if (this.renderDry?.length !== mono.length) this.renderDry = new Float32Array(mono.length);
      return this.dryDelay.process(mono, this.renderDry);
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
      if (this.isDisposed) {
        for (const channel of output ?? []) channel.fill(0);
        return false;
      }
      if (!output?.length) return true;
      if (this.isIdle) {
        this.writeFallback(output, null);
        return true;
      }

      if (!this.filter) {
        if (this.isSilentOnFailure) this.writeFallback(output, null);
        else this.passThrough(input, output);
        return true;
      }

      let dry = null;
      try {
        const mono = this.toMono(input, input[0]?.length ?? output[0].length);
        dry = this.delayDry(mono);
        if (this.hasFailed || this.hasRenderFailed) {
          this.writeFallback(output, dry);
          return true;
        }
        this.filter.process(mono, output[0]);
        if (this.hasFailed || this.isBypassed) {
          this.writeFallback(output, dry);
          return true;
        }
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
