import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const EXTENSION = resolve('extension');
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const useRealModel = process.argv.includes('--real-model');
const TIMEOUT_MS = useRealModel ? 60_000 : 20_000;
const SERVER_START_MS = 10_000;

async function waitForServer() {
  const deadline = Date.now() + SERVER_START_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/mse.html`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`test server on port ${PORT} did not start`);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'test-page'], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mf-e2e-'));
let context;

const snapshot = (page) =>
  page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      panel: { ...document.querySelector('[data-state]')?.dataset },
      paused: video.paused,
      currentTime: video.currentTime,
    };
  });
const waitFor = async (page, label, isDone) => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    if (current.panel.state === 'error') throw new Error(`panel error: ${await page.textContent('[data-state]')}`);
    if (isDone(current)) return current;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label} never happened: ${JSON.stringify(await snapshot(page))}`);
};
const video = (page, action) => page.evaluate(action);
const toggle = (page) => page.getByRole('button', { name: /Music filter/ }).click();

try {
  await waitForServer();
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/mse.html`);
  await page.evaluate((fake) => localStorage.setItem('mf_fake_separator', fake ? '1' : '0'), !useRealModel);
  await page.reload();
  await page.waitForSelector('[data-state]');
  await page.evaluate(() => {
    const root = document.querySelector('[data-state]');
    window.__seen = { states: [], originalLevelsWhileOn: new Set(), pauses: 0 };
    new MutationObserver(() => {
      __seen.states.push(root.dataset.state);
      if (root.dataset.state !== 'off') __seen.originalLevelsWhileOn.add(root.dataset.originalLevel);
    }).observe(root, { attributes: true });
    document.querySelector('video').addEventListener('pause', () => __seen.pauses++);
  });
  const seen = () => page.evaluate(() => ({ ...__seen, originalLevelsWhileOn: [...__seen.originalLevelsWhileOn] }));

  const startedAt = Date.now();
  await toggle(page);
  await video(page, () => document.querySelector('video').play().catch(() => {}));
  const filtered = await waitFor(page, 'filtered playback', (s) => s.panel.state === 'filtered' && !s.paused);
  console.log(`filtered after ${Date.now() - startedAt} ms`, filtered);
  await page.waitForTimeout(1000);
  const playing = await snapshot(page);
  assert.ok(playing.currentTime > filtered.currentTime + 0.5, `playback did not advance: ${JSON.stringify(playing)}`);
  assert.equal(playing.panel.state, 'filtered');

  const before = await seen();
  const seekedAt = Date.now();
  await video(page, () => (document.querySelector('video').currentTime = 40));
  const resumed = await waitFor(
    page,
    'resume after seek',
    (s) => s.currentTime >= 40 && s.panel.state === 'filtered' && !s.paused,
  );
  const afterSeek = await seen();
  const heldStates = afterSeek.states.slice(before.states.length);
  assert.ok(afterSeek.pauses > before.pauses || heldStates.includes('filtering'), 'the filter did not hold the video');
  console.log(`held then resumed ${Date.now() - seekedAt} ms after seek`, resumed, heldStates);

  await video(page, () => (document.querySelector('video').playbackRate = 1.5));
  const muted = await waitFor(page, 'muted at 1.5x', (s) => s.panel.state === 'muted' && !s.paused);
  console.log('muted at 1.5x', muted);
  await video(page, () => (document.querySelector('video').playbackRate = 1));
  await waitFor(page, 'filtered at 1x', (s) => s.panel.state === 'filtered' && !s.paused);

  await video(page, () => document.querySelector('video').pause());
  await page.waitForTimeout(1500);
  const userPaused = await snapshot(page);
  assert.equal(userPaused.paused, true, 'a user pause was resumed');
  assert.notEqual(userPaused.panel.state, 'filtering');

  await toggle(page);
  const off = await snapshot(page);
  assert.equal(off.panel.state, 'off');
  assert.equal(off.panel.originalLevel, '1');
  assert.deepEqual((await seen()).originalLevelsWhileOn, ['0']);
  console.log('PASS');
} finally {
  await context?.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}
