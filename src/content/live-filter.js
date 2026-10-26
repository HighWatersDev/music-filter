import { createOriginalAudioRegistry } from './original-audio.js';
import { createPanel } from './panel.js';

const SAFARI_VENDOR = 'Apple Computer, Inc.';
const MODEL_LABELS = { dpdfnet4: 'DPDFNet-4', dpdfnet2: 'DPDFNet-2' };
const FALLBACK_MODEL = 'dpdfnet2';
const MODES = new Set(['live', 'read-ahead']);
const OVERLOAD_WINDOW_FRAMES = 500;
// The overload test counts frames longer than two render quanta, not one. The interactive output buffer
// holds at least two quanta, so a single frame up to that long does not underrun. On YouTube (M2 Pro,
// 2026-10-26) 5 s windows reached 5 to 10% over one quantum with no frame over budget, and the
// one-quantum rule muted the filter about 10 s in.
const OVERLOAD_MAX_RATIO = 0.05;
const OVERLOAD_TRIP_WINDOWS = 3;
const OVERLOAD_CLEAR_WINDOWS = 3;
const OUTPUT_RAMP_SECONDS = 0.03;

const PROCESSOR_PATH = 'dist/processor.js';
const WASM_PATH = 'assets/dpdf_bg.wasm';
const MODEL_PATHS = { dpdfnet4: 'assets/dpdfnet4.onnx', dpdfnet2: 'assets/dpdfnet2.onnx' };
const SAMPLE_RATE = 48000;
const READY_TIMEOUT_MS = 10000;
const TICK_MS = 250;
const TAP_CONNECT = 'music-filter:tap-connect';

export function selectFilterMode({ vendor, userAgent = '', hostname, override }) {
  if (hostname === 'localhost' && MODES.has(override)) return override;
  if (vendor === SAFARI_VENDOR) return 'read-ahead';
  if (userAgent.includes('Android') && userAgent.includes('Firefox')) return 'read-ahead';
  return 'live';
}

export function overloadAction({ model, isOverloaded }) {
  if (!isOverloaded) return 'none';
  return model === FALLBACK_MODEL ? 'too-slow' : 'switch';
}

export function liveDetail({ model, latencySamples, sampleRate, outputLatency }) {
  if (!MODEL_LABELS[model]) return 'live';
  const delayMs = Math.round((latencySamples / sampleRate) * 1000 + (outputLatency || 0) * 1000);
  return `live, ${MODEL_LABELS[model]}, ${delayMs} ms delay`;
}

export function tooSlowError(warmupMs) {
  return Object.assign(new Error('this device is too slow to filter live'), { isTooSlow: true, warmupMs });
}

export function createOverloadMonitor({
  windowFrames = OVERLOAD_WINDOW_FRAMES,
  maxRatio = OVERLOAD_MAX_RATIO,
  tripWindows = OVERLOAD_TRIP_WINDOWS,
  clearWindows = OVERLOAD_CLEAR_WINDOWS,
} = {}) {
  let frames = 0;
  let over = 0;
  let badRun = 0;
  let cleanRun = 0;
  let isOverloaded = false;
  return {
    record({ count, overTwoQuanta }) {
      frames += count;
      over += overTwoQuanta;
      if (frames < windowFrames) return isOverloaded;
      const isBad = over / frames > maxRatio;
      frames = 0;
      over = 0;
      badRun = isBad ? badRun + 1 : 0;
      cleanRun = isBad ? 0 : cleanRun + 1;
      if (badRun >= tripWindows) isOverloaded = true;
      if (cleanRun >= clearWindows) isOverloaded = false;
      return isOverloaded;
    },
    reset() {
      frames = 0;
      over = 0;
      badRun = 0;
      cleanRun = 0;
      isOverloaded = false;
    },
  };
}

const isPlaying = (video) => !video.paused && !video.ended;

export function pickFeedVideo({ main, videos }) {
  if (main && isPlaying(main)) return main;
  return videos.find(isPlaying) ?? main ?? null;
}

