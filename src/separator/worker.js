import { createTaskPool, StreamEngine } from '../pipeline/stream-engine.js';
import { createFilterPool } from './filter-pool.js';
import { createModelPolicy } from './read-ahead-filters.js';

const post = (message, transfer = []) => self.postMessage(message, transfer);

const STREAM_MESSAGES = new Set(['stream-reset', 'stream-chunk', 'stream-replay-end', 'stream-abort', 'playhead']);
// 'dfn3' is what the read-ahead content script sent before the DPDFNet swap. It now gets DPDFNet-4 too.
const VOICE_MODELS = new Set(['dpdfnet4', 'dfn3']);
let stream = null;
let filterPool;
let modelPolicy;
let enqueueSeparation;
let hasFiltered = false;

function connect(ports) {
  filterPool = createFilterPool(ports);
  enqueueSeparation = createTaskPool(filterPool.size);
  modelPolicy = createModelPolicy({
    workers: filterPool.size,
    onModelChange: ({ model, rtf }) => {
      filterPool.load(model);
      post({ type: 'stream-status', streamId: stream?.id, stage: 'model', model, rtf });
    },
  });
}

const copyOf = (samples) => samples.slice();

function createWindowFilter(model, streamId) {
  if (model === 'fake') return async (left, right) => [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
  if (!VOICE_MODELS.has(model)) throw new Error(`unknown model ${model}`);
  if (!hasFiltered) post({ type: 'stream-status', streamId, stage: 'loading' });
  filterPool.load(modelPolicy.model);
  return async (left, right, sampleRate, { contextBefore } = {}) => {
    const used = modelPolicy.model;
    const result = await filterPool.run({
      model: used,
      sampleRate,
      left: copyOf(left),
      right: copyOf(right),
      contextBefore: contextBefore?.map(copyOf),
    });
    hasFiltered = true;
    const samples = left.length + (contextBefore?.[0]?.length ?? 0);
    modelPolicy.observe({ model: used, isWarm: result.isWarm, computeMs: result.computeMs, samples, sampleRate });
    return [result.left, result.right];
  };
}

function handleStream(data) {
  if (data.type === 'stream-reset') {
    const { streamId, resetId, model, playheadSeconds = 0 } = data;
    stream?.engine.reset();
    stream = {
      id: streamId,
      engine: new StreamEngine({
        separate: createWindowFilter(model, streamId),
        enqueue: enqueueSeparation,
        config: { maxInFlight: filterPool.size, rampWindows: true },
        playheadSeconds,
        awaitingReplay: true,
        onWindow: (window) => {
          const transfer = [...new Set([window.left.buffer, window.right.buffer])];
          post({ type: 'window', streamId, ...window }, transfer);
        },
        onStatus: (status) => post({ type: 'stream-status', streamId, resetId, ...status }),
        onWarning: (message) => post({ type: 'stream-status', streamId, stage: 'warning', message }),
      }),
    };
    return;
  }
  if (!stream || data.streamId !== stream.id) return;
  if (data.type === 'stream-chunk') stream.engine.pushChunk(new Uint8Array(data.bytes));
  if (data.type === 'stream-replay-end') stream.engine.endReplay();
  if (data.type === 'stream-abort') stream.engine.abort();
  if (data.type === 'playhead') stream.engine.setPlayhead(data.seconds, data.isPlaying);
}

self.onmessage = ({ data, ports }) => {
  if (data.type === 'connect') {
    connect(ports);
    post({ type: 'ready', filterWorkers: filterPool.size });
    return;
  }
  if (!STREAM_MESSAGES.has(data.type)) return;
  try {
    handleStream(data);
  } catch (error) {
    post({ type: 'stream-status', streamId: data.streamId, stage: 'error', message: error.message });
  }
};
