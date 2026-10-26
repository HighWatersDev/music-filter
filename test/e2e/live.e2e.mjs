import assert from 'node:assert/strict';
import { snapshot, toggle, video, waitFor, watchPanel, withExtensionPage } from './harness.mjs';

const PORT = 8791;
const FILTERED_WITHIN_MS = 3000;
const STEP_TIMEOUT_MS = 5000;

const LIVE_MODELS = { dpdfnet4: 'DPDFNet-4', dpdfnet2: 'DPDFNet-2' };
const stats = (s) => JSON.parse(s.panel.stats ?? 'null');
const engine = (s) => JSON.parse(s.panel.engine ?? 'null');

await withExtensionPage({ port: PORT, storage: { mf_mode: 'live' } }, async (page) => {
  const seen = await watchPanel(page);

  const startedAt = Date.now();
  await toggle(page);
  await video(page, () => document.querySelector('video').play().catch(() => {}));
  const filtered = await waitFor(
    page,
    'filtered playback',
    (s) => s.panel.state === 'filtered' && !s.paused,
    FILTERED_WITHIN_MS,
  );
  console.log(`filtered after ${Date.now() - startedAt} ms`, filtered.panel);
  assert.equal(filtered.panel.originalLevel, '0');
  const { model } = filtered.panel;
  assert.ok(model in LIVE_MODELS, `unexpected model ${model}`);
  assert.equal(engine(filtered).model, model);
  assert.ok(engine(filtered).warmupMs[model] > 0, `no warm-up time for ${model}: ${filtered.panel.engine}`);
  assert.match(await page.textContent('[data-state]'), new RegExp(`Filtered · live, ${LIVE_MODELS[model]}, \\d+ ms delay`));

  await page.waitForTimeout(2000);
  const playing = await snapshot(page);
  assert.ok(playing.currentTime > filtered.currentTime + 1.5, `playback did not advance: ${JSON.stringify(playing)}`);
  assert.equal(playing.panel.state, 'filtered');
  assert.equal(playing.panel.model, model);
  assert.equal(playing.panel.originalLevel, '0');
  assert.ok(stats(playing)?.frames > 0, `the worklet reported no frames: ${playing.panel.stats}`);

  await video(page, () => (document.querySelector('video').playbackRate = 1.5));
  await page.waitForTimeout(1500);
  const fast = await snapshot(page);
  assert.equal(fast.panel.state, 'filtered', 'filtering stopped at 1.5x');
  assert.equal(fast.paused, false);
  await video(page, () => (document.querySelector('video').playbackRate = 1));

  const beforeSeek = await seen();
  await video(page, () => (document.querySelector('video').currentTime = 40));
  const resumed = await waitFor(
    page,
    'playback after seek',
    (s) => s.currentTime >= 40.5 && s.panel.state === 'filtered' && !s.paused,
    STEP_TIMEOUT_MS,
  );
  const afterSeek = await seen();
  assert.deepEqual(
    [...new Set(afterSeek.states.slice(beforeSeek.states.length))],
    ['filtered'],
    'the panel left filtered during the seek',
  );
  console.log('filtered after seek', resumed.panel);

  const final = await seen();
  assert.equal(final.pauses, 0, 'the filter paused the video');
  assert.ok(!final.states.includes('error') && !final.states.includes('too-slow'), JSON.stringify(final.states));
  assert.deepEqual(final.originalLevelsWhileOn, ['0']);
  console.log('worklet stats', (await snapshot(page)).panel.stats);

  await toggle(page);
  const off = await snapshot(page);
  assert.equal(off.panel.state, 'off');
  assert.equal(off.panel.originalLevel, '1');
  assert.equal(off.paused, false);
  console.log('PASS');
});
