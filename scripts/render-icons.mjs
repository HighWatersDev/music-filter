import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync('design/icon.svg', 'utf8');
const fullBleed = svg.replace('rx="224"', 'rx="0"');
// macOS icons carry their own shape inside a 1024 canvas with transparent padding around an 824 body.
const macBody = svg.replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 1224 1224">');

const targets = [
  ...[16, 32, 48, 96, 128].map((size) => ({ source: svg, size, out: `extension/icons/icon-${size}.png` })),
  { source: fullBleed, size: 1024, out: 'design/out/app-icon-ios-1024.png', opaque: true },
  ...[16, 32, 64, 128, 256, 512, 1024].map((size) => ({ source: macBody, size, out: `design/out/app-icon-mac-${size}.png` })),
];

mkdirSync('extension/icons', { recursive: true });
mkdirSync('design/out', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const { source, size, out, opaque } of targets) {
  await page.setViewportSize({ width: size, height: size });
  const sized = source.replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setContent(`<html><body style="margin:0;background:${opaque ? '#0b2350' : 'transparent'}">${sized}</body></html>`);
  await page.screenshot({ path: out, omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log(`rendered ${targets.length} icons`);
