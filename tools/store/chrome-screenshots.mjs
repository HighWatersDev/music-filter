import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const OUT = 'docs/store/screenshots';

const browser = await chromium.launch();
try {
  const banner = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await banner.goto(pathToFileURL(resolve('design/store-banner.html')).href);
  await banner.screenshot({ path: `${OUT}/chrome-1-overview.png` });

  const icon = readFileSync('design/icon.svg', 'utf8').replace('<svg ', '<svg width="120" height="120" ');
  const tile = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await tile.setContent(`<html><body style="margin:0;width:440px;height:280px;display:flex;align-items:center;gap:28px;
    padding:0 36px;box-sizing:border-box;background:linear-gradient(135deg,#1d5fbf,#0b2350);color:#fff;
    font-family:-apple-system,'Helvetica Neue',Arial,sans-serif">
    ${icon}<div><div style="font-size:34px;font-weight:700;line-height:1.1">Music Filter</div>
    <div style="font-size:19px;margin-top:10px;opacity:.9">Voices on, music off</div></div></body></html>`);
  await tile.screenshot({ path: `${OUT}/promo-440x280.png` });
} finally {
  await browser.close();
}
