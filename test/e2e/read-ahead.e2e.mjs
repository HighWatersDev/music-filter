import assert from 'node:assert/strict';
import { snapshot, toggle, video, waitFor as waitForState, watchPanel, withExtensionPage } from './harness.mjs';

const PORT = 8790;
const useRealModel = process.argv.includes('--real-model');
const TIMEOUT_MS = useRealModel ? 60_000 : 20_000;
const waitFor = (page, label, isDone, timeoutMs = TIMEOUT_MS) => waitForState(page, label, isDone, timeoutMs);

await withExtensionPage(
  { port: PORT, storage: { mf_mode: 'read-ahead', mf_fake_separator: useRealModel ? '0' : '1' } },
  async (page) => {
    const seen = await watchPanel(page);

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

    await waitFor(page, 'playback past 45 s', (s) => s.currentTime >= 45);
    const rewoundAt = Date.now();
    await video(page, () => (document.querySelector('video').currentTime = 5));
    const rewound = await waitFor(
      page,
      'resume after a seek back past the keep-behind',
      (s) => s.currentTime >= 5 && s.currentTime < 30 && s.panel.state === 'filtered' && !s.paused,
      useRealModel ? TIMEOUT_MS : 10_000,
    );
    console.log(`resumed ${Date.now() - rewoundAt} ms after seeking back to 5 s`, rewound);

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
  },
);
