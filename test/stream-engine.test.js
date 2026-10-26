import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSerialQueue, StreamEngine } from '../src/pipeline/stream-engine.js';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tone-12s.webm', import.meta.url)));
const long = new Uint8Array(readFileSync(new URL('./fixtures/tone-60s.webm', import.meta.url)));
const halve = async (left, right) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return [left.map((s) => s * 0.5), right.map((s) => s * 0.5)];
};

function startEngine(options = {}) {
  const windows = [];
  const statuses = [];
  const engine = new StreamEngine({
    separate: options.separate ?? halve,
    onWindow: (w) => windows.push(w),
    onStatus: (s) => statuses.push(s),
    config: options.config,
    enqueue: options.enqueue,
    playheadSeconds: options.playheadSeconds,
    awaitingReplay: options.awaitingReplay,
  });
  return { engine, windows, statuses };
}

async function settle(engine) {
  await engine.ready;
  for (let i = 0; i < 200 && (engine.inFlight || !engine.isIdle()); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('emits a short first window then overlapping windows', async () => {
  const { engine, windows } = startEngine();
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].startSeconds, 0);
  assert.ok(Math.abs(windows[0].left.length / 48000 - 2) < 0.001);
  assert.ok(Math.abs(windows[1].startSeconds - (windows[0].startSeconds + 1)) < 0.001);
  assert.equal(windows[1].sampleRate, 48000);
});

test('separated audio is what the separator returned', async () => {
  const passThrough = startEngine({ separate: async (left, right) => [left.slice(), right.slice()] });
  passThrough.engine.pushChunk(bytes);
  passThrough.engine.setPlayhead(0, true);
  await settle(passThrough.engine);
  const { engine, windows } = startEngine();
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  const input = passThrough.windows[0].left;
  const output = windows[0].left;
  assert.equal(output.length, input.length);
  assert.ok(input.some((sample) => Math.abs(sample) > 0.05));
  assert.ok(output.every((sample, i) => sample === input[i] * 0.5));
});

test('a seek plans from the new playhead', async () => {
  const { engine, windows } = startEngine();
  engine.pushChunk(bytes);
  engine.setPlayhead(8, true);
  await settle(engine);
  assert.ok(Math.abs(windows[0].startSeconds - 8) < 0.001);
});

test('reset discards a window still in flight', async () => {
  let release;
  const slow = (left, right) => new Promise((resolve) => (release = () => resolve([left, right])));
  const { engine, windows } = startEngine({ separate: slow });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await engine.ready;
  assert.ok(engine.inFlight);
  engine.reset();
  release();
  await settle(engine);
  assert.equal(windows.length, 0);
});

test('a separation error halts the engine and reports it', async () => {
  const failing = async () => {
    throw new Error('boom');
  };
  const { engine, windows, statuses } = startEngine({ separate: failing });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.equal(windows.length, 0);
  assert.ok(statuses.some((s) => s.stage === 'error' && s.message === 'boom'));
});

test('a non-Opus track is reported as unsupported', async () => {
  const { engine, statuses } = startEngine();
  await engine.ready;
  engine.handleInit({ codecId: 'A_AAC' });
  assert.ok(statuses.some((s) => s.stage === 'unsupported'));
});

test('a bad OpusHead halts the engine and reports it', async () => {
  const { engine, statuses } = startEngine();
  engine.handleInit({ codecId: 'A_OPUS', codecPrivate: new Uint8Array(19), seekPreRollNs: 0 });
  await engine.ready;
  assert.ok(statuses.some((s) => s.stage === 'error' && /OpusHead/.test(s.message)));
  assert.equal(engine.isIdle(), true);
});

const chunked = (size) => {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
  return chunks;
};

