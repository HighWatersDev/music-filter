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
    const box = document.createElement('pre');
    Object.assign(box.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      zIndex: '2147483647',
      margin: '0',
      padding: '8px',
      maxWidth: '520px',
      whiteSpace: 'pre-wrap',
      font: '12px/1.4 ui-monospace, monospace',
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#7CFC00',
      pointerEvents: 'none',
    });
    const lines = new Map();
    return {
      set(key, text) {
        lines.set(key, text);
        box.textContent = [...lines.values()].join('\n');
        if (!box.isConnected) document.documentElement.append(box);
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
    ]).then(([processorSource, wasmBytes, modelBytes]) => ({ processorSource, wasmBytes, modelBytes }));
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

  async function attach() {
    if (attached) return;
    const video = document.querySelector('video');
    if (!video) return overlay.set('status', 'no <video> on this page');

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

    context.createMediaElementSource(video).connect(node).connect(context.destination);
    node.port.onmessage = ({ data }) => {
      if (data.type === 'error') {
        console.error('[music-filter] error', JSON.stringify(data));
        overlay.set('error', `ERROR ${data.stage}: ${data.message} (passing original audio through)`);
        return;
      }
      if (data.type !== 'stats') return;
      console.log('[music-filter] stats', JSON.stringify(data));
      overlay.set(
        'stats',
        `frames=${data.count} mean=${data.meanMs.toFixed(2)}ms p95=${data.p95Ms.toFixed(2)}ms ` +
          `max=${data.maxMs.toFixed(2)}ms overQuantum=${data.overQuantum} overBudget=${data.overBudget}`,
      );
    };
    attached = { node, isBypassed: false };

    overlay.set(
      'status',
      `attached ${strategy.loader}/${strategy.compileIn} latencyHint=${latencyHint} ` +
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

  document.addEventListener(
    'keydown',
    (event) => {
      const action = event.altKey && event.shiftKey ? HOTKEYS[event.code] : undefined;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action().catch((error) => overlay.set('status', `error: ${error.message}`));
    },
    true,
  );

  overlay.set('help', 'music-filter spike: Alt+Shift+L probe, M attach, B bypass, H latency hint');
})();
