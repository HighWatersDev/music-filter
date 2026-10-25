import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCRIPT = readFileSync(new URL('../extension/mse-tap.js', import.meta.url), 'utf8');
const CONNECT = 'music-filter:tap-connect';

function loadTap(defineClasses) {
  const listeners = {};
  const window = {
    addEventListener: (type, handler) => (listeners[type] = handler),
    document: { addEventListener() {}, getElementById: () => null },
    URL: { createObjectURL: () => 'blob:fake' },
    setInterval: () => 0,
    ArrayBuffer,
    Uint8Array,
  };
  window.window = window;
  Object.assign(window, defineClasses());
  const context = vm.createContext(window);
  vm.runInContext(SCRIPT, context);
  const pageWindow = vm.runInContext('window', context);
  const events = [];
  const connect = () => {
    const port = { postMessage: (event) => events.push(event) };
    listeners.message({ source: pageWindow, data: { type: CONNECT }, ports: [port] });
  };
  return { window, events, connect };
}

function exercise(window, MediaSourceName) {
  const mediaSource = new window[MediaSourceName]();
  const sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs="opus"');
  sourceBuffer.appendBuffer(Uint8Array.of(1, 2, 3));
  sourceBuffer.appendBuffer(Uint8Array.of(4, 5));
}

test('wraps Managed classes that only inherit their methods (iPhone Safari)', () => {
  const { window, events, connect } = loadTap(() => {
    class HiddenSourceBuffer {
      appendBuffer() {}
      abort() {}
    }
    class ManagedSourceBuffer extends HiddenSourceBuffer {}
    class HiddenMediaSource {
      addSourceBuffer() {
        return new ManagedSourceBuffer();
      }
    }
    class ManagedMediaSource extends HiddenMediaSource {}
    return { ManagedMediaSource, ManagedSourceBuffer };
  });
  exercise(window, 'ManagedMediaSource');
  connect();
  assert.deepEqual(
    events.map((e) => e.kind),
    ['source-buffer', 'append', 'append'],
  );
  assert.equal(events[0].isManaged, true);
  assert.deepEqual([...new Uint8Array(events[1].bytes)], [1, 2, 3]);
});

test('a parent shared by both classes is wrapped once (no duplicate events)', () => {
  const { window, events, connect } = loadTap(() => {
    class SourceBuffer {
      appendBuffer() {}
      abort() {}
    }
    class ManagedSourceBuffer extends SourceBuffer {}
    class MediaSource {
      addSourceBuffer() {
        return new SourceBuffer();
      }
    }
    class ManagedMediaSource extends MediaSource {}
    return { MediaSource, SourceBuffer, ManagedMediaSource, ManagedSourceBuffer };
  });
  exercise(window, 'MediaSource');
  connect();
  assert.deepEqual(
    events.map((e) => e.kind),
    ['source-buffer', 'append', 'append'],
  );
  assert.equal(events[0].isManaged, false);
});

test('video SourceBuffers are not reported', () => {
  const { window, events, connect } = loadTap(() => {
    class SourceBuffer {
      appendBuffer() {}
      abort() {}
    }
    class MediaSource {
      addSourceBuffer() {
        return new SourceBuffer();
      }
    }
    return { MediaSource, SourceBuffer };
  });
  new window.MediaSource().addSourceBuffer('video/webm; codecs="vp9"').appendBuffer(Uint8Array.of(9));
  connect();
  assert.deepEqual(events, []);
});
