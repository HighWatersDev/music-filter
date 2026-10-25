const SEPARATOR_PAGE = 'separator.html';
const CONNECT = 'music-filter:connect';
const START_TIMEOUT_MS = 15000;

// Safari URLs like safari-web-extension://id/ have the opaque origin "null", which postMessage rejects.
// '*' still delivers only to this frame's window, and the host page can already reach that frame.
export function frameTargetOrigin(src) {
  const { origin } = new URL(src);
  return origin === 'null' ? '*' : origin;
}

export function connectSeparator({ onMessage }) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(SEPARATOR_PAGE);
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    Object.assign(frame.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '1px',
      height: '1px',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
    });
    const fail = (error) => {
      clearTimeout(timer);
      frame.remove();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('separator frame did not start')), START_TIMEOUT_MS);
    frame.addEventListener(
      'load',
      () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => {
          if (data.type === 'error') return fail(new Error(data.message));
          if (data.type !== 'ready') return;
          clearTimeout(timer);
          channel.port1.onmessage = ({ data: message }) => onMessage(message);
          resolve({ port: channel.port1, frame, info: data });
        };
        frame.contentWindow.postMessage({ type: CONNECT }, frameTargetOrigin(frame.src), [channel.port2]);
      },
      { once: true },
    );
    document.documentElement.append(frame);
  });
}
