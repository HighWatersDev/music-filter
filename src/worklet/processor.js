import './text-codec-polyfill.js';
import { initSync, df_create, df_get_frame_length, df_process_frame } from '../../vendor/df/df.js';
import { defineMusicFilterProcessor } from './music-filter-processor.js';

const clock =
  typeof performance === 'object' && typeof performance.now === 'function'
    ? { name: 'performance.now', now: () => performance.now() }
    : { name: 'Date.now', now: () => Date.now() };

registerProcessor(
  'music-filter',
  defineMusicFilterProcessor({
    Base: AudioWorkletProcessor,
    df: { initSync, df_create, df_get_frame_length, df_process_frame },
    sampleRate,
    clock,
  }),
);
