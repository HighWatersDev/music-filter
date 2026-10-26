import { createDownsampler, createUpsampler } from './resampler.js';

const FACTOR = 3;
export const DPDF_HOP = 160;
export const DPDF_ENGINE_DELAY = 800;
const INPUT_HOP = FACTOR * DPDF_HOP;
// A hop runs only when its last 16 kHz sample arrives, which is up to 477 input samples after
// the previous hop's output ran out. Starting the output queue with that much silence means
// it never runs dry for any block size.
const HOP_BUFFERING = INPUT_HOP - FACTOR;

export function wrapDpdf(dpdf) {
  return {
    hop: dpdf.hop,
    processHop: (input, output) => dpdf.process_hop(input, output),
    reset: () => dpdf.reset(),
    free: () => dpdf.free(),
  };
}

export function createDpdfFilter({ engine, engineDelay = DPDF_ENGINE_DELAY }) {
  if (engine.hop !== DPDF_HOP) throw new Error(`expected an engine hop of ${DPDF_HOP} samples, got ${engine.hop}`);
  const down = createDownsampler();
  const up = createUpsampler();
  const low = new Float32Array(DPDF_HOP);
  const hopIn = new Float32Array(DPDF_HOP);
  const hopOut = new Float32Array(DPDF_HOP);
  const high = new Float32Array(INPUT_HOP);
  const queue = new Float32Array(HOP_BUFFERING + 2 * INPUT_HOP);
  let hopFill = 0;
  let head = 0;
  let queued = 0;

  const enqueue = (samples) => {
    let tail = (head + queued) % queue.length;
    for (let i = 0; i < samples.length; i++) {
      queue[tail] = samples[i];
      tail = tail + 1 === queue.length ? 0 : tail + 1;
    }
    queued += samples.length;
  };

  const dequeue = (output, start, end) => {
    for (let i = start; i < end; i++) {
      output[i] = queue[head];
      head = head + 1 === queue.length ? 0 : head + 1;
    }
    queued -= end - start;
  };

  const reset = () => {
    down.reset();
    up.reset();
    hopFill = 0;
    queue.fill(0);
    head = 0;
    queued = HOP_BUFFERING;
  };
  reset();

  return {
    delay: HOP_BUFFERING + FACTOR * down.delay + FACTOR * engineDelay + up.delay,
    process(input, output) {
      for (let start = 0; start < input.length; start += INPUT_HOP) {
        const end = Math.min(start + INPUT_HOP, input.length);
        const count = down.process(input.subarray(start, end), low);
        for (let i = 0; i < count; i++) {
          hopIn[hopFill++] = low[i];
          if (hopFill < DPDF_HOP) continue;
          engine.processHop(hopIn, hopOut);
          up.process(hopOut, high);
          enqueue(high);
          hopFill = 0;
        }
        dequeue(output, start, end);
      }
    },
    reset() {
      reset();
      engine.reset();
    },
  };
}
