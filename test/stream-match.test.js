import test from 'node:test';
import assert from 'node:assert/strict';
import { findStreamForMedia, streamProblem } from '../src/pipeline/stream-match.js';

const streams = [
  { streamId: 1, mediaSourceId: 10 },
  { streamId: 2, mediaSourceId: 20 },
  { streamId: 3, mediaSourceId: 20 },
];
const objectUrls = new Map([
  [10, 'blob:a'],
  [20, 'blob:b'],
]);

test('findStreamForMedia matches the object URL and prefers the newest stream', () => {
  assert.equal(findStreamForMedia({ streams, objectUrls, src: 'blob:a' }).streamId, 1);
  assert.equal(findStreamForMedia({ streams, objectUrls, src: 'blob:b' }).streamId, 3);
});

test('findStreamForMedia matches a MediaSource attached with srcObject by its tag', () => {
  assert.equal(findStreamForMedia({ streams, objectUrls, taggedMediaSourceId: '20', src: '' }).streamId, 3);
  assert.equal(findStreamForMedia({ streams, objectUrls, taggedMediaSourceId: '20', src: 'blob:a' }).streamId, 3);
});

test('findStreamForMedia returns null for an unknown source', () => {
  assert.equal(findStreamForMedia({ streams, objectUrls, src: 'blob:c' }), null);
  assert.equal(findStreamForMedia({ streams, objectUrls, src: '' }), null);
  assert.equal(findStreamForMedia({ streams, objectUrls, taggedMediaSourceId: '99', src: 'blob:a' }), null);
});

test('streamProblem accepts Opus in WebM and rejects other types', () => {
  assert.equal(streamProblem({ mime: 'audio/webm; codecs="opus"', timestampOffset: 0 }), null);
  assert.equal(streamProblem({ mime: 'audio/webm;codecs=opus' }), null);
  assert.equal(streamProblem({ mime: 'audio/webm' }), null);
  assert.equal(streamProblem({ mime: 'audio/mp4; codecs="mp4a.40.2"' }), 'unsupported audio type audio/mp4; codecs="mp4a.40.2"');
  assert.equal(streamProblem({ mime: 'audio/webm; codecs="vorbis"' }), 'unsupported audio type audio/webm; codecs="vorbis"');
});

test('streamProblem rejects a nonzero timestamp offset', () => {
  assert.equal(streamProblem({ mime: 'audio/webm; codecs="opus"', timestampOffset: 12.5 }), 'timestamp offset');
  assert.equal(streamProblem({ mime: 'audio/webm; codecs="opus"', timestampOffset: -0 }), null);
});
