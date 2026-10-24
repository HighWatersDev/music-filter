(() => {
  const PROCESSOR_PATH = 'dist/processor.js';
  const WASM_PATH = 'assets/df_bg.wasm';
  const MODEL_PATH = 'assets/DeepFilterNet3_onnx.tar.gz';
  const ATTEN_LIM_DB = 100;
  const READY_TIMEOUT_MS = 10000;
  const STRATEGY_KEY = 'musicFilter.strategy';
  const LATENCY_KEY = 'musicFilter.latencyHint';

  const STRATEGIES = [
    { loader: 'extension-url', compileIn: 'content-script' },
    { loader: 'extension-url', compileIn: 'worklet' },
    { loader: 'blob-url', compileIn: 'content-script' },
    { loader: 'blob-url', compileIn: 'worklet' },
  ];

  const overlay = (() => {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      bottom: '8px',
      left: '8px',
      zIndex: '2147483647',
      padding: '8px',
      maxWidth: '520px',
      font: '12px/1.4 ui-monospace, monospace',
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#7CFC00',
      borderRadius: '6px',
    });
    const buttons = document.createElement('div');
    Object.assign(buttons.style, { display: 'flex', gap: '6px', marginBottom: '6px' });
    const text = document.createElement('pre');
    Object.assign(text.style, { margin: '0', whiteSpace: 'pre-wrap', font: 'inherit' });
    panel.append(buttons, text);

    const lines = new Map();
    const mount = () => {
      if (!panel.isConnected) document.documentElement.append(panel);
    };
    return {
      set(key, value) {
        lines.set(key, value);
        text.textContent = [...lines.values()].join('\n');
        mount();
      },
      addButton(label, onClick) {
        const button = document.createElement('button');
        button.textContent = label;
        Object.assign(button.style, {
          font: 'inherit',
          padding: '4px 8px',
          cursor: 'pointer',
          background: '#1f1f1f',
          color: '#7CFC00',
          border: '1px solid #7CFC00',
          borderRadius: '4px',
        });
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          onClick();
        });
        buttons.append(button);
        mount();
      },
    };
  })();

  const cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
  });

  let assetsPromise;
  function loadAssets() {
    assetsPromise ??= Promise.all([
      fetch(chrome.runtime.getURL(PROCESSOR_PATH)).then((r) => r.text()),
      fetch(chrome.runtime.getURL(WASM_PATH)).then((r) => r.arrayBuffer()),
      fetch(chrome.runtime.getURL(MODEL_PATH)).then((r) => r.arrayBuffer()),
    ])
      .then(([processorSource, wasmBytes, modelBytes]) => ({ processorSource, wasmBytes, modelBytes }))
      .catch((error) => {
        assetsPromise = undefined;
        throw error;
      });
    return assetsPromise;
  }

  function moduleUrl(loader, processorSource) {
    if (loader === 'extension-url') return chrome.runtime.getURL(PROCESSOR_PATH);
    return URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
  }

  function waitForReady(node) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready message after ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
      node.port.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          clearTimeout(timer);
          resolve(data);
        }
        if (data.type === 'error') {
          clearTimeout(timer);
          reject(new Error(`${data.stage}: ${data.message}`));
        }
      };
      node.onprocessorerror = () => {
        clearTimeout(timer);
        reject(new Error('processorerror event'));
      };
    });
  }

  async function createFilterNode(context, strategy) {
    const assets = await loadAssets();
    await context.audioWorklet.addModule(moduleUrl(strategy.loader, assets.processorSource));
    const wasm =
      strategy.compileIn === 'content-script' ? await WebAssembly.compile(assets.wasmBytes) : assets.wasmBytes;
    const node = new AudioWorkletNode(context, 'music-filter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      outputChannelCount: [2],
      processorOptions: { wasm, modelBytes: assets.modelBytes, attenLimDb: ATTEN_LIM_DB },
    });
    const ready = await waitForReady(node);
    return { node, ready };
  }

  async function probe() {
    const rows = [];
    for (const strategy of STRATEGIES) {
      const violationsBefore = cspViolations.length;
      const context = new AudioContext({ sampleRate: 48000 });
      const startedAt = performance.now();
      try {
        await context.resume();
        const { ready } = await createFilterNode(context, strategy);
        rows.push({ ...strategy, ok: true, initMs: Math.round(performance.now() - startedAt), ...ready });
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        rows.push({ ...strategy, ok: false, error: error.message, csp: cspViolations.slice(violationsBefore) });
      } finally {
        await context.close();
      }
    }

    console.table(rows);
    console.log('[music-filter] probe', JSON.stringify(rows));
    overlay.set(
      'probe',
      rows
        .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.loader} / ${r.compileIn}${r.ok ? ` ${r.initMs}ms` : ` ${r.error}`}`)
        .join('\n'),
    );

    const passing = rows.find((r) => r.ok);
    if (passing) {
      sessionStorage.setItem(STRATEGY_KEY, JSON.stringify({ loader: passing.loader, compileIn: passing.compileIn }));
    }
    return passing;
  }

  let attached;
  let attaching;

  function pickVideo() {
    const mainPlayer = document.querySelector('#movie_player video.html5-main-video');
    if (mainPlayer) return { video: mainPlayer, source: 'main-player' };
    const firstOnPage = document.querySelector('video');
    return firstOnPage ? { video: firstOnPage, source: 'first-on-page' } : undefined;
  }

  function attach() {
    if (attached) return Promise.resolve();
    attaching ??= attachVideo().finally(() => {
      attaching = undefined;
    });
    return attaching;
  }

  function formatTotals(totals) {
    return (
      `totals frames=${totals.frames} overQuantum=${totals.overQuantum} (${totals.overQuantumPct.toFixed(2)}%) ` +
      `overBudget=${totals.overBudget} worstP95=${totals.worstP95Ms.toFixed(2)}ms ` +
      `worstMax=${totals.worstMaxMs.toFixed(2)}ms output=${totals.outputLatencyMs.toFixed(1)}ms`
    );
  }

  async function attachVideo() {
    const picked = pickVideo();
    if (!picked) return overlay.set('status', 'no <video> on this page');
    const { video, source } = picked;

    const strategy = JSON.parse(sessionStorage.getItem(STRATEGY_KEY) ?? 'null') ?? (await probe());
    if (!strategy) return overlay.set('status', 'no working strategy, video left untouched');

    const latencyHint = sessionStorage.getItem(LATENCY_KEY) ?? 'interactive';
    const context = new AudioContext({ sampleRate: 48000, latencyHint });
    await context.resume();

    let node;
    let ready;
    try {
      ({ node, ready } = await createFilterNode(context, strategy));
    } catch (error) {
      await context.close();
      return overlay.set('status', `attach failed, video left untouched: ${error.message}`);
    }

    try {
      context.createMediaElementSource(video).connect(node).connect(context.destination);
    } catch (error) {
      await context.close();
      return overlay.set('status', `attach failed at createMediaElementSource (video=${source}): ${error.message}`);
    }

    const totals = { frames: 0, overQuantum: 0, overBudget: 0, worstP95Ms: 0, worstMaxMs: 0 };
    node.port.onmessage = ({ data }) => {
      if (data.type === 'error') {
        console.error('[music-filter] error', JSON.stringify(data));
        overlay.set('error', `ERROR ${data.stage}: ${data.message} (passing original audio through)`);
        overlay.set('bypass', 'FAILED, original audio');
        return;
      }
      if (data.type !== 'stats') return;
      if (!video.isConnected) overlay.set('error', 'video element replaced, reload the tab to filter again');

      console.log('[music-filter] stats', JSON.stringify(data));
      overlay.set(
        'stats',
        `frames=${data.count} mean=${data.meanMs.toFixed(2)}ms p95=${data.p95Ms.toFixed(2)}ms ` +
          `max=${data.maxMs.toFixed(2)}ms overQuantum=${data.overQuantum} overBudget=${data.overBudget}`,
      );

      if (!video.paused && !video.ended) {
        totals.frames += data.count;
        totals.overQuantum += data.overQuantum;
        totals.overBudget += data.overBudget;
        totals.worstP95Ms = Math.max(totals.worstP95Ms, data.p95Ms);
        totals.worstMaxMs = Math.max(totals.worstMaxMs, data.maxMs);
      }
      const summary = {
        ...totals,
        overQuantumPct: totals.frames ? (100 * totals.overQuantum) / totals.frames : 0,
        outputLatencyMs: context.outputLatency * 1000,
      };
      console.log('[music-filter] totals', JSON.stringify(summary));
      overlay.set('totals', formatTotals(summary));
    };
    video.addEventListener('play', () => context.resume());
    attached = { node, video, isBypassed: false };

    overlay.set(
      'status',
      `attached ${strategy.loader}/${strategy.compileIn} video=${source} latencyHint=${latencyHint} ` +
        `base=${(context.baseLatency * 1000).toFixed(1)}ms output=${(context.outputLatency * 1000).toFixed(1)}ms ` +
        `frame=${ready.frameLength} clock=${ready.clock}`,
    );
  }

  async function toggleBypass() {
    if (!attached) return;
    attached.isBypassed = !attached.isBypassed;
    attached.node.port.postMessage({ type: 'bypass', value: attached.isBypassed });
    overlay.set('bypass', attached.isBypassed ? 'BYPASS (original audio)' : 'FILTERING');
  }

  async function toggleLatencyHint() {
    const current = sessionStorage.getItem(LATENCY_KEY) ?? 'interactive';
    sessionStorage.setItem(LATENCY_KEY, current === 'interactive' ? 'playback' : 'interactive');
    location.reload();
  }

  const HOTKEYS = { KeyL: probe, KeyM: attach, KeyB: toggleBypass, KeyH: toggleLatencyHint };
  const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

  function isEditableTarget(event) {
    const target = event.composedPath()[0];
    return Boolean(target?.isContentEditable) || EDITABLE_TAGS.has(target?.tagName);
  }

  const run = (action) => action().catch((error) => overlay.set('status', `error: ${error.message}`));

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.repeat || isEditableTarget(event)) return;
      const action = event.altKey && event.shiftKey ? HOTKEYS[event.code] : undefined;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      run(action);
    },
    true,
  );

  overlay.addButton('Probe', () => run(probe));
  overlay.addButton('Attach', () => run(attach));
  overlay.addButton('Bypass', () => run(toggleBypass));
  overlay.addButton('Latency', () => run(toggleLatencyHint));
  overlay.set(
    'help',
    `music-filter spike. Play the video, then click Attach. Latency hint: ${sessionStorage.getItem(LATENCY_KEY) ?? 'interactive'}`,
  );
})();
