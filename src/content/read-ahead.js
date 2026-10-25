import { canPlayProcessed, decideHold } from '../pipeline/hold-policy.js';
import { findStreamForMedia, streamProblem } from '../pipeline/stream-match.js';
import { createOriginalAudioRegistry } from './original-audio.js';
import { createPanel } from './panel.js';
import { PlaybackScheduler } from './playback-scheduler.js';
import { connectSeparator } from './separator-client.js';

const TAP_CONNECT = 'music-filter:tap-connect';
const SOURCE_ATTRIBUTE = 'data-mf-media-source';
const TICK_MS = 250;
const RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 4;
const OUTPUT_SAMPLE_RATE = 48000;
const REPLAY_INTERVAL_MS = 5000;
const TICK_EVENTS = ['loadedmetadata', 'play', 'playing', 'seeked', 'ratechange', 'waiting', 'pause', 'ended', 'emptied'];

const isSafari = navigator.vendor === 'Apple Computer, Inc.';
const isLocalTest = location.hostname === 'localhost' && localStorage.getItem('mf_fake_separator') === '1';
const MODEL = isLocalTest ? 'fake' : 'dfn3';

const streams = new Map();
const objectUrls = new Map();
const originals = createOriginalAudioRegistry({ mode: isSafari ? 'mute' : 'graph', readPlayerVolume });
const fallbackMutes = createOriginalAudioRegistry({ mode: 'mute' });
let separator;
let separatorFailure = null;
let streamFailure = null;
let activeStreamId = null;
let isEnabled = false;
let context;
let scheduler;
let original;
let attachedVideo;
let videoListeners;
let detail = '';
let heldSince = null;
let playRequestedAt = null;
let tappedPlayerVolume = null;

const panel = createPanel({ onToggle: (on) => setEnabled(on).catch((error) => failClosed(error.message)) });
connectTap();
setInterval(safeTick, TICK_MS);

function connectTap() {
  const channel = new MessageChannel();
  channel.port1.onmessage = ({ data }) => handleTapEvent(data);
  window.postMessage({ type: TAP_CONNECT }, '*', [channel.port2]);
}

function handleTapEvent(event) {
  if (event.kind === 'object-url') {
    objectUrls.set(event.mediaSourceId, event.url);
    return;
  }
  if (event.kind === 'player-volume') {
    tappedPlayerVolume = { muted: event.muted, volume: event.volume };
    return;
  }
  if (event.kind === 'media-element-source') {
    safeTick();
    return;
  }
  if (event.kind === 'source-buffer') {
    streams.set(event.streamId, {
      ...event,
      init: null,
      chunks: [],
      retainedBytes: 0,
      timestampOffset: 0,
      lastReplayAt: -Infinity,
    });
    for (const id of streams.keys()) {
      if (streams.size <= MAX_STREAMS) break;
      if (id !== activeStreamId) streams.delete(id);
    }
    return;
  }
  const stream = streams.get(event.streamId);
  if (!stream) return;
  const isActive = event.streamId === activeStreamId;
  if (event.kind === 'append') {
    retain(stream, event.bytes);
    if (isActive && !currentFailure()) sendChunk(event.streamId, event.bytes);
  }
  if (event.kind === 'abort' && isActive) send({ type: 'stream-abort', streamId: event.streamId });
  if (event.kind === 'timestamp-offset' || event.kind === 'change-type') {
    if (event.kind === 'timestamp-offset') stream.timestampOffset = event.value;
    else stream.mime = event.mime;
    const problem = streamProblem(stream);
    if (isActive && problem) fail(problem);
  }
}

function retain(stream, bytes) {
  if (!stream.init) {
    stream.init = bytes;
    return;
  }
  if (!isEnabled && stream !== currentStream()) return;
  stream.chunks.push(bytes);
  stream.retainedBytes += bytes.byteLength;
  while (stream.retainedBytes > RETAINED_BYTES) stream.retainedBytes -= stream.chunks.shift().byteLength;
}

