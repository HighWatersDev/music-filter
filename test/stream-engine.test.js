import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSerialQueue, StreamEngine } from '../src/pipeline/stream-engine.js';

const bytes = new Uint8Array(readFileSync(new URL('./fixtures/tone-12s.webm', import.meta.url)));
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

test('a re-sent init mid-stream leaves a pre-roll hole that processing continues across', async () => {
  const clusters = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) clusters.push(i);
  }
  const { engine } = startEngine();
  engine.setPlayhead(0, true);
  engine.pushChunk(bytes.subarray(0, clusters[1]));
  await settle(engine);
  engine.pushChunk(bytes.subarray(0, clusters[0]));
  engine.pushChunk(bytes.subarray(clusters[1]));
  await settle(engine);
  assert.equal(engine.timeline.ranges.length, 2);
  const [[, holeStart], [holeEnd]] = engine.timeline.ranges;
  assert.ok(holeEnd - holeStart >= 3840 && holeEnd - holeStart <= 3840 + 48);
  assert.equal(engine.processed.length, 1);
  assert.ok(engine.processed[0][1] > holeEnd + 48000);
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
  assert.ok(engine.queuedFrames.length > 0);
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

test('a backward seek drops processed ranges and decoded pages far ahead of the new playhead', async () => {
  const S = 48000;
  const config = { firstWindowSeconds: 1, windowSeconds: 2, lookaheadSeconds: 2, keepAheadSeconds: 3 };
  const { engine, windows } = startEngine({ config });
  engine.pushChunk(bytes);
  engine.setPlayhead(8, true);
  await settle(engine);
  assert.ok(engine.processed.some(([, e]) => e > 9 * S));
  const before = windows.length;
  engine.setPlayhead(1, true);
  assert.ok(engine.processed.every(([, e]) => e <= (1 + 2 + 2) * S));
  assert.ok(engine.timeline.ranges.every(([, e]) => e <= (1 + 3) * S));
  assert.ok([...engine.timeline.pages.keys()].every((index) => index < 4));
  await settle(engine);
  assert.equal(windows[before].startSeconds, 1);
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
  const { engine } = startEngine({ separate: capture, config: { windowSeconds: 4 } });
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
    const { engine } = startEngine({ separate: capture });
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
