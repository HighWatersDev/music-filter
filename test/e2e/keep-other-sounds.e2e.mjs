import assert from 'node:assert/strict';
import { snapshot, toggle, video, waitFor, withExtensionPage } from './harness.mjs';

const PORT = 8791;
const TIMEOUT_MS = 90_000;

await withExtensionPage({ port: PORT, storage: { mf_keep_other_sounds: '1', mf_fake_separator: '0' } }, async (page) => {
  await toggle(page);
  await video(page, () => document.querySelector('video').play().catch(() => {}));
  const filtered = await waitFor(page, 'filtered playback', (s) => s.panel.state === 'filtered' && !s.paused, TIMEOUT_MS);
  console.log('filtered', filtered);
  assert.ok(['true', 'false'].includes(filtered.panel.passthrough), `no passthrough state: ${JSON.stringify(filtered.panel)}`);
  await page.waitForTimeout(5000);
  const later = await snapshot(page);
  console.log('5 s later', later);
  assert.equal(later.panel.state, 'filtered', `stopped filtering: ${JSON.stringify(later.panel)}`);
  assert.ok(later.currentTime > filtered.currentTime + 3, 'playback did not advance');
  assert.match(later.panel.status, /^(Filtered|Original sound) · \d+ s ready/);
});
