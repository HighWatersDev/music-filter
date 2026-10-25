# Live desktop mode and Safari read-ahead fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Each task is TDD where the logic is pure.

**Goal:** Chrome, Edge and Firefox use the live per-frame DeepFilterNet3 filter from the first spike, made into a product. Safari keeps read-ahead, with the three bugs found on 2026-10-26 fixed.

**Why:** The read-ahead build sounded choppy and paused often on desktop Chrome (user listening test, 2026-10-26). The investigation (scratch notes in the session, summarised here) confirmed one cause: a false starvation replay plus a crossfade automation collision, giving 4 to 12 dB speech dips for about 30 s every minute once YouTube buffers more than 90 s ahead. The pauses were not reproduced. The live spike, which the user rated "not bad", has none of the hold, replay or scheduling machinery. Read-ahead is only required on Safari, where `createMediaElementSource` returns silence for YouTube.

**Product rules (unchanged):** while the filter is on, the original track is never audible. On failure, mute with a message. Never play the original as a fallback.

---

## Task A: Live mode on Chrome, Edge and Firefox

**Files:**
- Create: `src/content/live-filter.js`
- Modify: `src/worklet/processor.js`, `src/content/read-ahead.js` (mode switch only), `src/content/original-audio.js` (expose the routed source), `scripts/build-separator.mjs` only if a new bundle entry is needed
- Test: `test/processor-*.test.js` and `test/live-filter.test.js` where the logic is pure

**Behaviour:**
1. **Mode selection.**
   - Safari (`navigator.vendor === 'Apple Computer, Inc.'`) uses read-ahead. Everything else uses live.
   - On localhost only, `localStorage.mf_mode` (`live` or `read-ahead`) overrides this, so tests can exercise both paths in Chrome.
2. **Audio graph.**
   - Route `video → MediaElementSource → AudioWorkletNode (music-filter processor) → destination`.
   - Reuse the per-element registry in `original-audio.js`, so `createMediaElementSource` is called once per element and deferred until metadata.
   - The direct original path stays at gain 0 whenever the filter is on.
   - Turning the filter off routes the source back to the destination at gain 1.
3. **Worklet loading.**
   - Load `dist/processor.js` from the extension URL. Blob URLs are blocked on YouTube.
   - Compile `assets/df_bg.wasm` in the content script and pass the `WebAssembly.Module` plus the model bytes through `processorOptions`. This is proven on YouTube in the 2026-10-19 spike.
   - Create the node once per AudioContext and reuse it across elements.
4. **Failure is silence, never the original.**
   - Add a processor option `failMode: 'silence' | 'passthrough'`. Live mode passes `'silence'`.
   - In silence mode, init failure, a `df_process_frame` throw, NaN output and render errors all output zeros, and the processor posts `error` once.
   - The content script shows "Can't filter this video: …" and keeps everything muted.
   - The bypass message stays for the panel's compare button, if one is added later. It is not used by default.
5. **Overload.**
   - Use the processor's existing stats. If `overQuantum` exceeds 5% of frames over 5 s, show "This device is too slow to filter live" and mute.
   - Do not fall back to the original.
6. **No hold, no pause, any speed.**
   - Live mode never pauses the video.
   - It filters at every playback rate, since the element applies the rate before the graph. The 1.5x mute applies to read-ahead only.
7. **Panel.**
   - Same panel, with live states `off`, `starting`, `filtered` and `error`, and detail "live, 40 ms delay".
   - Keep the `data-state` and `data-original-level` attributes for tests.
8. **SPA and ads.** The same element keeps its source and worklet. A new element gets attached through the registry.

**Tests:**
- Processor silence mode: init failure, a throwing frame, NaN and a render throw each give zeros, never input samples.
- Passthrough mode is unchanged.
- Live-filter logic with fake nodes: no direct original path while on, restored on off.

**e2e:** add a live-mode run to `test/e2e/read-ahead.e2e.mjs`, or a sibling `live.e2e.mjs`, on `test-page/mse.html` with the real DeepFilterNet3 (it is bundled and fast). Assert:
- `filtered` within 3 s, and the video is never paused by the filter
- `originalLevel` stays `'0'`
- 1.5x keeps `filtered`
- a seek keeps `filtered`
- turning off restores `'1'`

Keep the existing read-ahead e2e running by setting `mf_mode=read-ahead`.

## Task B: Safari read-ahead fixes

**Files:** `src/content/playback-scheduler.js`, `src/pipeline/stream-engine.js`, `src/pipeline/window-planner.js`, `src/pipeline/frame-decoder.js`, and their tests. Do not edit `read-ahead.js`, which Task A owns. If B needs a content change, note it for a follow-up.

1. **Crossfade clamp** (validated in the investigation clone):
   - In `PlaybackScheduler.start()`, clamp the new source's start to `max(span.startMedia, previous.end - overlap)`, where overlap is 1 s.
   - Pass that value as `nextStart` to `crossfadeSpan`, and recompute `when`, `offset` and `duration` from it.
   - Before adding new events to the previous gain, call `cancelAndHoldAtTime` (or cancel and set the current value) so no ramp is overwritten.
   - Test with fake AudioParams that record events. Overlapping windows with 7 s overlap and windows shorter than 2 s must keep the gain sum within 0.85 to 1.15 at every sampled time.
2. **No false starvation:**
   - Stop dropping frames beyond `keepAheadSeconds`. Keep demuxed Opus packets in a FIFO (about 8 KB/s) and decode them in order as the playhead advances, so the decoded frontier stays within `playhead + keepAheadSeconds`.
   - Remove the `cutAt` starvation rule.
   - Starvation then fires only when the playhead has no decoded audio and no queued packets around it, for example after a seek behind evicted data.
   - Test: a 5-minute stream pushed in one burst with the playhead advancing in real time gives zero `starved` events and contiguous windows.
3. **Decoder continuity on re-init:**
   - If a new init segment has the same codec, channels and OpusHead as the current decoder, keep the decoder. No new configure, no pre-roll discard.
   - Only a changed codec configuration creates a new decoder.
   - Test: two concatenated WebM segments with identical Opus parameters leave no hole at the join.

**Verify:** `npm test` green and `npm run build` OK. Re-run the read-ahead e2e with `mf_mode=read-ahead`. Then re-run the iPhone simulator check (Task 14 of the read-ahead plan).

## Task C: Review and hand-over

- Code review of A and B.
- Rebuild the Safari app.
- User listening test on Chrome desktop with the live mode.
