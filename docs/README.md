# Docs

The design history of Music Filter, in the order it happened. Plans are the working plans each step was built from. Spikes and results record what was measured. Early docs describe DeepFilterNet3, which the extension replaced with DPDFNet on 2026-10-26.

The current state is in the README, `plans/2026-10-30-parallel-read-ahead.md` and `spikes/2026-10-26-dpdfnet-results.md`.

## Research

| Doc | Covers | Current? |
|---|---|---|
| [2026-10-19-landscape.md](research/2026-10-19-landscape.md) | Real-time music removal: models, other extensions, YouTube policy | Background. Its v2 section is replaced by the next doc. |
| [2026-10-25-keep-effects.md](research/2026-10-25-keep-effects.md) | Models that remove only music and keep sound effects | Background for a later "keep effects" mode |

## Plans

| Doc | Covers | Current? |
|---|---|---|
| [2026-10-19-music-filter-design.md](plans/2026-10-19-music-filter-design.md) | First design: filter audio as it plays, nothing downloaded | Product rules still hold. The model and mode choices changed. |
| [2026-10-19-spike-worklet-csp-realtime.md](plans/2026-10-19-spike-worklet-csp-realtime.md) | Spike: an AudioWorklet with DeepFilterNet3 on YouTube | Historical |
| [2026-10-25-read-ahead-pipeline.md](plans/2026-10-25-read-ahead-pipeline.md) | Read-ahead pipeline for Safari and Firefox for Android | Architecture still current. The model is now DPDFNet. |
| [2026-10-26-live-desktop-and-safari-fixes.md](plans/2026-10-26-live-desktop-and-safari-fixes.md) | Live mode on desktop, Safari read-ahead fixes | Historical, superseded by the DPDFNet swap |
| [2026-10-26-dpdfnet-swap.md](plans/2026-10-26-dpdfnet-swap.md) | Replace DeepFilterNet3 with DPDFNet in both modes | Current |
| [2026-10-30-parallel-read-ahead.md](plans/2026-10-30-parallel-read-ahead.md) | Read-ahead across 2 or 3 Workers, quick start, model fallback | Current |

## Spikes and results

| Doc | Covers | Current? |
|---|---|---|
| [2026-10-19-worklet-csp-results.md](spikes/2026-10-19-worklet-csp-results.md) | The AudioWorklet loads and runs on YouTube despite its CSP | Historical |
| [2026-10-25-mobile-results.md](spikes/2026-10-25-mobile-results.md) | What iPhone Safari and Firefox for Android allow | Current for browser capabilities |
| [2026-10-25-read-ahead-results.md](spikes/2026-10-25-read-ahead-results.md) | Read-ahead with DeepFilterNet3 on each platform | Historical |
| [2026-10-26-dpdfnet-results.md](spikes/2026-10-26-dpdfnet-results.md) | DPDFNet measurements on desktop, simulators and a Galaxy A56, plus open issues | Current |
| [2026-10-30-tiger-browser.md](spikes/2026-10-30-tiger-browser.md) | DBS-TIGER (keeps sound effects) is too slow and too large for the browser | Current |

## Store

[store/listing.md](store/listing.md) holds the copy for each store. [store/checklist.md](store/checklist.md) lists the release steps.
