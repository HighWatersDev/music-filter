import './text-codec-polyfill.js';
import * as df from '../../vendor/df/df.js';
import { defineMusicFilterProcessor } from './music-filter-processor.js';

const clock =
  typeof performance === 'object' && typeof performance.now === 'function'
    ? { name: 'performance.now', now: () => performance.now() }
    : { name: 'Date.now', now: () => Date.now() };

registerProcessor(
  'music-filter',
  defineMusicFilterProcessor({
    Base: AudioWorkletProcessor,
    df,
    sampleRate,
    clock,
  }),
);
