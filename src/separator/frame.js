import { filterWorkerCount } from './filter-pool.js';

const CONNECT = 'music-filter:connect';

const transferablesOf = (data) => [
  ...new Set([data?.left?.buffer, data?.right?.buffer, data?.bytes instanceof ArrayBuffer ? data.bytes : null].filter(Boolean)),
];

function handleConnect(event) {
  const [port] = event.ports;
  if (event.source !== window.parent || event.data?.type !== CONNECT || !port) return;
  window.removeEventListener('message', handleConnect);

  const reportError = (what) => (event) =>
    port.postMessage({ type: 'error', message: `${what} error: ${event.message || 'failed to load'}` });
  let worker;
  const filterWorkers = [];
  const filterPorts = [];
  const isSafari = navigator.vendor === 'Apple Computer, Inc.';
  try {
    worker = new Worker(chrome.runtime.getURL('dist/separator-worker.js'), { type: 'module' });
    for (let i = 0; i < filterWorkerCount(navigator.hardwareConcurrency, { isSafari }); i++) {
      const filterWorker = new Worker(chrome.runtime.getURL('dist/filter-worker.js'), { type: 'module' });
      filterWorkers.push(filterWorker);
      filterWorker.onerror = reportError('filter worker');
      const channel = new MessageChannel();
      filterWorker.postMessage({ type: 'port' }, [channel.port2]);
      filterPorts.push(channel.port1);
    }
  } catch (error) {
    worker?.terminate();
    filterWorkers.forEach((filterWorker) => filterWorker.terminate());
    port.postMessage({ type: 'error', message: `separator worker failed to start: ${error.message}` });
    return;
  }
  worker.onmessage = ({ data }) => port.postMessage(data, transferablesOf(data));
  worker.onerror = reportError('separator worker');
  port.onmessage = ({ data }) => worker.postMessage(data, transferablesOf(data));
  worker.postMessage({ type: 'connect' }, filterPorts);
}

window.addEventListener('message', handleConnect);
