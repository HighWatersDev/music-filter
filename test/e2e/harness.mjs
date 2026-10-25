import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION = resolve('extension');
const SERVER_START_MS = 10_000;

async function waitForServer(base) {
  const deadline = Date.now() + SERVER_START_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/mse.html`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`test server at ${base} did not start`);
}

export async function withExtensionPage({ port, storage }, run) {
  const base = `http://localhost:${port}`;
  const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', 'test-page'], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'mf-e2e-'));
  let context;
  try {
    await waitForServer(base);
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
    await page.goto(`${base}/mse.html`);
    await page.evaluate((entries) => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    }, storage);
    await page.reload();
    await page.waitForSelector('[data-state]');
    await run(page);
  } finally {
    await context?.close();
    server.kill();
    rmSync(profile, { recursive: true, force: true });
  }
}

export const snapshot = (page) =>
  page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      panel: { ...document.querySelector('[data-state]')?.dataset },
      paused: video.paused,
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
    };
  });

export async function waitFor(page, label, isDone, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    if (current.panel.state === 'error') throw new Error(`panel error: ${await page.textContent('[data-state]')}`);
    if (isDone(current)) return current;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label} never happened: ${JSON.stringify(await snapshot(page))}`);
}

export const video = (page, action) => page.evaluate(action);
export const toggle = (page) => page.getByRole('button', { name: /Music filter/ }).click();

export async function watchPanel(page) {
  await page.evaluate(() => {
    const root = document.querySelector('[data-state]');
    window.__seen = { states: [], originalLevelsWhileOn: new Set(), pauses: 0 };
    new MutationObserver(() => {
      __seen.states.push(root.dataset.state);
      if (root.dataset.state !== 'off') __seen.originalLevelsWhileOn.add(root.dataset.originalLevel);
    }).observe(root, { attributes: true });
    document.querySelector('video').addEventListener('pause', () => __seen.pauses++);
  });
  return () => page.evaluate(() => ({ ...__seen, originalLevelsWhileOn: [...__seen.originalLevelsWhileOn] }));
}
