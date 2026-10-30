# Parallel read-ahead windows

**Goal:** filter read-ahead windows in 2 or 3 Workers at once, so phones keep up with room to spare and can run DPDFNet-4.

**Why:** on a Galaxy A56 (Firefox 159), one Worker filters 10 s in 6.4 to 6.6 s with DPDFNet-2 (RTF about 0.6), which leaves 35% headroom. The phone has 8 cores and the filter uses one. Results: `docs/spikes/2026-10-26-dpdfnet-results.md`.

## Design

```
separator frame
 ├─ coordinator Worker (separator-worker.js): demux, Opus decode, StreamEngine, model choice
 └─ N filter Workers (filter-worker.js): DPDFNet only
       coordinator ⇄ filter Workers over MessagePorts the frame hands over
```

- **Pool size:** `min(3, max(1, floor(hardwareConcurrency / 2)))`. That gives 3 on 6 or more cores, 2 on 4 and 1 on 2 or fewer. Safari is capped at 2 until memory is measured on an iPhone. Each Worker holds about 50 MB of wasm memory.
- **Engine:** `maxInFlight` windows at once. Planning treats in-flight windows as already processed, so the next window starts after them. Each window is emitted when it finishes. The scheduler already sorts windows, and the hold policy covers any gap. A reset still discards everything in flight through `generation`.
- **Task pool:** `createTaskPool(limit)` runs at most `limit` tasks at once and queues the rest. `createSerialQueue` becomes a pool of 1. The coordinator uses a pool of N, so a replaced engine's leftover windows still take a slot and the Workers are never oversubscribed.
- **Ramped windows** (planner option `ramp`): a continuing window is `min(window, max(firstWindow, 2 × run length))` long, where the run is the processed audio, in-flight windows included, that ends at the processed end. After a start or seek the windows run 2, 4, 10 s, so the second hold shrinks. In steady play the run is at least `keepBehind` long, so a dip in runway keeps 10 s windows. Basing it on the runway made windows shrink as a slow device fell behind, which made it fall further behind.
- **Model choice moves to the coordinator:**
  - `createModelPolicy({ workers })` judges the first warm window of at least 5 s. A Worker's first call after loading a model is cold and is skipped.
  - The old rule judged the first 2 s window, which includes cold start. That is why the A56 always fell to DPDFNet-2.
  - It switches to DPDFNet-2 when `rtf / workers > 0.6`, or when one window runs slower than real time (`rtf > 1`). The second rule exists because holds after a seek depend on how long one window takes, not on throughput.
  - Every filter request carries the model. A filter Worker loads it on first use and frees the other one.
- **Filter Worker:** `createReadAheadFilters` keeps one wasm instance and an engine per model, plus the drop-on-trap behaviour. It no longer judges or times anything. The Worker measures `computeMs` around each call and returns it.

## Tasks (test first where the logic is pure)

1. `createTaskPool`: limit, queueing, a rejection frees its slot.
2. Engine `maxInFlight`: N windows dispatched at once with the right overlaps, out-of-order completion, reset discards all, idle and starved semantics unchanged, and a 60 s play-through stays contiguous with no starvation.
3. Planner `ramp`: 2, 4, 10 sequence, steady 10 s, ramp again after a seek.
4. `createModelPolicy` and the reshaped `createReadAheadFilters`. Move the existing judge tests over.
5. `filter-worker.js` entry, coordinator `separate` over ports, frame creates the pool. Build entry, manifest web-accessible resource, `package.mjs` required files.
6. Unit tests, build, both e2e suites.
7. Review, package 1.0.1, re-measure on the A56: windows per minute, model chosen, holds, time to first filtered audio, temperature.

## Review fixes (2026-10-30)

- Starvation is checked whenever nothing can be planned, against processed plus in-flight audio. It no longer waits for unrelated windows to finish.
- A reset engine's queued windows return without running.
- The port pool times out a request after 60 s and retires that Worker, handles `messageerror`, and undoes its bookkeeping if `postMessage` throws.
- The filter Worker runs one window at a time and always replies.
- A model being preloaded is not freed by a window of the other model.
- The frame terminates its Workers if starting one fails.

## Quick start and fallback (1.0.3)

On the A56, 3 Workers kept DPDFNet-4, but one window under contention ran at about 0.9 of real time, so holds after a start or seek did not shrink.

- **Quick start:** windows that start in the first 10 s of a processed run use DPDFNet-2. Later windows use the chosen model, DPDFNet-4 by default. Each filter Worker keeps both models built, so switching costs nothing.
- **Fallback on real holds:** the engine reports `behind` once per stream when the playhead comes within 0.5 s of the filtered end, at least 20 s into a run, while YouTube has decoded audio at least 1 s further. The coordinator then moves every window to DPDFNet-2 for good.

## Out of scope

- SharedArrayBuffer threads in wasm, which need cross-origin isolation.
- Sharing one compiled `WebAssembly.Module` across Workers.
