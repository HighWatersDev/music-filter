import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StreamEngine } from '../src/pipeline/stream-engine.js';

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
  assert.ok(Math.abs(windows[0].startSeconds - 0.0065) < 0.001);
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
