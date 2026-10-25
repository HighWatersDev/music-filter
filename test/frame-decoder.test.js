import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebmDemuxer } from '../src/pipeline/webm-demuxer.js';
import { parseOpusHead } from '../src/pipeline/opus-head.js';
import { FrameDecoder, isSameDecoderConfig } from '../src/pipeline/frame-decoder.js';

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
  assert.equal(spans[0].startSample, 0);
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

test('a decoder configured mid-stream discards the pre-roll, not just the pre-skip', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  const spans = frames.slice(300).map((f) => decoder.decode(f)).filter(Boolean);
  assert.equal(spans[0].startSample, Math.round(frames[300].timeSeconds * 48000) + 3840);
  decoder.free();
});

test('samples before time zero are discarded', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  const span = decoder.decode({ ...frames[0], timeSeconds: -0.01 });
  assert.equal(span.startSample, 0);
  assert.equal(span.channelData[0].length, 960 - 480);
  decoder.free();
});

test('DiscardPadding trims the end for positive values and the start for negative ones', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  const spans = frames.slice(0, 10).map((f) => decoder.decode(f)).filter(Boolean);
  const last = spans.at(-1);
  const expected = last.startSample + last.channelData[0].length;
  const end = decoder.decode({ ...frames[10], discardPaddingNs: 10_000_000 });
  assert.equal(end.startSample, expected);
  assert.equal(end.channelData[0].length, 960 - 480);
  const start = decoder.decode({ ...frames[11], discardPaddingNs: -5_000_000 });
  assert.equal(start.startSample, expected + 960 + 240);
  assert.equal(start.channelData[0].length, 960 - 240);
  decoder.free();
});

test('isSameDecoderConfig compares codec, channels and OpusHead bytes', () => {
  const { init } = demuxFixture();
  assert.equal(isSameDecoderConfig(init, { ...init, codecPrivate: init.codecPrivate.slice() }), true);
  assert.equal(isSameDecoderConfig(init, { ...init, channels: 1 }), false);
  assert.equal(isSameDecoderConfig(init, { ...init, codecId: 'A_VORBIS' }), false);
  const changed = init.codecPrivate.slice();
  changed[10] += 1;
  assert.equal(isSameDecoderConfig(init, { ...init, codecPrivate: changed }), false);
  assert.equal(isSameDecoderConfig(init, { ...init, codecPrivate: null }), false);
  const bare = { ...init, codecPrivate: null };
  assert.equal(isSameDecoderConfig(bare, { ...bare }), true);
  assert.equal(isSameDecoderConfig(bare, { ...bare, codecDelayNs: bare.codecDelayNs + 1 }), false);
  assert.equal(isSameDecoderConfig(null, init), false);
});

test('after a join, a frame near the end of the decoded audio continues without pre-roll and skips the overlap', async () => {
  const { init, frames } = demuxFixture();
  const decoder = new FrameDecoder();
  await decoder.configure(init);
  const spans = frames.slice(0, 10).map((f) => decoder.decode(f)).filter(Boolean);
  const padded = decoder.decode({ ...frames[10], discardPaddingNs: 13_500_000 });
  const contentEnd = padded.startSample + padded.channelData[0].length;
  assert.equal(contentEnd, spans.at(-1).startSample + spans.at(-1).channelData[0].length + 960 - 648);
  decoder.markJoin();
  const shifted = { ...frames[11], timeSeconds: frames[11].timeSeconds - 0.0205 };
  const joined = decoder.decode(shifted);
  assert.equal(joined.startSample, contentEnd);
  assert.equal(joined.channelData[0].length, Math.round(shifted.timeSeconds * 48000) + 960 - contentEnd);
  const next = decoder.decode({ ...frames[12], timeSeconds: shifted.timeSeconds + 0.02 });
  assert.equal(next.startSample, joined.startSample + joined.channelData[0].length);
  decoder.free();
});

test('without a join, or when the join lands far away, the pre-roll is discarded', async () => {
  const { init, frames } = demuxFixture();
  const shift = (frame) => ({ ...frame, timeSeconds: frame.timeSeconds - 0.0205 });
  const firstStart = async (join, later) => {
    const decoder = new FrameDecoder();
    await decoder.configure(init);
    frames.slice(0, 11).forEach((f) => decoder.decode(f));
    if (join) decoder.markJoin();
    const span = later.map((f) => decoder.decode(f)).find(Boolean);
    decoder.free();
    return span.startSample;
  };
  const shifted = frames.slice(11, 20).map(shift);
  assert.equal(await firstStart(false, shifted), Math.round(shifted[0].timeSeconds * 48000) + 3840);
  assert.equal(await firstStart(true, frames.slice(200, 210)), Math.round(frames[200].timeSeconds * 48000) + 3840);
});
