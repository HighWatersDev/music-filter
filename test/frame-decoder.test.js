import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebmDemuxer } from '../src/pipeline/webm-demuxer.js';
import { parseOpusHead } from '../src/pipeline/opus-head.js';
import { FrameDecoder } from '../src/pipeline/frame-decoder.js';

function demuxFixture() {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tone-12s.webm', import.meta.url)));
  let init;
  const frames = [];
  new WebmDemuxer({ onInit: (i) => (init = i), onFrame: (f) => frames.push(f) }).push(bytes);
  return { init, frames };
}

test('parseOpusHead reads stereo mapping family 0', () => {
  const { init } = demuxFixture();
  const head = parseOpusHead(init.codecPrivate);
  assert.equal(head.channels, 2);
  assert.equal(head.preSkip, 312);
  assert.equal(head.inputSampleRate, 48000);
  assert.equal(head.mappingFamily, 0);
  assert.deepEqual(head.channelMappingTable, [0, 1]);
});

test('parseOpusHead rejects other data', () => {
  assert.throws(() => parseOpusHead(new Uint8Array(19)), /OpusHead/);
});

test('decodes a contiguous run into one gapless span', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  const spans = frames.map((f) => decoder.decode(f)).filter(Boolean);
  for (let i = 1; i < spans.length; i++) {
    assert.equal(spans[i].startSample, spans[i - 1].startSample + spans[i - 1].channelData[0].length);
  }
  assert.equal(spans[0].startSample, 312);
  const left = spans.flatMap((s) => Array.from(s.channelData[0]));
  let crossings = 0;
  for (let i = 1; i < left.length; i++) if (left[i - 1] < 0 && left[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings / (left.length / 48000) - 440) < 2);
  decoder.free();
});

test('a time jump restarts with pre-roll discarded', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  for (const frame of frames.slice(0, 200)) decoder.decode(frame);
  const jumped = frames.slice(400).map((f) => decoder.decode(f)).filter(Boolean);
  const expectedStart = Math.round(frames[400].timeSeconds * 48000) + 3840;
  assert.equal(jumped[0].startSample, expectedStart);
  decoder.free();
});

test('free while configuring is safe', async () => {
  const { init } = demuxFixture();
  const decoder = new FrameDecoder();
  const configuring = decoder.configure(init);
  decoder.free();
  await configuring;
  assert.equal(decoder.isReady, false);
  assert.equal(decoder.decoder, null);
});
