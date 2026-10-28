import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const EXTENSION = resolve('build/store/chromium');
const OUT = 'docs/store/screenshots';
// Big Buck Bunny, CC BY 3.0 Blender Foundation, so the screenshot carries no third-party rights issues.
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=60';

const profile = mkdtempSync(join(tmpdir(), 'mf-shots-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 1280, height: 800 },
  args: ['--headless=new', `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`,
    '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(VIDEO);
  const reject = page.getByRole('button', { name: /Reject all/i });
  if (await reject.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await reject.first().click();
    await page.waitForURL(/youtube\.com\/watch/);
  }
  await page.waitForSelector('[data-state]');
  await page.evaluate(() => document.querySelector('video')?.play());
  await page.getByRole('button', { name: /Music filter/ }).click();
  // YouTube enforces Trusted Types, which blocks waitForFunction, so wait on the attribute through a locator.
  await page.locator('[data-state="filtered"]').waitFor({ timeout: 60000 });
  await page.waitForTimeout(8000);
  // Theater mode pushes the recommendation thumbnails, which are other people's work, below the fold.
  await page.locator('video').hover();
  await page.keyboard.press('t');
  await page.addStyleTag({ content: '#secondary { visibility: hidden !important }' });
  await page.mouse.move(1270, 790);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/chrome-1-filtering.png` });
  console.log(await page.evaluate(() => document.querySelector('[data-state]').textContent));

  const icon = readFileSync('design/icon.svg', 'utf8').replace('<svg ', '<svg width="120" height="120" ');
  const tile = await context.newPage();
  await tile.setViewportSize({ width: 440, height: 280 });
  await tile.setContent(`<html><body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:28px;
    padding:0 36px;box-sizing:border-box;background:linear-gradient(135deg,#1d5fbf,#0b2350);color:#fff;
    font-family:-apple-system,'Helvetica Neue',Arial,sans-serif">
    ${icon}<div><div style="font-size:34px;font-weight:700;line-height:1.1">Music Filter</div>
    <div style="font-size:19px;margin-top:10px;opacity:.9">Voices on, music off</div></div></body></html>`);
  await tile.screenshot({ path: `${OUT}/promo-440x280.png` });
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
