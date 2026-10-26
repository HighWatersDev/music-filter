import { defineMusicFilterProcessor } from '../../src/worklet/music-filter-processor.js';

export const BLOCK = 128;
export const INPUT_LEVEL = 0.9;
export const PROCESSED_LEVEL = 0.25;
const ENGINE_DELAY_HOPS = 5;
export const DEFAULT_COSTS = { dpdfnet4: 1, dpdfnet2: 1 };

class FakeProcessorBase {
  constructor() {
    this.messages = [];
    this.port = { onmessage: null, postMessage: (message) => this.messages.push(message) };
  }
}

export function fakeEngines({ costs = DEFAULT_COSTS, createError = null } = {}) {
  const clock = { name: 'fake', time: 0, now: () => clock.time };
  const engines = {
    clock,
    behaviour: 'ok',
    created: [],
    initCalls: [],
    hops: 0,
    init(wasm) {
      engines.initCalls.push(wasm);
    },
    create(bytes) {
      if (createError) throw createError;
      const model = new TextDecoder().decode(bytes);
      const engine = {
        model,
        hop: 160,
        resets: 0,
        hopsSinceReset: 0,
        freed: false,
        processHop(input, output) {
          clock.time += costs[model];
          engines.hops += 1;
          if (engines.behaviour === 'throw') throw new Error('hop exploded');
          const isPastDelay = engine.hopsSinceReset++ >= ENGINE_DELAY_HOPS;
          output.fill(engines.behaviour === 'nan' ? Number.NaN : isPastDelay ? PROCESSED_LEVEL : 0);
        },
        reset() {
          engine.resets += 1;
          engine.hopsSinceReset = 0;
        },
        free() {
          if (engines.freeError) throw engines.freeError;
          engine.freed = true;
        },
      };
      engines.created.push(engine);
      return engine;
    },
  };
  return engines;
}

const modelBytes = (name) => new TextEncoder().encode(name).buffer;

export function createProcessor({ engines = fakeEngines(), failMode, sampleRate = 48000, options = {} } = {}) {
  const Processor = defineMusicFilterProcessor({ Base: FakeProcessorBase, engines, sampleRate, clock: engines.clock });
  const processorOptions = {
    wasm: 'wasm-module',
    models: { dpdfnet4: modelBytes('dpdfnet4'), dpdfnet2: modelBytes('dpdfnet2') },
    ...options,
  };
  if (failMode) processorOptions.failMode = failMode;
  return new Processor({ processorOptions });
}

export function render(processor, blocks, level = INPUT_LEVEL) {
  const samples = [];
  for (let block = 0; block < blocks; block++) {
    const input = [new Float32Array(BLOCK).fill(level), new Float32Array(BLOCK).fill(level)];
    const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    processor.process([input], [output]);
    samples.push(...output[0], ...output[1]);
  }
  return samples;
}

export const send = (processor, message) => processor.port.onmessage({ data: message });
export const messagesOf = (processor, type) => processor.messages.filter((message) => message.type === type);
export const isProcessed = (sample) => Math.abs(sample - PROCESSED_LEVEL) < 1e-3;
export const isInput = (sample) => Math.abs(sample - INPUT_LEVEL) < 1e-6;

export const TOTAL_DELAY = 3165;
export const leftChannel = (samples) => samples.filter((_, i) => Math.floor(i / BLOCK) % 2 === 0);
export const firstSoundAt = (samples) => leftChannel(samples).findIndex((sample) => Math.abs(sample) > 1e-6);
export const RESAMPLER_ONSET = 400;