function trimInactiveStreams() {
  const keep = currentStream();
  for (const stream of streams.values()) {
    if (stream === keep) continue;
    stream.chunks = [];
    stream.retainedBytes = 0;
  }
}

function sendChunk(streamId, bytes) {
  const copy = bytes.slice(0);
  send({ type: 'stream-chunk', streamId, bytes: copy }, [copy]);
}

function ensureSeparator() {
  if (separatorFailure) return null;
  if (!separator) {
    const pending = connectSeparator({ onMessage: (message) => handleWorkerMessage(message, pending) });
    pending.catch((error) => failSeparator(error.message, pending));
    separator = pending;
  }
  return separator;
}

function failSeparator(message, pending) {
  if (!pending || pending !== separator) return;
  separator = undefined;
  pending.then(({ frame }) => frame.remove(), () => {});
  separatorFailure = `separator: ${message}`;
  stopForFailure();
}

function send(message, transfer = []) {
  const pending = ensureSeparator();
  if (!pending) return;
  pending.then(
    ({ port }) => {
      if (pending === separator) port.postMessage(message, transfer);
    },
    () => {},
  );
}

function handleWorkerMessage(message, connection) {
  if (connection !== separator) return;
  if (message.type === 'error') {
    failSeparator(message.message, connection);
    return;
  }
  if (message.streamId !== activeStreamId) return;
  if (message.type === 'window') {
    scheduler?.addWindow(message);
    return;
  }
  if (message.type !== 'stream-status') return;
  if (message.stage === 'unsupported' || message.stage === 'error') fail(message.reason ?? message.message);
  if (message.stage === 'starved') replay(message.streamId);
  if (message.stage === 'loading') detail = 'loading voice filter';
  if (message.stage === 'window') detail = `window ${message.durationSeconds.toFixed(0)} s in ${(message.computeMs / 1000).toFixed(1)} s`;
}

function currentFailure() {
  return separatorFailure ?? original?.error ?? streamFailure;
}

function fail(message) {
  streamFailure ??= message;
  stopForFailure();
}

function failClosed(message) {
  const video = pickVideo();
  if (isEnabled && video) fallbackMutes.attach(video, null, { level: 0 });
  fail(message);
}

function stopForFailure() {
  scheduler?.stopAll();
  releaseHold();
  if (!isEnabled) return;
  original?.setLevel(0);
  panel.update({ state: 'error', detail: currentFailure(), originalLevel: original?.currentLevel() ?? 1 });
}

function releaseHold() {
  if (heldSince === null) return;
  heldSince = null;
  if (attachedVideo?.paused) attachedVideo.play().catch(() => {});
}

function applyHold(action) {
  if (action === 'resume') releaseHold();
  if (action !== 'pause') return;
  heldSince ??= performance.now();
  attachedVideo.pause();
}

function readPlayerVolume() {
  try {
    const player = document.querySelector('#movie_player');
    const muted = player?.isMuted?.();
    const volume = player?.getVolume?.();
    if (typeof muted === 'boolean' && Number.isFinite(volume)) return { muted, volume: volume / 100 };
  } catch {}
  return tappedPlayerVolume;
}

function pickVideo() {
  return document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
}

function selectStream(video) {
  return findStreamForMedia({
    streams: streams.values(),
    objectUrls,
    taggedMediaSourceId: video.getAttribute(SOURCE_ATTRIBUTE),
    src: video.src || video.currentSrc,
  });
}

function currentStream() {
  const video = pickVideo();
  return video ? selectStream(video) : null;
}

function activate(stream) {
  activeStreamId = stream.streamId;
  streamFailure = null;
  detail = '';
  scheduler.reset();
  const problem = streamProblem(stream);
  if (problem) {
    fail(problem);
    return;
  }
  sendRetained(stream);
}

function sendRetained(stream) {
  const playheadSeconds = attachedVideo?.currentTime ?? 0;
  send({ type: 'stream-reset', streamId: stream.streamId, mime: stream.mime, model: MODEL, playheadSeconds });
  if (stream.init) sendChunk(stream.streamId, stream.init);
  for (const chunk of stream.chunks) sendChunk(stream.streamId, chunk);
}

