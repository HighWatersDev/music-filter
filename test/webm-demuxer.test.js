import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebmDemuxer } from '../src/pipeline/webm-demuxer.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function demux(chunks) {
  const result = { inits: [], frames: [], warnings: [] };
  const demuxer = new WebmDemuxer({
    onInit: (init) => result.inits.push(init),
    onFrame: (frame) => result.frames.push(frame),
    onWarning: (warning) => result.warnings.push(warning),
  });
  for (const chunk of chunks) demuxer.push(chunk);
  return { ...result, demuxer };
}

function randomChunks(bytes, seed) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; ) {
    const size = 1 + Math.floor(random() * 5000);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

const clusterOffsets = (bytes) => {
  const offsets = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) offsets.push(i);
  }
  return offsets;
};

test('reads the Opus track and every frame', () => {
  const { inits, frames, warnings } = demux([fixture('tone-12s.webm')]);
  assert.equal(inits.length, 1);
  assert.equal(inits[0].codecId, 'A_OPUS');
  assert.equal(inits[0].channels, 2);
  assert.equal(inits[0].sampleRate, 48000);
  assert.equal(inits[0].codecPrivate.length, 19);
  assert.equal(frames.length, 601);
  assert.equal(frames[0].timeSeconds, 0);
  assert.ok(Math.abs(frames[1].timeSeconds - 0.02) < 0.002);
  assert.deepEqual(warnings, []);
});

test('random chunk boundaries give the same frames', () => {
  const bytes = fixture('tone-12s.webm');
  const whole = demux([bytes]).frames;
  for (const seed of [1, 7, 99]) {
    const chunked = demux(randomChunks(bytes, seed)).frames;
    assert.equal(chunked.length, whole.length);
    chunked.forEach((frame, i) => {
      assert.equal(frame.timeSeconds, whole[i].timeSeconds);
      assert.deepEqual(frame.data, whole[i].data);
    });
  }
});

test('handles live-style unknown-size elements', () => {
  const { inits, frames, warnings } = demux(randomChunks(fixture('tone-live-6s.webm'), 3));
  assert.equal(inits.length, 1);
  assert.equal(frames.length, 301);
  assert.deepEqual(warnings, []);
});

test('a second init segment starts a new stream', () => {
  const bytes = fixture('tone-12s.webm');
  const { inits, frames } = demux([bytes, bytes]);
  assert.equal(inits.length, 2);
  assert.equal(frames.length, 1202);
});

test('after abort, parsing resumes at the next cluster', () => {
  const bytes = fixture('tone-12s.webm');
  const [, second, third] = clusterOffsets(bytes);
  const { frames, demuxer } = demux([bytes.subarray(0, second + 500)]);
  const before = frames.length;
  demuxer.abort();
  demuxer.push(bytes.subarray(third));
  const resumed = frames.slice(before);
  const reference = demux([bytes]).frames.filter((f) => f.timeSeconds >= resumed[0].timeSeconds);
  assert.ok(resumed.length > 50);
  assert.equal(resumed.length, reference.length);
  assert.equal(resumed[0].timeSeconds, reference[0].timeSeconds);
});

test('garbage before a cluster is skipped with a warning', () => {
  const bytes = fixture('tone-12s.webm');
  const [, second] = clusterOffsets(bytes);
  const { frames, demuxer, warnings } = demux([bytes.subarray(0, second)]);
  const before = frames.length;
  demuxer.abort();
  demuxer.push(Uint8Array.of(0x00, 0x00, 0x13, 0x37));
  demuxer.push(bytes.subarray(second));
  assert.ok(frames.length > before);
  assert.ok(warnings.some((w) => w.startsWith('resync')));
});