function createStatsSummary() {
  let totals = null;
  return {
    record(stats) {
      if (!stats.count) return;
      const previous = totals ?? {
        frames: 0,
        meanMs: 0,
        worstP95Ms: 0,
        worstMaxMs: 0,
        overQuantum: 0,
        overTwoQuanta: 0,
        overBudget: 0,
      };
      const frames = previous.frames + stats.count;
      totals = {
        frames,
        meanMs: (previous.meanMs * previous.frames + stats.meanMs * stats.count) / frames,
        worstP95Ms: Math.max(previous.worstP95Ms, stats.p95Ms),
        worstMaxMs: Math.max(previous.worstMaxMs, stats.maxMs),
        overQuantum: previous.overQuantum + (stats.overQuantum ?? 0),
        overTwoQuanta: previous.overTwoQuanta + (stats.overTwoQuanta ?? 0),
        overBudget: previous.overBudget + (stats.overBudget ?? 0),
      };
    },
    current: () => totals,
  };
}

function setLevel(gain, context, level) {
  if (gain.gain.value === level) return;
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  if (level === 0) {
    gain.gain.setValueAtTime(0, now);
    return;
  }
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(level, now + OUTPUT_RAMP_SECONDS);
}

export function createLiveFilter({ createContext, createFilterNode, onChange }) {
  const sources = new WeakMap();
  const controls = new Map();
  const fallbackMutes = createOriginalAudioRegistry({ mode: 'mute' });
  const overload = createOverloadMonitor();
  const stats = createStatsSummary();
  let context = null;
  let registry = null;
  let isEnabled = false;
  let failure = null;
  let isOverloaded = false;
  let isSwitching = false;
  let isTooSlow = false;
  let pendingFilter = null;
  let filter = null;
  let main = null;
  let feeding = null;

  function ensureGraph() {
    context ??= createContext();
    registry ??= createOriginalAudioRegistry({
      mode: 'graph',
      onRoute: (routedVideo, source) => {
        sources.set(routedVideo, source);
        sync();
      },
    });
  }

  function ensureFilter() {
    if (filter || pendingFilter) return;
    const pending = Promise.resolve()
      .then(() => createFilterNode(context, (message) => handleMessage(message, pending)))
      .then(
        ({ node, ready }) => {
          if (pending !== pendingFilter) return;
          const output = context.createGain();
          output.gain.value = 0;
          node.connect(output);
          output.connect(context.destination);
          filter = { node, output, pending, isIdle: false, engine: engineInfo(ready) };
          pendingFilter = null;
          sync();
        },
        (error) => {
          if (pending !== pendingFilter) return;
          pendingFilter = null;
          if (error?.isTooSlow) {
            isTooSlow = true;
            sync();
            return;
          }
          fail(`voice filter did not start (${error.message})`);
        },
      );
    pendingFilter = pending;
  }

  function engineInfo({ model, latencySamples, warmupMs }) {
    return { model, latencySamples, warmupMs };
  }

  function handleMessage(message, pending) {
    if (filter?.pending !== pending) return;
    if (message.type === 'error') {
      isSwitching = false;
      discardFilter();
      fail(`voice filter stopped (${message.stage}: ${message.message})`);
      return;
    }
    if (message.type === 'too-slow') {
      isSwitching = false;
      isTooSlow = true;
      discardFilter();
      sync();
      return;
    }
    if (message.type === 'model') {
      filter.engine = engineInfo(message);
      isSwitching = false;
      isOverloaded = false;
      overload.reset();
      sync();
      return;
    }
    if (message.type !== 'stats') return;
    stats.record(message);
    if (isEnabled && feeding && !isSwitching) recordLoad(message);
    sync();
  }

  function recordLoad(message) {
    const action = overloadAction({ model: filter.engine.model, isOverloaded: overload.record(message) });
    isOverloaded = action === 'too-slow';
    if (action !== 'switch') return;
    overload.reset();
    isSwitching = true;
    filter.node.port?.postMessage({ type: 'use-model', model: FALLBACK_MODEL });
  }

  function discardFilter() {
    if (!filter) return;
    feeding?.disconnect(filter.node);
    feeding = null;
    filter.output.gain.value = 0;
    filter.node.port?.postMessage({ type: 'dispose' });
    filter.node.disconnect();
    filter.output.disconnect();
    filter = null;
  }

  function fail(message) {
    failure ??= message;
    sync();
  }

  function failClosed(message, videos = []) {
    if (isEnabled) {
      for (const video of new Set([...controls.keys(), ...videos])) {
        if (video) controls.set(video, fallbackMutes.attach(video, null, { level: 0 }));
      }
    }
    fail(message);
  }

  function currentFailure() {
    if (failure) return failure;
    for (const control of controls.values()) if (control.error) return control.error;
    return null;
  }

  function setIdle(isIdle) {
    if (!filter || filter.isIdle === isIdle) return;
    filter.isIdle = isIdle;
    filter.node.port?.postMessage({ type: 'idle', value: isIdle });
  }

  function sync() {
    const video = isEnabled ? pickFeedVideo({ main, videos: [...controls.keys()] }) : null;
    const source = video ? sources.get(video) ?? null : null;
    const wanted = filter ? source : null;
    if (feeding !== wanted) {
      if (feeding && filter) feeding.disconnect(filter.node);
      if (wanted) wanted.connect(filter.node);
      feeding = wanted;
    }
    setIdle(!feeding);
    const isAudible = Boolean(feeding) && !currentFailure() && !isOverloaded && !isSwitching && !isTooSlow;
    if (filter) setLevel(filter.output, context, isAudible ? 1 : 0);
    onChange(view());
  }

  function state() {
    if (!isEnabled) return 'off';
    if (currentFailure()) return 'error';
    if (isOverloaded || isTooSlow) return 'too-slow';
    if (isSwitching) return 'starting';
    if (feeding && context?.state === 'running') return 'filtered';
    return 'starting';
  }

  function originalLevel() {
    if (!isEnabled) return 1;
    let level = 0;
    for (const control of controls.values()) level = Math.max(level, control.currentLevel());
    return level;
  }

  function view() {
    const current = state();
    const engine = filter?.engine ?? null;
    const detail = liveDetail({
      model: isSwitching ? null : engine?.model,
      latencySamples: engine?.latencySamples,
      sampleRate: context?.sampleRate,
      outputLatency: context?.outputLatency,
    });
    return {
      state: current,
      detail: current === 'error' ? currentFailure() : detail,
      model: engine?.model ?? null,
      engine,
      originalLevel: originalLevel(),
      stats: stats.current(),
    };
  }

  function attachOne(video) {
    if (!video || controls.has(video)) return;
    if (!registry) {
      controls.set(video, fallbackMutes.attach(video, null, { level: 0 }));
      return;
    }
    try {
      controls.set(video, registry.attach(video, context, { level: 0 }));
    } catch (error) {
      failClosed(`original audio could not be routed (${error.message})`, [video]);
    }
  }

  function attach(nextMain, videos = []) {
    if (!isEnabled) return;
    for (const video of [nextMain, ...videos]) attachOne(video);
    if (nextMain) main = nextMain;
    sync();
  }

  function setEnabled(on, nextMain, videos = []) {
    isEnabled = on;
    if (!on) {
      registry?.restoreAll();
      fallbackMutes.restoreAll();
      controls.clear();
      main = null;
      sync();
      return;
    }
    failure = null;
    isOverloaded = false;
    isTooSlow = false;
    overload.reset();
    try {
      ensureGraph();
    } catch (error) {
      failClosed(`audio could not start (${error.message})`, [nextMain, ...videos]);
      attach(nextMain, videos);
      return;
    }
    attach(nextMain, videos);
    ensureFilter();
    sync();
    context.resume?.().then(sync, () => {});
  }

  function enforce() {
    if (!isEnabled) return;
    registry?.enforceAll();
    fallbackMutes.enforceAll();
  }

  return {
    setEnabled,
    attach,
    enforce,
    fail,
    failClosed,
    refresh: sync,
    get isEnabled() {
      return isEnabled;
    },
    get context() {
      return context;
    },
  };
}

