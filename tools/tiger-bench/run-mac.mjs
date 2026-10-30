import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

// Uses only browsers already in the Playwright cache. Never runs `playwright install`.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: 'string', default: 'chromium' },
    executable: { type: 'string' },
    port: { type: 'string', default: '8791' },
    results: { type: 'string', default: 'results.jsonl' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '1800' },
  },
});
if (positionals.length === 0) {
  console.error('usage: node run-mac.mjs [--browser chromium|firefox] [--executable path] "<query>" ...');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReport(id, deadline) {
  while (Date.now() < deadline) {
    const lines = (existsSync(values.results) ? readFileSync(values.results, 'utf8') : '').split('\n').filter(Boolean);
    const hit = lines.map((l) => JSON.parse(l)).find((r) => r.id === id);
    if (hit) return hit;
    await sleep(2000);
  }
  throw new Error(`no report for ${id}`);
}

for (const query of positionals) {
  const id = `${values.browser}-${Date.now()}`;
  const url = `http://localhost:${values.port}/index.html?${query}&id=${id}`;
  const deadline = Date.now() + Number(values.timeout) * 1000;
  console.log(url);
  if (values.browser === 'chromium') {
    const browser = await chromium.launch({
      headless: !values.headed,
      executablePath: values.executable,
      args: ['--enable-unsafe-webgpu', '--enable-features=WebGPU', '--ignore-gpu-blocklist'],
    });
    try {
      const page = await browser.newPage();
      page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
      await page.goto(url);
      console.log(JSON.stringify(await waitForReport(id, deadline)));
    } catch (error) {
      console.log(`failed: ${error.message}`);
    } finally {
      await browser.close();
    }
  } else {
    // Playwright 1.49 cannot drive this Firefox build, so start it directly with a throwaway profile.
    const profile = mkdtempSync(join(tmpdir(), 'tiger-ff-'));
    const child = spawn(values.executable, ['-no-remote', '-profile', profile, ...(values.headed ? [] : ['-headless']), url], { stdio: 'ignore' });
    try {
      console.log(JSON.stringify(await waitForReport(id, deadline)));
    } catch (error) {
      console.log(`failed: ${error.message}`);
    } finally {
      child.kill('SIGTERM');
      await sleep(1000);
      rmSync(profile, { recursive: true, force: true });
    }
  }
}
