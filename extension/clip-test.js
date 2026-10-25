(() => {
  const RECORDER_PATH = 'clip-recorder.js';
  const SEPARATOR_PAGE = 'separator.html';
  const SAMPLE_RATE = 44100;
  const RAMP_SECONDS = 0.02;
  const MIN_CLIP_SECONDS = 2;
  const SEPARATOR_TIMEOUT_MS = 20000;
  const SEEK_TIMEOUT_MS = 10000;
  const SILENCE_PEAK = 1e-4;
  const MAX_PROCESSED_GAIN = 4;
  const SOURCE_CHANGE_EVENTS = ['emptied', 'loadstart', 'durationchange'];
  // Debug override for the headless harness only: ?mf_clip_seconds=10
  const clipOverride = Number(new URLSearchParams(location.search).get('mf_clip_seconds'));
  const CLIP_SECONDS = clipOverride > 0 && clipOverride <= 30 ? clipOverride : 30;

  const MODELS = {
    mrx: { label: 'MRX', device: 'wasm', timeout: { minMs: 120000, msPerClipSecond: 20000 } },
    tiger: { label: 'TIGER', device: 'webgpu', timeout: { minMs: 600000, msPerClipSecond: 30000 } },
  };
  const MODES = { original: 'Original', removed: 'Music removed' };

  let state = 'idle';
  let mode = 'removed';
  let graph;
  let separator;
  let result;
  let playback;
  let cancelProcessing;
  let activeTest;
  let runningModel;
  let nextJobId = 1;
  const jobs = new Map();

  const ui = (() => {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      top: '64px',
      left: '8px',
      zIndex: '2147483647',
      padding: '8px',
      maxWidth: '440px',
      font: '12px/1.4 ui-monospace, monospace',
      background: 'rgba(10, 20, 50, 0.9)',
      color: '#9fd3ff',
      borderRadius: '6px',
      pointerEvents: 'auto',
    });
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' });
    const text = document.createElement('pre');
    Object.assign(text.style, { margin: '0', whiteSpace: 'pre-wrap', font: 'inherit' });
    panel.append(row, text);
    panel.addEventListener('keydown', (event) => event.stopPropagation());

    const lines = new Map();
    const buttons = {};
    const mount = () => {
      if (!panel.isConnected) document.documentElement.append(panel);
    };
    return {
      panel,
      buttons,
      line(key, value) {
        if (value === undefined) lines.delete(key);
        else lines.set(key, value);
        text.textContent = [...lines.values()].join('\n');
        mount();
      },
      button(key, label, onClick) {
        const button = document.createElement('button');
        button.textContent = label;
        Object.assign(button.style, {
          font: 'inherit',
          padding: '4px 8px',
          cursor: 'pointer',
          background: '#13213f',
          color: '#9fd3ff',
          border: '1px solid #9fd3ff',
          borderRadius: '4px',
        });
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          onClick();
        });
        buttons[key] = button;
        row.append(button);
        mount();
      },
    };
  })();

  const log = (event, detail = {}) => console.log('[clip-test]', JSON.stringify({ event, ...detail }));
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

  function render() {
    const isBusy = state === 'recording' || state === 'processing';
    if (!isBusy) runningModel = undefined;
    for (const key of Object.keys(MODELS)) {
      const isRunning = key === runningModel;
      ui.buttons[key].disabled = isBusy;
      ui.buttons[key].style.fontWeight = isRunning ? 'bold' : 'normal';
      ui.buttons[key].textContent = isRunning
        ? `● ${MODELS[key].label}: ${state}…`
        : `Test ${CLIP_SECONDS} s: ${MODELS[key].label}`;
    }
    ui.buttons.original.disabled = !result;
    ui.buttons.removed.disabled = !result;
    ui.buttons.replay.disabled = !result || isBusy;
    ui.buttons.cancel.style.display = state === 'processing' ? '' : 'none';
    for (const [key, label] of Object.entries(MODES)) {
      ui.buttons[key].style.fontWeight = key === mode ? 'bold' : 'normal';
      ui.buttons[key].textContent = key === mode ? `[${label}]` : label;
    }
    for (const [key, button] of Object.entries(ui.buttons)) {
      button.style.opacity = button.disabled && key !== runningModel ? '0.5' : '1';
    }
    ui.panel.dataset.state = state;
    ui.panel.dataset.mode = mode;
    if (graph) {
      ui.panel.dataset.originalGain = graph.originalGain.gain.value.toFixed(2);
      // Chrome stops computing a GainNode's automation while it has no input, so its value would read stale.
      ui.panel.dataset.processedGainTarget = String(graph.processedGainTarget);
    }
  }

  function setState(next) {
    state = next;
    render();
  }

  function pickVideo() {
    return document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
  }

  const WASM_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
  const TAP_SECONDS = 3;

  function describeSource(video) {
    const src = video.currentSrc || video.src || '';
    if (video.srcObject) return 'srcObject';
    if (!src) return 'none';
    if (src.startsWith('blob:')) return 'blob (MSE/ManagedMediaSource)';
    return `${src.split(':')[0]}${/\.m3u8|manifest|hls/i.test(src) ? ' (native HLS)' : ''}`;
  }

  async function measureTap(video) {
    await ensureGraph(video);
    await graph.context.resume();
    if (video.paused) await video.play();
    const analyser = new AnalyserNode(graph.context, { fftSize: 2048 });
    graph.source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    const endAt = performance.now() + TAP_SECONDS * 1000;
    while (performance.now() < endAt) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    }
    graph.source.disconnect(analyser);
    return peak;
  }

  function requestTapReport() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }, 1500);
      function onMessage(event) {
        if (event.source !== window || event.data?.type !== 'mf-mse-tap-report') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(event.data);
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ type: 'mf-mse-tap-request' }, '*');
    });
  }

  async function describeAudioDecoder() {
    if (typeof AudioDecoder !== 'function') return 'WebCodecs AudioDecoder: missing';
    try {
      const { supported } = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
      return `WebCodecs AudioDecoder opus: ${supported ? 'supported' : 'unsupported'}`;
    } catch (error) {
      return `WebCodecs AudioDecoder opus: error ${error?.message ?? error}`;
    }
  }

  async function describeTap() {
    const report = await requestTapReport();
    if (!report) return ['MSE tap: not installed (MAIN-world script did not run)'];
    const lines = [
      `MSE tap: hooks=${report.installed.join(',') || 'none'} audioMime=${report.audioMime ?? 'none'}`,
      `MSE tap: audio appends=${report.audioAppends} bytes=${report.audioBytes} video appends=${report.videoAppends}`,
    ];
    lines.push(await describeAudioDecoder());
    if (!report.stream?.byteLength) return [...lines, 'MSE decode: no audio segments captured yet'];
    const joined = report.stream;
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(joined.buffer);
      let peak = 0;
      for (let c = 0; c < decoded.numberOfChannels; c++) {
        for (const sample of decoded.getChannelData(c)) peak = Math.max(peak, Math.abs(sample));
      }
      lines.push(`MSE decode (${(joined.byteLength / 1024).toFixed(0)} KB stream): OK ${decoded.duration.toFixed(2)} s ${decoded.numberOfChannels} ch ${decoded.sampleRate} Hz peak=${peak.toFixed(4)}`);
    } catch (error) {
      lines.push(`MSE decode (${(joined.byteLength / 1024).toFixed(0)} KB stream): FAILED ${error?.name ?? ''} ${error?.message ?? error}`);
    } finally {
      await context.close();
    }
    return lines;
  }

  async function diagnose() {
    const lines = [
      `UA: ${navigator.userAgent}`,
      `MediaSource=${'MediaSource' in window} ManagedMediaSource=${'ManagedMediaSource' in window}`,
      `AudioWorklet=${typeof AudioWorkletNode === 'function'} WebGPU=${'gpu' in navigator} wasmSIMD=${WebAssembly.validate(WASM_SIMD_PROBE)} isolated=${self.crossOriginIsolated}`,
    ];
    lines.push(...(await describeTap()));
    const video = pickVideo();
    if (!video) lines.push('video: none found');
    ui.line('diag', lines.join('\n'));
    if (!video) return;

    lines.push(`video: src=${describeSource(video)} paused=${video.paused} muted=${video.muted} volume=${video.volume}`);
    ui.line('diag', [...lines, `audio tap: measuring ${TAP_SECONDS} s…`].join('\n'));
    const peak = await measureTap(video);
    lines.push(
      `audio tap: ${peak > 1e-4 ? 'SIGNAL' : 'SILENCE'} peak=${peak.toFixed(4)} context=${graph.context.sampleRate} Hz ${graph.context.state}`,
    );
    ui.line('diag', lines.join('\n'));
    log('diagnose', { lines });
  }

  function rampTo(param, value) {
    const now = graph.context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + RAMP_SECONDS);
    setTimeout(render, 250);
  }

  function pickPlayer() {
    return document.querySelector('#movie_player');
  }

  function isAdShowing() {
    return pickPlayer()?.classList.contains('ad-showing') ?? false;
  }

  function watchSourceChange(video, onChange) {
    const player = pickPlayer();
    const onEvent = (event) => onChange(`the video changed (${event.type})`);
    const observer = new MutationObserver(() => {
      if (isAdShowing()) onChange('an ad started');
    });
    for (const type of SOURCE_CHANGE_EVENTS) video.addEventListener(type, onEvent);
    if (player) observer.observe(player, { attributes: true, attributeFilter: ['class'] });
    return () => {
      for (const type of SOURCE_CHANGE_EVENTS) video.removeEventListener(type, onEvent);
      observer.disconnect();
    };
  }

  function processedLevel() {
    const { video } = graph;
    const volumeAtRecord = result?.volumeAtRecord ?? 1;
    if (video.muted || volumeAtRecord === 0) return 0;
    return Math.min(MAX_PROCESSED_GAIN, Math.max(0, video.volume / volumeAtRecord));
  }

  function setGains(isProcessed) {
    const level = isProcessed ? processedLevel() : 0;
    rampTo(graph.originalGain.gain, isProcessed ? 0 : 1);
    rampTo(graph.processedGain.gain, level);
    graph.processedGainTarget = level;
  }

  function restoreOriginal() {
    playback?.stop();
    if (graph) setGains(false);
  }

  async function ensureGraph(video) {
    if (graph?.video === video) return graph;
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      await context.audioWorklet.addModule(chrome.runtime.getURL(RECORDER_PATH));
    } catch (error) {
      await context.close();
      throw new Error(`recorder worklet failed to load: ${error.message}`);
    }

    let source;
    try {
      source = context.createMediaElementSource(video);
    } catch {
      await context.close();
      throw new Error('this video already feeds another audio graph (the DeepFilterNet Attach?). Reload the tab first.');
    }
    const originalGain = new GainNode(context, { gain: 1 });
    const processedGain = new GainNode(context, { gain: 0 });
    const recorder = new AudioWorkletNode(context, 'clip-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
    });
    source.connect(originalGain).connect(context.destination);
    source.connect(recorder).connect(context.destination);
    processedGain.connect(context.destination);
    graph = { video, context, source, originalGain, processedGain, processedGainTarget: 0, recorder };
    video.addEventListener('play', () => context.resume());
    ui.line('dfn', 'DeepFilterNet panel needs a tab reload after a clip test');
    log('graph', { sampleRate: context.sampleRate });
    return graph;
  }

  function dispatch({ data }) {
    if (data.type === 'error' && data.id === undefined) {
      for (const job of jobs.values()) job.reject(new Error(data.message));
      jobs.clear();
      ui.line('separator', `separator: ${data.message}`);
      return;
    }
    const job = jobs.get(data.id);
    if (!job) return;
    if (data.type === 'status') return job.onStatus(data);
    jobs.delete(data.id);
    if (data.type === 'done') job.resolve(data);
    if (data.type === 'error') job.reject(new Error(data.message));
  }

  function connectSeparator(connection) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      connection.frame = frame;
      frame.src = chrome.runtime.getURL(SEPARATOR_PAGE);
      frame.tabIndex = -1;
      frame.setAttribute('aria-hidden', 'true');
      Object.assign(frame.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '1px',
        height: '1px',
        border: '0',
        opacity: '0',
        pointerEvents: 'none',
      });
      const fail = (error) => {
        clearTimeout(timer);
        frame.remove();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('separator frame did not start')), SEPARATOR_TIMEOUT_MS);
      frame.addEventListener(
        'load',
        () => {
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => {
            if (data.type === 'error') return fail(new Error(data.message));
            if (data.type !== 'ready') return;
            clearTimeout(timer);
            channel.port1.onmessage = dispatch;
            const gpu = data.backends.includes('webgpu') ? `WebGPU ${data.gpu}` : `no WebGPU (${data.gpu})`;
            ui.line('separator', `separator ready: ${gpu}, crossOriginIsolated=${data.crossOriginIsolated}`);
            log('separator-ready', data);
            connection.port = channel.port1;
            resolve(channel.port1);
          };
          frame.contentWindow.postMessage({ type: 'music-filter:connect' }, new URL(frame.src).origin, [channel.port2]);
        },
        { once: true },
      );
      document.documentElement.append(frame);
    });
  }

  function ensureSeparator() {
    if (separator) return separator.ready;
    const connection = {};
    connection.ready = connectSeparator(connection).catch((error) => {
      if (separator === connection) separator = undefined;
      throw error;
    });
    separator = connection;
    return connection.ready;
  }

  function resetSeparator(reason) {
    const connection = separator;
    separator = undefined;
    activeTest = undefined;
    if (connection) {
      connection.port?.close();
      connection.frame?.remove();
    }
    for (const job of jobs.values()) job.reject(new Error(reason));
    jobs.clear();
    ui.line('separator');
    ui.line('prep');
    log('separator-reset', { reason });
  }

  function separateWithDeadline(spec, message, transfer) {
    const clipSeconds = message.left.length / message.sampleRate;
    const timeoutMs = Math.max(spec.timeout.minMs, spec.timeout.msPerClipSecond * clipSeconds);
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        cancelProcessing = undefined;
      };
      const stop = (reason) => {
        settle();
        resetSeparator(reason);
        reject(new Error(reason));
      };
      const timer = setTimeout(
        () => stop(`${spec.label} separation took longer than ${seconds(timeoutMs)}, separator reset`),
        timeoutMs,
      );
      cancelProcessing = () => stop(`${spec.label} separation cancelled, separator reset`);
      ensureSeparator()
        .then((port) =>
          request(port, message, (status) => ui.line('main', `Processing ${spec.label}: ${describeStatus(status)}`), transfer),
        )
        .then(
          (done) => {
            settle();
            resolve(done);
          },
          (error) => {
            settle();
            reject(error);
          },
        );
    });
  }

  function request(port, message, onStatus, transfer = []) {
    const id = nextJobId++;
    return new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject, onStatus });
      port.postMessage({ ...message, id }, transfer);
    });
  }

  function describeStatus(status) {
    if (status.stage === 'download') {
      const total = status.total ? ` / ${(status.total / 1e6).toFixed(1)}` : '';
      return `weights ${(status.loaded / 1e6).toFixed(1)}${total} MB`;
    }
    if (status.stage === 'session') return `creating ${status.device} session`;
    const chunks = status.totalChunks ? ` chunk ${status.chunk}/${status.totalChunks}` : '';
    return `separating${chunks}, ${seconds(status.elapsedMs)}`;
  }

  function concat(chunks, frames) {
    const out = new Float32Array(frames);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function record(label, clipSeconds) {
    const { video, context, recorder } = graph;
    const remaining = Number.isFinite(video.duration) ? video.duration - video.currentTime - 0.25 : Infinity;
    const durationS = Math.min(clipSeconds, remaining);
    if (durationS < MIN_CLIP_SECONDS) throw new Error(`less than ${MIN_CLIP_SECONDS} s of video left`);
    const frames = Math.round(durationS * context.sampleRate);

    return new Promise((resolve, reject) => {
      const left = [];
      const right = [];
      let received = 0;
      const startTime = video.currentTime;
      const volumeAtRecord = video.muted ? 0 : video.volume;
      const timer = setInterval(() => {
        const secondsLeft = Math.ceil((frames - received) / context.sampleRate);
        ui.line('main', `Recording for ${label}: ${secondsLeft} s left (keep playing)`);
      }, 250);
      const abort = (reason) => {
        recorder.port.postMessage({ type: 'stop' });
        cleanup();
        reject(new Error(`recording stopped because ${reason}. Click Test again.`));
      };
      const interruptions = {
        pause: () => abort('the video paused'),
        seeking: () => abort('the video seeked'),
        waiting: () => abort('the video stalled to buffer'),
        ratechange: () => abort('the playback speed changed'),
      };
      const stopWatching = watchSourceChange(video, abort);
      const cleanup = () => {
        clearInterval(timer);
        recorder.port.onmessage = null;
        for (const [type, listener] of Object.entries(interruptions)) video.removeEventListener(type, listener);
        stopWatching();
      };
      recorder.port.onmessage = ({ data }) => {
        if (data.type !== 'chunk') return;
        left.push(data.left);
        right.push(data.right);
        received += data.left.length;
        if (!data.isLast) return;
        cleanup();
        resolve({
          left: concat(left, received),
          right: concat(right, received),
          startTime,
          volumeAtRecord,
          sampleRate: context.sampleRate,
        });
      };
      for (const [type, listener] of Object.entries(interruptions)) video.addEventListener(type, listener);
      recorder.port.postMessage({ type: 'start', frames });
      log('record-start', { startTime, frames });
    });
  }

  function peakOf(...channels) {
    let peak = 0;
    for (const channel of channels) {
      for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    }
    return peak;
  }

  function seekTo(video, time) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('seek timed out')), SEEK_TIMEOUT_MS);
      video.addEventListener(
        'seeked',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.currentTime = time;
    });
  }

  async function play() {
    if (!result || !graph) return;
    playback?.stop();
    const { video, context, processedGain } = graph;
    const { buffer, startTime } = result;
    const endTime = startTime + buffer.duration;

    setState('playing');
    video.pause();
    await seekTo(video, startTime);

    let bufferSource;
    const stopBuffer = () => {
      if (!bufferSource) return;
      bufferSource.onended = null;
      bufferSource.stop();
      bufferSource.disconnect();
      bufferSource = undefined;
    };
    const finish = (reason) => {
      for (const [type, listener] of Object.entries(listeners)) video.removeEventListener(type, listener);
      stopWatching();
      stopBuffer();
      playback = undefined;
      setGains(false);
      setState('ready');
      ui.line('main', `Playback ${reason}, original audio restored. Replay to listen again.`);
      log('playback-end', { reason, videoTime: video.currentTime });
    };
    const startBuffer = () => {
      stopBuffer();
      const offset = video.currentTime - startTime;
      if (offset < 0 || offset >= buffer.duration) return finish('left the recorded range');
      bufferSource = new AudioBufferSourceNode(context, { buffer });
      bufferSource.connect(processedGain);
      bufferSource.onended = () => finish('finished');
      bufferSource.start(0, offset);
      ui.line('main', `Playing ${MODES[mode]} from ${startTime.toFixed(2)} s (offset ${offset.toFixed(3)} s)`);
      log('buffer-start', { startTime, offset, mode });
    };
    const listeners = {
      playing: startBuffer,
      waiting: stopBuffer,
      pause: () => finish('stopped (paused)'),
      seeking: () => finish('stopped (seeked)'),
      timeupdate: () => {
        if (video.currentTime >= endTime) finish('finished');
      },
      volumechange: () => {
        if (mode === 'removed') setGains(true);
      },
    };
    for (const [type, listener] of Object.entries(listeners)) video.addEventListener(type, listener);
    const stopWatching = watchSourceChange(video, (reason) => finish(`stopped (${reason})`));
    playback = { stop: () => finish('stopped') };

    setGains(mode === 'removed');
    await context.resume();
    await video.play();
  }

  function describeResult(done, waitMs) {
    const fallback = done.fallbackReason ? ` (asked ${done.requestedDevice}: ${done.fallbackReason})` : '';
    return [
      `${MODELS[done.model].label} on ${done.device}${fallback}`,
      `separation ${seconds(done.separateMs)} for ${done.durationS.toFixed(1)} s, RTF ${done.rtf.toFixed(2)}`,
      `waited ${seconds(waitMs)} after recording. Weights ${done.weightsSource} ${(done.weightsBytes / 1e6).toFixed(1)} MB ` +
        `in ${seconds(done.downloadMs)}, session ${seconds(done.sessionMs)}`,
    ].join('\n');
  }

  async function runTest(modelKey) {
    if (state === 'recording' || state === 'processing') return;
    const spec = MODELS[modelKey];
    const video = pickVideo();
    if (!video) throw new Error('no <video> on this page');
    if (isAdShowing()) throw new Error('Wait for the ad to finish');
    if (video.playbackRate !== 1) throw new Error(`playback speed is ${video.playbackRate}x. Set it to Normal (1x) and try again.`);

    playback?.stop();
    runningModel = modelKey;
    ui.line('error');
    ui.line('result');
    await ensureGraph(video);
    await graph.context.resume();
    if (video.paused) await video.play();

    const test = {};
    activeTest = test;
    const showPrep = (text) => {
      if (activeTest === test) ui.line('prep', text);
    };
    const preparing = ensureSeparator().then((port) =>
      request(port, { type: 'prepare', model: modelKey, device: spec.device }, (status) =>
        showPrep(`${spec.label}: ${describeStatus(status)}`),
      ),
    );
    preparing.then(
      (ready) => showPrep(`${spec.label} ready on ${ready.device}, weights ${ready.weightsSource}`),
      (error) => showPrep(`${spec.label} prepare failed: ${error.message}`),
    );

    setState('recording');
    const clip = await record(spec.label, CLIP_SECONDS);
    const recordedAt = performance.now();
    const peak = peakOf(clip.left, clip.right);
    log('record-end', { frames: clip.left.length, startTime: clip.startTime, peak, volumeAtRecord: clip.volumeAtRecord });
    if (peak < SILENCE_PEAK) throw new Error('Recorded silence. Unmute the video and try again.');

    setState('processing');
    ui.line('main', `Processing ${spec.label}...`);
    const done = await separateWithDeadline(
      spec,
      { type: 'separate', model: modelKey, device: spec.device, sampleRate: clip.sampleRate, left: clip.left, right: clip.right },
      [clip.left.buffer, clip.right.buffer],
    );
    const waitMs = performance.now() - recordedAt;
    ui.line('prep');

    const buffer = new AudioBuffer({ numberOfChannels: 2, length: done.left.length, sampleRate: done.sampleRate });
    buffer.copyToChannel(done.left, 0);
    buffer.copyToChannel(done.right, 1);
    result = { buffer, startTime: clip.startTime, volumeAtRecord: clip.volumeAtRecord, model: done.model };
    const { left, right, ...summary } = done;
    log('separated', { ...summary, waitMs });
    ui.line('result', describeResult(done, waitMs));
    await play();
  }

  function selectMode(next) {
    mode = next;
    if (playback) setGains(mode === 'removed');
    render();
    log('mode', { mode });
  }

  const run = (action) =>
    action().catch((error) => {
      activeTest = undefined;
      restoreOriginal();
      setState(result ? 'ready' : 'idle');
      ui.line('main', 'Stopped, original audio restored.');
      ui.line('error', `Error: ${error.message}`);
      log('error', { message: error.message });
    });

  ui.button('mrx', `Test ${CLIP_SECONDS} s: MRX`, () => run(() => runTest('mrx')));
  ui.button('tiger', `Test ${CLIP_SECONDS} s: TIGER`, () => run(() => runTest('tiger')));
  ui.button('original', MODES.original, () => selectMode('original'));
  ui.button('removed', MODES.removed, () => selectMode('removed'));
  ui.button('replay', 'Replay', () => run(play));
  ui.button('cancel', 'Cancel', () => cancelProcessing?.());
  ui.button('diagnose', 'Diagnose', () => run(diagnose));
  ui.line('main', `Clip test: play a video, then click Test to record the next ${CLIP_SECONDS} s.`);
  render();
})();
