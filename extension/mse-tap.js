(() => {
  if (window.__musicFilterTap) return;
  const CONNECT = 'music-filter:tap-connect';
  const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (object) => {
    if (!ids.has(object)) ids.set(object, nextId++);
    return ids.get(object);
  };
  const audioStreamIds = new WeakMap();
  const queue = [];
  let queuedBytes = 0;
  let droppedBytes = 0;
  let port = null;
  window.__musicFilterTap = { isConnected: () => Boolean(port), droppedBytes: () => droppedBytes };

  const copy = (data) =>
    (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)).slice()
      .buffer;

  function emit(event) {
    const transfer = event.bytes ? [event.bytes] : [];
    if (port) {
      port.postMessage(event, transfer);
      return;
    }
    if (event.bytes) {
      if (queuedBytes + event.bytes.byteLength > MAX_QUEUED_BYTES) {
        droppedBytes += event.bytes.byteLength;
        return;
      }
      queuedBytes += event.bytes.byteLength;
    }
    queue.push(event);
  }

  function wrapMediaSource(MediaSourceClass) {
    const proto = MediaSourceClass?.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'addSourceBuffer')) return;
    const addSourceBuffer = proto.addSourceBuffer;
    proto.addSourceBuffer = function (mime) {
      const sourceBuffer = addSourceBuffer.call(this, mime);
      if (String(mime).startsWith('audio/')) {
        const streamId = idOf(sourceBuffer);
        const isManaged = typeof window.ManagedMediaSource === 'function' && this instanceof window.ManagedMediaSource;
        audioStreamIds.set(sourceBuffer, streamId);
        emit({ kind: 'source-buffer', streamId, mediaSourceId: idOf(this), mime: String(mime), isManaged });
      }
      return sourceBuffer;
    };
  }

  function wrapSourceBuffer(SourceBufferClass) {
    const proto = SourceBufferClass?.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'appendBuffer')) return;
    const appendBuffer = proto.appendBuffer;
    const abort = proto.abort;
    proto.appendBuffer = function (data) {
      const streamId = audioStreamIds.get(this);
      if (streamId) emit({ kind: 'append', streamId, bytes: copy(data) });
      return appendBuffer.call(this, data);
    };
    proto.abort = function () {
      const streamId = audioStreamIds.get(this);
      if (streamId) emit({ kind: 'abort', streamId });
      return abort.call(this);
    };
  }

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    const url = createObjectURL.call(URL, object);
    if (object && typeof object.addSourceBuffer === 'function') emit({ kind: 'object-url', mediaSourceId: idOf(object), url });
    return url;
  };

  wrapMediaSource(window.MediaSource);
  wrapMediaSource(window.ManagedMediaSource);
  wrapSourceBuffer(window.SourceBuffer);
  wrapSourceBuffer(window.ManagedSourceBuffer);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== CONNECT || port || !event.ports[0]) return;
    port = event.ports[0];
    for (const queued of queue.splice(0)) port.postMessage(queued, queued.bytes ? [queued.bytes] : []);
    queuedBytes = 0;
  });
})();
