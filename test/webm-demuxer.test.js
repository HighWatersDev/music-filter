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
  assert.equal(inits[0].codecDelayNs, 6_500_000);
  assert.equal(frames[0].timeSeconds, -0.0065);
  assert.ok(Math.abs(frames[1].timeSeconds - (0.021 - 0.0065)) < 1e-9);
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

function resumeAfterAbort(injected) {
  const bytes = fixture('tone-12s.webm');
  const [, second] = clusterOffsets(bytes);
  const { frames, demuxer, warnings } = demux([bytes.subarray(0, second)]);
  const before = frames.length;
  demuxer.abort();
  demuxer.push(injected);
  demuxer.push(bytes.subarray(second));
  const reference = demux([bytes]).frames.slice(before);
  return { resumed: frames.slice(before), reference, warnings };
}

test('a throwing frame callback does not wedge the demuxer', () => {
  const bytes = fixture('tone-12s.webm');
  const frames = [];
  let firstTime = null;
  const demuxer = new WebmDemuxer({
    onInit: () => {},
    onFrame: (frame) => {
      firstTime ??= frame.timeSeconds;
      if (frame.timeSeconds === firstTime) throw new Error('callback failed');
      frames.push(frame);
    },
  });
  assert.throws(() => demuxer.push(bytes), /callback failed/);
  demuxer.push(new Uint8Array(0));
  assert.equal(frames.length, 600);
  assert.ok(frames.every((f) => f.timeSeconds !== firstTime));
});

test('random bytes before a cluster resync to that cluster', () => {
  let state = 12345;
  const random = new Uint8Array(4096).map(() => (state = (state * 1103515245 + 12345) & 0x7fffffff) >> 16);
  const { resumed, reference, warnings } = resumeAfterAbort(random);
  assert.equal(resumed.length, reference.length);
  assert.equal(resumed[0].timeSeconds, reference[0].timeSeconds);
  assert.ok(warnings.some((w) => w.startsWith('resync')));
});

test('a fake Cluster ID inside a frame payload does not cause a false resync', () => {
  const fakeCluster = [0x1f, 0x43, 0xb6, 0x75, 0x88, 0x40, 0x01, 0x10, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const block = [0xa3, 0x80 | (4 + fakeCluster.length), 0x81, 0x00, 0x00, 0x80, ...fakeCluster];
  const { resumed, reference } = resumeAfterAbort(Uint8Array.from([0x00, ...block]));
  assert.equal(resumed.length, reference.length);
  assert.equal(resumed[0].timeSeconds, reference[0].timeSeconds);
});

test('an unknown element between clusters resyncs instead of being skipped by its size', () => {
  const bytes = fixture('tone-12s.webm');
  const [, second] = clusterOffsets(bytes);
  const unknown = Uint8Array.of(0x40, 0x01, 0x10, 0x10, 0x00, 0x00);
  const spliced = new Uint8Array(bytes.length + unknown.length);
  spliced.set(bytes.subarray(0, second));
  spliced.set(unknown, second);
  spliced.set(bytes.subarray(second), second + unknown.length);
  const { frames, warnings } = demux([spliced]);
  assert.equal(frames.length, 601);
  assert.ok(warnings.some((w) => w.startsWith('resync')));
});

test('a Void element between clusters is skipped silently', () => {
  const bytes = fixture('tone-12s.webm');
  const [, second] = clusterOffsets(bytes);
  const voidElement = Uint8Array.of(0xec, 0x83, 0x00, 0x00, 0x00);
  const spliced = new Uint8Array(bytes.length + voidElement.length);
  spliced.set(bytes.subarray(0, second));
  spliced.set(voidElement, second);
  spliced.set(bytes.subarray(second), second + voidElement.length);
  const { frames, warnings } = demux([spliced]);
  assert.equal(frames.length, 601);
  assert.deepEqual(warnings, []);
});

function blockGroupStream(discardPaddingBytes) {
  const bytes = fixture('tone-12s.webm');
  const [first] = clusterOffsets(bytes);
  const opus = demux([bytes]).frames[5].data;
  const block = [0xa1, 0x40 | ((4 + opus.length) >> 8), (4 + opus.length) & 0xff, 0x81, 0x00, 0x00, 0x00, ...opus];
  const padding = [0x75, 0xa2, 0x80 | discardPaddingBytes.length, ...discardPaddingBytes];
  const group = [0xa0, 0x40 | ((block.length + padding.length) >> 8), (block.length + padding.length) & 0xff, ...block, ...padding];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00, ...group];
  return { stream: [bytes.subarray(0, first), Uint8Array.from(cluster)], opus };
}

test('DiscardPadding in a BlockGroup is passed with the frame as signed nanoseconds', () => {
  const positive = demux(blockGroupStream([0x00, 0x98, 0x96, 0x80]).stream);
  assert.equal(positive.frames.length, 1);
  assert.equal(positive.frames[0].discardPaddingNs, 10_000_000);
  assert.deepEqual(positive.warnings, []);
  const negative = demux(blockGroupStream([0xff, 0xb3, 0xb4, 0xc0]).stream);
  assert.equal(negative.frames[0].discardPaddingNs, -5_000_000);
});