const addedModules = new WeakMap();
let assetsPromise;

function extensionUrl(path) {
  return chrome.runtime.getURL(path);
}

async function fetchBytes(path) {
  const response = await fetch(extensionUrl(path));
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.arrayBuffer();
}

function loadAssets() {
  assetsPromise ??= Promise.all([
    fetchBytes(WASM_PATH).then(async (bytes) => ({ bytes, module: await WebAssembly.compile(bytes) })),
    fetchBytes(MODEL_PATHS.dpdfnet4),
    fetchBytes(MODEL_PATHS.dpdfnet2),
  ]).catch((error) => {
    assetsPromise = undefined;
    throw error;
  });
  return assetsPromise;
}

function addProcessorModule(context) {
  if (!addedModules.has(context)) {
    const pending = context.audioWorklet.addModule(extensionUrl(PROCESSOR_PATH));
    pending.catch(() => addedModules.delete(context));
    addedModules.set(context, pending);
  }
  return addedModules.get(context);
}

function waitForReady(node, onMessage) {
  return new Promise((resolve, reject) => {
    let isReady = false;
    const timer = setTimeout(() => reject(new Error(`no ready message after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
    node.port.onmessage = ({ data }) => {
      if (isReady) {
        onMessage(data);
        return;
      }
      if (data.type === 'ready') {
        isReady = true;
        clearTimeout(timer);
        resolve({ node, ready: data });
      }
      if (data.type === 'too-slow') {
        clearTimeout(timer);
        node.port.postMessage({ type: 'dispose' });
        reject(tooSlowError(data.warmupMs));
      }
      if (data.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`${data.stage}: ${data.message}`));
      }
    };
    node.onprocessorerror = () => {
      clearTimeout(timer);
      if (isReady) onMessage({ type: 'error', stage: 'processor', message: 'the audio processor crashed' });
      else reject(new Error('the audio processor crashed'));
    };
  });
}

const isCloneError = (error) => error?.name === 'DataCloneError' || /clone/i.test(String(error?.message));

// Firefox 158 cannot clone a WebAssembly.Module from a content script into processorOptions. The bytes
// clone everywhere, and the processor's initSync compiles them, at the cost of a compile on the audio thread.
export function createWithWasmFallback(create, { module, bytes }) {
  try {
    return create(module);
  } catch (error) {
    if (!isCloneError(error)) throw error;
    return create(bytes);
  }
}

// Firefox content script objects are opaque to the page compartment, where the AudioWorkletNode
// constructor serializes processorOptions, so they are copied into the page first.
function toPageObject(value) {
  return typeof cloneInto === 'function' ? cloneInto(value, window) : value;
}

async function createExtensionFilterNode(context, onMessage) {
  const [[wasm, dpdfnet4, dpdfnet2]] = await Promise.all([loadAssets(), addProcessorModule(context)]);
  const node = createWithWasmFallback(
    (compiledOrBytes) =>
      new AudioWorkletNode(context, 'music-filter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
        outputChannelCount: [2],
        processorOptions: toPageObject({ wasm: compiledOrBytes, models: { dpdfnet4, dpdfnet2 }, failMode: 'silence' }),
      }),
    wasm,
  );
  return waitForReady(node, onMessage);
}

function releaseTapQueue() {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {};
  window.postMessage({ type: TAP_CONNECT }, '*', [channel.port2]);
}

function pickVideo() {
  return document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
}

const allVideos = () => [...document.querySelectorAll('video')];

function addsVideo({ addedNodes }) {
  for (const node of addedNodes) {
    if (node.nodeName === 'VIDEO' || node.getElementsByTagName?.('video').length) return true;
  }
  return false;
}

export function startLiveFilter() {
  releaseTapQueue();
  let panel;
  const filter = createLiveFilter({
    createContext: () => new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' }),
    createFilterNode: createExtensionFilterNode,
    onChange: (view) => panel?.update(view),
  });
  const tick = () => {
    if (!filter.isEnabled) return;
    try {
      filter.attach(pickVideo(), allVideos());
      filter.enforce();
      const { context } = filter;
      if (context && context.state !== 'running') context.resume().catch(() => {});
      filter.refresh();
    } catch (error) {
      filter.failClosed(`internal error: ${error.message}`, allVideos());
    }
  };
  panel = createPanel({
    mode: 'live',
    onToggle: (on) => {
      try {
        filter.setEnabled(on, pickVideo(), allVideos());
      } catch (error) {
        filter.failClosed(`internal error: ${error.message}`, allVideos());
      }
    },
  });
  new MutationObserver((mutations) => {
    if (filter.isEnabled && mutations.some(addsVideo)) tick();
  }).observe(document.documentElement, { childList: true, subtree: true });
  for (const type of ['loadedmetadata', 'play', 'playing', 'pause', 'emptied']) document.addEventListener(type, tick, true);
  setInterval(tick, TICK_MS);
}