test('a window spans a tiny hole in decoded audio with silence and keeps processed contiguous', async () => {
  const S = 48000;
  const inputs = [];
  const capture = async (left, right) => {
    inputs.push(left);
    return [left, right];
  };
  const { engine } = startEngine({ separate: capture });
  const ones = (length) => [new Float32Array(length).fill(1), new Float32Array(length).fill(1)];
  engine.timeline.write(0, ones(5 * S));
  engine.timeline.write(5 * S + 360, ones(55 * S - 360));
  engine.processed = [[0, 5 * S]];
  engine.setPlayhead(1, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(inputs[0].length, 10 * S);
  assert.ok(inputs[0].subarray(1 * S, 1 * S + 360).every((sample) => sample === 0));
  assert.ok(inputs[0].subarray(0, 1 * S).every((sample) => sample === 1));
  assert.ok(inputs[0].subarray(1 * S + 360).every((sample) => sample === 1));
  assert.equal(engine.processed.length, 1);
  assert.equal(engine.processed[0][0], 0);
  assert.ok(engine.processed[0][1] >= 14 * S);
});

test('planning runs once per pushed chunk, so a large chunk gives a full first window', async () => {
  const [head, ...rest] = chunked(2048);
  const { engine, windows } = startEngine();
  engine.setPlayhead(0, true);
  engine.pushChunk(head);
  await engine.ready;
  const tail = new Uint8Array(rest.reduce((n, c) => n + c.length, 0));
  rest.reduce((offset, c) => (tail.set(c, offset), offset + c.length), 0);
  engine.pushChunk(tail);
  await settle(engine);
  assert.ok(Math.abs(windows[0].left.length / 48000 - 2) < 0.001);
});

test('streaming in 2 KB chunks gives windows that each add at least the minimum of new audio', async () => {
  const { engine, windows } = startEngine({ separate: async (left, right) => [left, right] });
  engine.setPlayhead(0, true);
  for (const chunk of chunked(2048)) {
    engine.pushChunk(chunk);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await settle(engine);
  let processedEnd = 0;
  for (const w of windows) {
    const end = w.startSeconds + w.left.length / 48000;
    assert.ok(end - processedEnd >= 0.999, `window at ${w.startSeconds} adds only ${end - processedEnd} s`);
    processedEnd = end;
  }
  assert.ok(windows.length <= 6, `${windows.length} windows`);
});

function clusterOffsets(data) {
  const offsets = [];
  for (let i = 0; i + 4 <= data.length; i++) {
    if (data[i] === 0x1f && data[i + 1] === 0x43 && data[i + 2] === 0xb6 && data[i + 3] === 0x75) offsets.push(i);
  }
  return offsets;
}

test('two concatenated segments with the same Opus parameters decode with no hole at the join', async () => {
  const clusters = clusterOffsets(bytes);
  const { engine } = startEngine();
  engine.setPlayhead(0, true);
  engine.pushChunk(bytes.subarray(0, clusters[1]));
  await settle(engine);
  const decoder = engine.decoder;
  engine.pushChunk(bytes.subarray(0, clusters[0]));
  engine.pushChunk(bytes.subarray(clusters[1]));
  await settle(engine);
  assert.ok(engine.decoder === decoder, "decoder was replaced");
  assert.equal(engine.timeline.ranges.length, 1);
  assert.equal(engine.processed.length, 1);
  assert.ok(engine.processed[0][1] > 10 * 48000);
});

test('two separately encoded segments joined with a re-sent init leave no hole', async () => {
  const joined = new Uint8Array(readFileSync(new URL('./fixtures/tone-join-6s.webm', import.meta.url)));
  const { engine } = startEngine({ separate: async (left, right) => [left, right] });
  engine.setPlayhead(0, true);
  engine.pushChunk(joined);
  await settle(engine);
  assert.equal(engine.timeline.ranges.length, 1, JSON.stringify(engine.timeline.ranges));
  const [[start, end]] = engine.timeline.ranges;
  assert.ok(start === 0 && end >= 5.99 * 48000);
});

test('a segment with a different Opus configuration gets a new decoder', async () => {
  const clusters = clusterOffsets(bytes);
  const inits = [];
  const { engine } = startEngine();
  const handleInit = engine.handleInit.bind(engine);
  engine.handleInit = (init) => {
    inits.push(init);
    handleInit(init);
  };
  engine.pushChunk(bytes.subarray(0, clusters[1]));
  await settle(engine);
  const decoder = engine.decoder;
  const codecPrivate = inits[0].codecPrivate.slice();
  codecPrivate[10] += 1;
  engine.handleInit({ ...inits[0], codecPrivate });
  await settle(engine);
  assert.ok(engine.decoder !== decoder, "decoder was kept");
  assert.equal(engine.decoder.preSkip, inits[0].codecPrivate[10] + 1 + inits[0].codecPrivate[11] * 256);
});

test('a separator that throws synchronously reports an error instead of wedging the engine', async () => {
  const throwing = () => {
    throw new Error('sync boom');
  };
  const { engine, statuses } = startEngine({ separate: throwing });
  engine.pushChunk(bytes);
  await engine.ready;
  assert.doesNotThrow(() => engine.setPlayhead(0, true));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(statuses.some((s) => s.stage === 'error' && s.message === 'sync boom'));
  assert.equal(engine.inFlight, null);
});

test('the engine is not idle while frames wait for the decoder', () => {
  const { engine } = startEngine();
  engine.pushChunk(bytes);
  assert.ok(engine.queuedPackets().count > 0);
  assert.equal(engine.isIdle(), false);
});

test('the engine is not idle while a window is being separated', async () => {
  let release;
  const slow = (left, right) => new Promise((resolve) => (release = () => resolve([left, right])));
  const { engine } = startEngine({ separate: slow });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await engine.ready;
  assert.ok(engine.inFlight);
  assert.equal(engine.isIdle(), false);
  release();
});

test('a backward seek drops processed ranges ahead but keeps the decoded audio, so playback continues', async () => {
  const S = 48000;
  const config = { firstWindowSeconds: 1, windowSeconds: 2, lookaheadSeconds: 2, keepAheadSeconds: 3 };
  const { engine, windows, statuses } = startEngine({ config });
  engine.pushChunk(bytes);
  engine.setPlayhead(8, true);
  await settle(engine);
  assert.ok(engine.processed.some(([, e]) => e > 9 * S));
  const before = windows.length;
  engine.setPlayhead(7, true);
  assert.ok(engine.processed.every(([, e]) => e <= (7 + 2 + 2) * S));
  await settle(engine);
  assert.equal(windows[before].startSeconds, 7);
  for (let seconds = 7; seconds <= 11.5; seconds += 0.25) {
    engine.setPlayhead(seconds, true);
    await settle(engine);
  }
  assert.deepEqual(starvedAt(statuses), []);
  assert.ok(engine.processed.some(([s, e]) => s <= 11.5 * S && e >= 11.9 * S));
});

test('separate calls never overlap, even across a reset', async () => {
  let active = 0;
  let overlapped = false;
  const releases = [];
  const exclusive = (left, right) => {
    active += 1;
    if (active > 1) overlapped = true;
    return new Promise((resolve) =>
      releases.push(() => {
        active -= 1;
        resolve([left, right]);
      }),
    );
  };
  const { engine } = startEngine({ separate: exclusive });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await engine.ready;
  assert.equal(releases.length, 1);
  engine.reset();
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await engine.ready;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(overlapped, false);
  assert.equal(releases.length, 1);
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(releases.length, 1);
  assert.equal(overlapped, false);
  releases.shift()();
});

test('engines sharing a queue never run separate concurrently', async () => {
  let active = 0;
  let overlapped = false;
  const releases = [];
  const exclusive = (left, right) => {
    active += 1;
    if (active > 1) overlapped = true;
    return new Promise((resolve) =>
      releases.push(() => {
        active -= 1;
        resolve([left, right]);
      }),
    );
  };
  const enqueue = createSerialQueue();
  const first = startEngine({ separate: exclusive, enqueue });
  const second = startEngine({ separate: exclusive, enqueue });
  for (const { engine } of [first, second]) {
    engine.pushChunk(bytes);
    engine.setPlayhead(0, true);
    await engine.ready;
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(releases.length, 1);
  first.engine.reset();
  releases.shift()();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(overlapped, false);
  assert.equal(releases.length, 1);
  releases.shift()();
});

test('a continuing window gets up to 2 s of the decoded audio before it as context, the first window none', async () => {
  const S = 48000;
  const calls = [];
  const capture = async (left, right, rate, options) => {
    calls.push({ left, options });
    return [left, right];
  };
  const { engine } = startEngine({ separate: capture, config: { windowSeconds: 4, warmUpBeforeSeconds: 2 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  const contextLengths = calls.map(({ options }) => options.contextBefore[0].length);
  assert.deepEqual(contextLengths.slice(0, 4), [0, 1 * S, 2 * S, 2 * S]);
  const [first, second, third] = calls;
  assert.equal(third.options.contextBefore[1].length, 2 * S);
  assertSame(second.options.contextBefore[0], first.left.subarray(0, 1 * S));
  assertSame(third.options.contextBefore[0], second.left.subarray(1 * S, 3 * S));
});

function assertSame(actual, expected) {
  assert.equal(actual.length, expected.length);
  assert.equal(actual.findIndex((sample, i) => sample !== expected[i]), -1);
}

test('context bridges a tiny hole with silence and stops at a larger one', async () => {
  const S = 48000;
  const ones = (length) => [new Float32Array(length).fill(1), new Float32Array(length).fill(1)];
  const contextFor = async (holeStart, holeLength) => {
    const contexts = [];
    const capture = async (left, right, rate, options) => {
      contexts.push(options.contextBefore);
      return [left, right];
    };
    const { engine } = startEngine({ separate: capture, config: { warmUpBeforeSeconds: 2 } });
    engine.timeline.write(0, ones(holeStart));
    engine.timeline.write(holeStart + holeLength, ones(60 * S - holeStart - holeLength));
    engine.processed = [[0, 5 * S]];
    engine.setPlayhead(1, true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return contexts[0];
  };

  const [bridgedLeft, bridgedRight] = await contextFor(3 * S, 360);
  assert.equal(bridgedLeft.length, 2 * S);
  assert.equal(bridgedRight.length, 2 * S);
  assert.ok(bridgedLeft.subarray(1 * S, 1 * S + 360).every((sample) => sample === 0));
  assert.ok(bridgedLeft.subarray(0, 1 * S).every((sample) => sample === 1));
  assert.ok(bridgedLeft.subarray(1 * S + 360).every((sample) => sample === 1));

  const [cutLeft] = await contextFor(2.5 * S, 1 * S);
  assert.equal(cutLeft.length, 0.5 * S);
  assert.ok(cutLeft.every((sample) => sample === 1));
});

test('by default a window warms up on 1 s of the audio before it', async () => {
  const S = 48000;
  const contexts = [];
  const capture = async (left, right, rate, options) => {
    contexts.push(options.contextBefore[0].length);
    return [left, right];
  };
  const { engine } = startEngine({ separate: capture, config: { windowSeconds: 4 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.deepEqual(contexts.slice(0, 4), [0, 1 * S, 1 * S, 1 * S]);
});

test('warmUpBeforeSeconds of 0 passes no context', async () => {
  const contexts = [];
  const capture = async (left, right, rate, options) => {
    contexts.push(options.contextBefore[0].length);
    return [left, right];
  };
  const { engine } = startEngine({ separate: capture, config: { windowSeconds: 4, warmUpBeforeSeconds: 0 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(0, true);
  await settle(engine);
  assert.ok(contexts.length >= 3);
  assert.ok(contexts.every((length) => length === 0));
});

const starvedAt = (statuses) => statuses.filter((s) => s.stage === 'starved').map((s) => s.seconds);

test('reports starved once when the playhead jumps to audio evicted behind it, and again after a move', async () => {
  const { engine, statuses } = startEngine({ config: { keepBehindSeconds: 2 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(10, true);
  await settle(engine);
  assert.deepEqual(starvedAt(statuses), []);
  engine.setPlayhead(2, true);
  assert.deepEqual(starvedAt(statuses), [2]);
  engine.setPlayhead(2, true);
  engine.setPlayhead(2.5, true);
  engine.pump();
  assert.deepEqual(starvedAt(statuses), [2]);
  engine.setPlayhead(4, true);
  assert.deepEqual(starvedAt(statuses), [2, 4]);
});

test('a reset re-arms the starved report at the same playhead', async () => {
  const { engine, statuses } = startEngine({ config: { keepBehindSeconds: 2 } });
  engine.pushChunk(bytes);
  engine.setPlayhead(10, true);
  await settle(engine);
  engine.setPlayhead(2, true);
  engine.reset();
  engine.pushChunk(bytes.subarray(0, 4096));
  engine.setPlayhead(11, true);
  await engine.ready;
  engine.setPlayhead(11, true);
  assert.deepEqual(starvedAt(statuses), [2, 11]);
});

test('starved is not reported before any audio has been decoded', async () => {
  const firstCluster = bytes.findIndex((b, i) => b === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75);
  const { engine, statuses } = startEngine();
  engine.setPlayhead(5, true);
  engine.pushChunk(bytes.subarray(0, firstCluster));
  await engine.ready;
  engine.setPlayhead(5, true);
  assert.deepEqual(starvedAt(statuses), []);
});

test('replaying a long stream writes only the span around the playhead, then plans from the playhead', async () => {
  const S = 48000;
  const { engine, windows } = startEngine({ config: { keepBehindSeconds: 5, keepAheadSeconds: 10 } });
  engine.setPlayhead(30, false);
  engine.pushChunk(long);
  await engine.ready;
  const frame = 0.06 * S;
  assert.equal(engine.timeline.ranges.length, 1);
  const [[start, end]] = engine.timeline.ranges;
  assert.ok(start >= 25 * S - frame && start <= 25 * S, `starts at ${start / S} s`);
  assert.ok(end >= 40 * S && end <= 40 * S + frame, `ends at ${end / S} s`);
  assert.ok(engine.timeline.pages.size <= 17, `${engine.timeline.pages.size} pages`);
  engine.setPlayhead(30, true);
  await settle(engine);
  assert.ok(Math.abs(windows[0].startSeconds - 30) < 0.001);
});

test('an engine created with a playhead plans from it once bytes arrive', async () => {
  const { engine, windows } = startEngine({ playheadSeconds: 30 });
  engine.pushChunk(long);
  await settle(engine);
  assert.ok(Math.abs(windows[0].startSeconds - 30) < 0.001);
  assert.ok(engine.timeline.ranges[0][0] >= 0 && engine.timeline.ranges[0][0] < 1);
});

test('a long stream pushed in one burst plays through without starving, with contiguous windows', async () => {
  const S = 48000;
  const config = { keepBehindSeconds: 5, keepAheadSeconds: 10, lookaheadSeconds: 5, windowSeconds: 4 };
  const { engine, windows, statuses } = startEngine({ config, separate: async (left, right) => [left, right] });
  engine.setPlayhead(0, true);
  engine.pushChunk(long);
  await settle(engine);
  assert.ok(engine.timeline.ranges.at(-1)[1] <= 10.1 * S, 'decodes only up to playhead + keepAhead');
  assert.ok(engine.queuedPackets().bytes > 0, 'keeps the rest as packets');
  let maxPages = 0;
  for (let seconds = 0; seconds <= 59; seconds += 0.25) {
    engine.setPlayhead(seconds, true);
    await settle(engine);
    maxPages = Math.max(maxPages, engine.timeline.pages.size);
  }
  assert.deepEqual(starvedAt(statuses), []);
  assert.ok(maxPages <= 5 + 10 + 2, `${maxPages} pages`);
  let end = 0;
  for (const w of windows) {
    assert.ok(w.startSeconds <= end + 0.5, `gap before window at ${w.startSeconds} s, previous end ${end} s`);
    end = Math.max(end, w.startSeconds + w.left.length / S);
  }
  assert.ok(end >= 59.9, `windows end at ${end} s`);
  assert.equal(engine.queuedPackets().count, 0);
});

test('reports starved after a seek behind evicted audio even while packets wait ahead', async () => {
  const { engine, statuses } = startEngine({ config: { keepBehindSeconds: 2, keepAheadSeconds: 10 } });
  engine.setPlayhead(20, true);
  engine.pushChunk(long);
  await settle(engine);
  assert.ok(engine.queuedPackets().count > 0);
  assert.deepEqual(starvedAt(statuses), []);
  engine.setPlayhead(5, true);
  assert.deepEqual(starvedAt(statuses), [5]);
});

const longClusters = clusterOffsets(long);
const longInit = long.subarray(0, longClusters[0]);
const longClustersFrom = (first, last = longClusters.length) => long.subarray(longClusters[first], longClusters[last] ?? long.length);

function assertContiguous(windows, fromSeconds, toSeconds) {
  let end = fromSeconds;
  for (const w of windows) {
    assert.ok(w.startSeconds <= end + 0.5, `gap before window at ${w.startSeconds} s, previous end ${end} s`);
    end = Math.max(end, w.startSeconds + w.left.length / 48000);
  }
  assert.ok(end >= toSeconds, `windows end at ${end} s`);
}

async function playThrough(engine, fromSeconds, toSeconds) {
  for (let seconds = fromSeconds; seconds <= toSeconds; seconds += 0.25) {
    engine.setPlayhead(seconds, true);
    await settle(engine);
  }
}

test('packets that end before playhead minus keepBehind are dropped without decoding', async () => {
  const { engine } = startEngine({ config: { keepBehindSeconds: 2, keepAheadSeconds: 10 }, playheadSeconds: 40 });
  const decodedAt = [];
  const decodeFrame = engine.decodeFrame.bind(engine);
  engine.decodeFrame = (frame) => {
    decodedAt.push(frame.timeSeconds);
    decodeFrame(frame);
  };
  engine.pushChunk(long);
  await settle(engine);
  assert.ok(decodedAt.length > 0);
  assert.ok(Math.min(...decodedAt) >= 37.5, `decoded a frame at ${Math.min(...decodedAt)} s`);
  assert.ok(engine.timeline.ranges[0][0] <= 38 * 48000);
});

test('a segment re-appended after a backward seek is decoded even while later packets wait beyond the limit', async () => {
  const config = { keepBehindSeconds: 2, keepAheadSeconds: 10, lookaheadSeconds: 5, windowSeconds: 4 };
  const { engine, windows, statuses } = startEngine({ config, separate: async (left, right) => [left, right], playheadSeconds: 40 });
  engine.pushChunk(longInit);
  engine.pushChunk(longClustersFrom(4));
  await settle(engine);
  engine.setPlayhead(5, true);
  assert.deepEqual(starvedAt(statuses), [5]);

  const before = windows.length;
  engine.pushChunk(longInit);
  engine.pushChunk(longClustersFrom(1, 4));
  await settle(engine);
  assert.ok(windows.slice(before).some((w) => w.startSeconds >= 5 && w.startSeconds < 5.1), 'plans from the playhead');
  await playThrough(engine, 5, 18);
  assert.deepEqual(starvedAt(statuses), [5]);
  assertContiguous(windows.slice(before), 5, 18);
});

test('a replay with the re-appended segment after the later one plays without starving', async () => {
  const config = { keepBehindSeconds: 2, keepAheadSeconds: 10, lookaheadSeconds: 5, windowSeconds: 4 };
  const { engine, windows, statuses } = startEngine({ config, separate: async (left, right) => [left, right], playheadSeconds: 5 });
  engine.pushChunk(longInit);
  engine.pushChunk(longClustersFrom(4));
  engine.pushChunk(longInit);
  engine.pushChunk(longClustersFrom(1, 4));
  await settle(engine);
  assert.ok(windows[0].startSeconds >= 5 && windows[0].startSeconds < 5.1, `first window at ${windows[0]?.startSeconds} s`);
  await playThrough(engine, 5, 40);
  assert.deepEqual(starvedAt(statuses), []);
  assertContiguous(windows, 5, 40);
  assert.equal(engine.timeline.ranges.length, 1, JSON.stringify(engine.timeline.ranges));
});

test('an engine awaiting a replay reports no starvation for stale audio before the replay ends', async () => {
  const config = { keepBehindSeconds: 2, keepAheadSeconds: 10 };
  const { engine, windows, statuses } = startEngine({ config, playheadSeconds: 40, awaitingReplay: true });
  engine.pushChunk(longInit);
  engine.pushChunk(longClustersFrom(0, 5));
  await settle(engine);
  assert.deepEqual(starvedAt(statuses), []);
  engine.pushChunk(longClustersFrom(7));
  engine.endReplay();
  await settle(engine);
  assert.deepEqual(starvedAt(statuses), []);
  assert.ok(Math.abs(windows[0].startSeconds - 40) < 0.001, `first window at ${windows[0]?.startSeconds} s`);
});

test('a replay that ends with no audio near the playhead reports starved once', async () => {
  const config = { keepBehindSeconds: 2, keepAheadSeconds: 10 };
  const { engine, statuses } = startEngine({ config, playheadSeconds: 40, awaitingReplay: true });
  engine.pushChunk(longInit);
  engine.pushChunk(longClustersFrom(0, 5));
  engine.endReplay();
  await settle(engine);
  engine.setPlayhead(40, true);
  assert.deepEqual(starvedAt(statuses), [40]);
});
