const CONNECT = 'music-filter:connect';

const transferablesOf = (data) => [data?.left?.buffer, data?.right?.buffer].filter(Boolean);

function handleConnect(event) {
  const [port] = event.ports;
  if (event.source !== window.parent || event.data?.type !== CONNECT || !port) return;
  window.removeEventListener('message', handleConnect);

  let worker;
  try {
    worker = new Worker(chrome.runtime.getURL('dist/separator-worker.js'), { type: 'module' });
  } catch (error) {
    port.postMessage({ type: 'error', message: `separator worker failed to start: ${error.message}` });
    return;
  }
  worker.onmessage = ({ data }) => port.postMessage(data, transferablesOf(data));
  worker.onerror = (event) =>
    port.postMessage({ type: 'error', message: `separator worker error: ${event.message || 'failed to load'}` });
  port.onmessage = ({ data }) => worker.postMessage(data, transferablesOf(data));
  worker.postMessage({ type: 'connect', wasmPaths: chrome.runtime.getURL('dist/ort/') });
}

window.addEventListener('message', handleConnect);
