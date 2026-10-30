const MAX_FILTER_WORKERS = 3;

// Each Worker holds its own wasm instance, about 50 MB, and Safari's memory on iPhone is unmeasured.
const MAX_SAFARI_FILTER_WORKERS = 2;
const DEFAULT_TIMEOUT_MS = 60_000;

// Half the cores leaves the rest for the page, YouTube's decoder and the coordinator Worker.
export const filterWorkerCount = (hardwareConcurrency, { isSafari = false } = {}) =>
  Math.min(isSafari ? MAX_SAFARI_FILTER_WORKERS : MAX_FILTER_WORKERS, Math.max(1, Math.floor((hardwareConcurrency || 2) / 2)));

// The caller limits concurrency to the starting size (createTaskPool), so an idle port exists for `run`
// unless a Worker was retired, and then `run` rejects. `run` transfers the sample buffers, so the caller
// passes arrays it owns outright.
export function createFilterPool(ports, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let live = [...ports];
  const idle = [...ports];
  const pending = new Map();
  let nextId = 0;

  const settle = (id, settleWith) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    settleWith(request);
  };
  // A Worker that stops answering, for example after the browser kills it for memory, would otherwise hold
  // its window and the engine's slot forever.
  const retire = (port) => {
    live = live.filter((p) => p !== port);
    port.onmessage = null;
    port.close();
  };

  for (const port of ports) {
    port.onmessage = ({ data }) =>
      settle(data.id, (request) => {
        idle.push(port);
        if (data.type === 'error') request.reject(new Error(data.message));
        else request.resolve(data);
      });
    port.onmessageerror = () => {
      for (const [id, request] of pending) {
        if (request.port === port) settle(id, ({ reject }) => reject(new Error('filter worker sent an unreadable reply')));
      }
      retire(port);
    };
  }

  return {
    get size() {
      return live.length;
    },
    load(model) {
      for (const port of live) port.postMessage({ type: 'load', model });
    },
    run({ model, sampleRate, left, right, contextBefore }) {
      const port = idle.shift();
      if (!port) return Promise.reject(new Error('no filter worker is available'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => settle(id, () => (retire(port), reject(new Error(`filter worker did not answer in ${timeoutMs / 1000} s`)))),
          timeoutMs,
        );
        pending.set(id, { resolve, reject, timer, port });
        try {
          const buffers = [left, right, ...(contextBefore ?? [])].map((samples) => samples.buffer);
          port.postMessage({ type: 'filter', id, model, sampleRate, left, right, contextBefore }, [...new Set(buffers)]);
        } catch (error) {
          settle(id, () => (idle.push(port), reject(error)));
        }
      });
    },
  };
}
