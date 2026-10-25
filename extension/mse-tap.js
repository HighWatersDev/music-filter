(() => {
  if (window.__musicFilterMseTap) return;
  const MAX_STREAM_BYTES = 8 * 1024 * 1024;
  const mimeBySourceBuffer = new WeakMap();
  const state = { installed: [], audioMime: null, audioAppends: 0, audioBytes: 0, videoAppends: 0, chunks: [], streamBytes: 0 };
  window.__musicFilterMseTap = state;

  const copyBytes = (data) => {
    const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    return view.slice();
  };

  function wrapMediaSource(MediaSourceClass, name) {
    if (!MediaSourceClass?.prototype?.addSourceBuffer) return;
    const original = MediaSourceClass.prototype.addSourceBuffer;
    MediaSourceClass.prototype.addSourceBuffer = function (mime) {
      const sourceBuffer = original.call(this, mime);
      mimeBySourceBuffer.set(sourceBuffer, mime);
      return sourceBuffer;
    };
    state.installed.push(name);
  }

  function wrapSourceBuffer(SourceBufferClass, name) {
    if (!SourceBufferClass?.prototype?.appendBuffer) return;
    const original = SourceBufferClass.prototype.appendBuffer;
    SourceBufferClass.prototype.appendBuffer = function (data) {
      const mime = mimeBySourceBuffer.get(this) ?? '';
      if (mime.startsWith('audio/')) {
        const bytes = copyBytes(data);
        state.audioMime = mime;
        state.audioAppends += 1;
        state.audioBytes += bytes.byteLength;
        if (state.streamBytes + bytes.byteLength <= MAX_STREAM_BYTES) {
          state.chunks.push(bytes);
          state.streamBytes += bytes.byteLength;
        }
      } else if (mime.startsWith('video/')) {
        state.videoAppends += 1;
      }
      return original.call(this, data);
    };
    state.installed.push(name);
  }

  wrapMediaSource(window.MediaSource, 'MediaSource');
  wrapMediaSource(window.ManagedMediaSource, 'ManagedMediaSource');
  wrapSourceBuffer(window.SourceBuffer, 'SourceBuffer');
  wrapSourceBuffer(window.ManagedSourceBuffer, 'ManagedSourceBuffer');

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'mf-mse-tap-request') return;
    const { installed, audioMime, audioAppends, audioBytes, videoAppends, chunks, streamBytes } = state;
    const stream = new Uint8Array(streamBytes);
    let offset = 0;
    for (const chunk of chunks) {
      stream.set(chunk, offset);
      offset += chunk.byteLength;
    }
    window.postMessage({ type: 'mf-mse-tap-report', installed, audioMime, audioAppends, audioBytes, videoAppends, stream }, '*');
  });
})();
