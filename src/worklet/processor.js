import './text-codec-polyfill.js';
import * as dpdf from '../../vendor/dpdf/dpdf.js';
import { wrapDpdf } from '../pipeline/dpdf-filter.js';
import { defineMusicFilterProcessor } from './music-filter-processor.js';

const clock =
  typeof performance === 'object' && typeof performance.now === 'function'
    ? { name: 'performance.now', now: () => performance.now() }
    : { name: 'Date.now', now: () => Date.now() };

const engines = {
  init: (wasm) => dpdf.initSync({ module: wasm }),
  create: (modelBytes) => wrapDpdf(new dpdf.Dpdf(new Uint8Array(modelBytes))),
};

registerProcessor(
  'music-filter',
  defineMusicFilterProcessor({
    Base: AudioWorkletProcessor,
    engines,
    sampleRate,
    clock,
  }),
);