function replay(streamId) {
  const stream = streams.get(streamId);
  const now = performance.now();
  if (!stream || currentFailure() || now - stream.lastReplayAt < REPLAY_INTERVAL_MS) return;
  stream.lastReplayAt = now;
  detail = 'reloading audio';
  sendRetained(stream);
}

function deactivate() {
  activeStreamId = null;
  streamFailure = null;
  detail = '';
  scheduler.reset();
}

function attach(video) {
  videoListeners?.abort();
  scheduler?.dispose();
  context ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
  original = originals.attach(video, context, { level: 0 });
  scheduler = new PlaybackScheduler(context, video);
  attachedVideo = video;
  activeStreamId = null;
  streamFailure = null;
  heldSince = null;
  playRequestedAt = null;
  videoListeners = new AbortController();
  const { signal } = videoListeners;
  video.addEventListener('play', () => (playRequestedAt ??= performance.now()), { signal });
  video.addEventListener(
    'seeking',
    () => {
      scheduler.stopAll();
      safeTick();
    },
    { signal },
  );
  for (const type of TICK_EVENTS) video.addEventListener(type, safeTick, { signal });
  video.addEventListener('play', () => context.resume().catch(() => {}), { signal });
  if (original.error) stopForFailure();
}

async function setEnabled(on) {
  isEnabled = on;
  if (!on) {
    releaseHold();
    playRequestedAt = null;
    scheduler?.stopAll();
    activeStreamId = null;
    fallbackMutes.restoreAll();
    originals.restoreAll();
    trimInactiveStreams();
    panel.update({ state: 'off', detail: '', originalLevel: 1 });
    return;
  }
  const video = pickVideo();
  if (!video) throw new Error('no video on this page');
  separatorFailure = null;
  attach(video);
  panel.update({ state: 'waiting', detail: '', originalLevel: original.currentLevel() });
  await context.resume();
  if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
  ensureSeparator();
  safeTick();
}

function safeTick() {
  try {
    tick();
  } catch (error) {
    failClosed(`internal error: ${error.message}`);
  }
}

function tick() {
  if (!isEnabled) return;
  const video = pickVideo();
  if (!video) return;
  if (video !== attachedVideo) attach(video);
  const stream = selectStream(video);
  if (!stream && activeStreamId !== null) deactivate();
  if (stream && stream.streamId !== activeStreamId) activate(stream);
  if (activeStreamId !== null) playRequestedAt = null;
  if (activeStreamId !== null && !currentFailure()) {
    send({ type: 'playhead', streamId: activeStreamId, seconds: video.currentTime, isPlaying: !video.paused });
  }
  if (context.state !== 'running') context.resume().catch(() => {});

  const isAudioRunning = context.state === 'running';
  const decision = decideHold({
    failure: currentFailure(),
    hasStream: activeStreamId !== null,
    playbackRate: video.playbackRate,
    isPaused: video.paused,
    isHeld: heldSince !== null,
    heldSeconds: heldSince === null ? 0 : (performance.now() - heldSince) / 1000,
    playRequestedSeconds: playRequestedAt === null ? 0 : (performance.now() - playRequestedAt) / 1000,
    isAudioRunning,
    processed: scheduler.ranges,
    now: video.currentTime,
    duration: video.duration,
  });
  if (decision.failure) fail(decision.failure);
  else applyHold(decision.action);

  original.setLevel(0);
  const failure = currentFailure();
  const state = failure ? 'error' : decision.state;
  scheduler.tick({
    allowProcessed: canPlayProcessed({
      state,
      isPaused: video.paused,
      isSeeking: video.seeking,
      isAudioRunning,
      readyState: video.readyState,
    }),
  });
  scheduler.setVolume(state === 'filtered' ? original.userVolume() : 0);
  panel.update({
    state,
    detail: failure ?? detail,
    originalLevel: original.currentLevel(),
    aheadSeconds: scheduler.secondsAhead(),
    windows: scheduler.windows.length,
  });
}
