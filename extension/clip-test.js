(() => {
  const RECORDER_PATH = 'clip-recorder.js';
  const SEPARATOR_PAGE = 'separator.html';
  const SAMPLE_RATE = 44100;
  const RAMP_SECONDS = 0.02;
  const MIN_CLIP_SECONDS = 2;
  const SEPARATOR_TIMEOUT_MS = 20000;
  const SEEK_TIMEOUT_MS = 10000;
  // Debug override for the headless harness only: ?mf_clip_seconds=10
  const clipOverride = Number(new URLSearchParams(location.search).get('mf_clip_seconds'));
  const CLIP_SECONDS = clipOverride > 0 && clipOverride <= 30 ? clipOverride : 30;

  const MODELS = {
    mrx: { label: 'MRX', device: 'wasm' },
    tiger: { label: 'TIGER', device: 'webgpu' },
  };
  const MODES = { original: 'Original', removed: 'Music removed' };

  let state = 'idle';
  let mode = 'removed';
  let graph;
  let separator;
  let result;
  let playback;
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
    ui.buttons.mrx.disabled = isBusy;
    ui.buttons.tiger.disabled = isBusy;
    ui.buttons.original.disabled = !result;
    ui.buttons.removed.disabled = !result;
    ui.buttons.replay.disabled = !result || isBusy;
    for (const [key, label] of Object.entries(MODES)) {
      ui.buttons[key].style.fontWeight = key === mode ? 'bold' : 'normal';
      ui.buttons[key].textContent = key === mode ? `[${label}]` : label;
    }
    for (const button of Object.values(ui.buttons)) button.style.opacity = button.disabled ? '0.5' : '1';
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

  function rampTo(param, value) {
    const now = graph.context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + RAMP_SECONDS);
    setTimeout(render, 250);
  }

  function setGains(isProcessed) {
    rampTo(graph.originalGain.gain, isProcessed ? 0 : 1);
    rampTo(graph.processedGain.gain, isProcessed ? 1 : 0);
    graph.processedGainTarget = isProcessed ? 1 : 0;
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
    graph = { video, context, originalGain, processedGain, processedGainTarget: 0, recorder };
    video.addEventListener('play', () => context.resume());
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

  function connectSeparator() {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
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
    separator ??= connectSeparator().catch((error) => {
      separator = undefined;
      throw error;
    });
    return separator;
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
      const timer = setInterval(() => {
        const secondsLeft = Math.ceil((frames - received) / context.sampleRate);
        ui.line('main', `Recording for ${label}: ${secondsLeft} s left (keep playing)`);
      }, 250);
      const cleanup = () => {
        clearInterval(timer);
        recorder.port.onmessage = null;
        video.removeEventListener('pause', onInterrupt);
        video.removeEventListener('seeking', onInterrupt);
      };
      const onInterrupt = () => {
        recorder.port.postMessage({ type: 'stop' });
        cleanup();
        reject(new Error('recording stopped because the video paused or seeked. Click Test again.'));
      };
      recorder.port.onmessage = ({ data }) => {
        if (data.type !== 'chunk') return;
        left.push(data.left);
        right.push(data.right);
        received += data.left.length;
        if (!data.isLast) return;
        cleanup();
        resolve({ left: concat(left, received), right: concat(right, received), startTime, sampleRate: context.sampleRate });
      };
      video.addEventListener('pause', onInterrupt);
      video.addEventListener('seeking', onInterrupt);
      recorder.port.postMessage({ type: 'start', frames });
      log('record-start', { startTime, frames });
    });
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
    };
    for (const [type, listener] of Object.entries(listeners)) video.addEventListener(type, listener);
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

    playback?.stop();
    ui.line('error');
    ui.line('result');
    await ensureGraph(video);
    await graph.context.resume();
    if (video.paused) await video.play();

    const preparing = ensureSeparator().then((port) =>
      request(port, { type: 'prepare', model: modelKey, device: spec.device }, (status) =>
        ui.line('prep', `${spec.label}: ${describeStatus(status)}`),
      ),
    );
    preparing.then(
      (ready) => ui.line('prep', `${spec.label} ready on ${ready.device}, weights ${ready.weightsSource}`),
      (error) => ui.line('prep', `${spec.label} prepare failed: ${error.message}`),
    );

    setState('recording');
    const clip = await record(spec.label, CLIP_SECONDS);
    const recordedAt = performance.now();
    log('record-end', { frames: clip.left.length, startTime: clip.startTime });

    setState('processing');
    ui.line('main', `Processing ${spec.label}...`);
    const port = await ensureSeparator();
    const done = await request(
      port,
      { type: 'separate', model: modelKey, device: spec.device, sampleRate: clip.sampleRate, left: clip.left, right: clip.right },
      (status) => ui.line('main', `Processing ${spec.label}: ${describeStatus(status)}`),
      [clip.left.buffer, clip.right.buffer],
    );
    const waitMs = performance.now() - recordedAt;
    ui.line('prep');

    const buffer = new AudioBuffer({ numberOfChannels: 2, length: done.left.length, sampleRate: done.sampleRate });
    buffer.copyToChannel(done.left, 0);
    buffer.copyToChannel(done.right, 1);
    result = { buffer, startTime: clip.startTime, model: done.model };
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
  ui.line('main', `Clip test: play a video, then click Test to record the next ${CLIP_SECONDS} s.`);
  render();
})();
