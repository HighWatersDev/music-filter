import { decideHold } from '../pipeline/hold-policy.js';
import { createOriginalAudio } from './original-audio.js';
import { createPanel } from './panel.js';
import { PlaybackScheduler } from './playback-scheduler.js';
import { connectSeparator } from './separator-client.js';

const TAP_CONNECT = 'music-filter:tap-connect';
const TICK_MS = 250;
const RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 4;
const OUTPUT_SAMPLE_RATE = 48000;
const TICK_EVENTS = ['play', 'playing', 'seeked', 'ratechange'];

const isSafari = navigator.vendor === 'Apple Computer, Inc.';
const isLocalTest = location.hostname === 'localhost' && localStorage.getItem('mf_fake_separator') === '1';
const MODEL = isLocalTest ? 'fake' : 'dfn3';

const streams = new Map();
const objectUrls = new Map();
let separator;
let activeStreamId = null;
let isEnabled = false;
let context;
let scheduler;
let original;
let attachedVideo;
let detail = '';
let failure = null;
let heldSince = null;

const panel = createPanel({ onToggle: (on) => setEnabled(on).catch((error) => fail(error.message)) });
connectTap();
setInterval(tick, TICK_MS);

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
  if (event.kind === 'source-buffer') {
    streams.set(event.streamId, { ...event, init: null, chunks: [], retainedBytes: 0 });
    for (const id of streams.keys()) {
      if (streams.size <= MAX_STREAMS) break;
      if (id !== activeStreamId) streams.delete(id);
    }
    return;
  }
  const stream = streams.get(event.streamId);
  if (!stream) return;
  if (event.kind === 'append') {
    retain(stream, event.bytes);
    if (event.streamId === activeStreamId) sendChunk(event.streamId, event.bytes);
  }
  if (event.kind === 'abort' && event.streamId === activeStreamId) send({ type: 'stream-abort', streamId: event.streamId });
}

function retain(stream, bytes) {
  if (!stream.init) {
    stream.init = bytes;
    return;
  }
  stream.chunks.push(bytes);
  stream.retainedBytes += bytes.byteLength;
  while (stream.retainedBytes > RETAINED_BYTES) stream.retainedBytes -= stream.chunks.shift().byteLength;
}

function sendChunk(streamId, bytes) {
  const copy = bytes.slice(0);
  send({ type: 'stream-chunk', streamId, bytes: copy }, [copy]);
}

function ensureSeparator() {
  separator ??= connectSeparator({ onMessage: handleWorkerMessage }).catch((error) => {
    separator = undefined;
    throw error;
  });
  return separator;
}

function send(message, transfer = []) {
  ensureSeparator().then(
    ({ port }) => port.postMessage(message, transfer),
    (error) => fail(`separator: ${error.message}`),
  );
}

function handleWorkerMessage(message) {
  if (message.type === 'error') {
    fail(`separator: ${message.message}`);
    return;
  }
  if (message.streamId !== activeStreamId) return;
  if (message.type === 'window') {
    scheduler?.addWindow(message);
    return;
  }
  if (message.type !== 'stream-status') return;
  if (message.stage === 'unsupported' || message.stage === 'error') fail(message.reason ?? message.message);
  if (message.stage === 'loading') detail = 'loading voice filter';
  if (message.stage === 'window') detail = `window ${message.durationSeconds.toFixed(0)} s in ${(message.computeMs / 1000).toFixed(1)} s`;
}

function fail(message) {
  failure = message;
  scheduler?.stopAll();
  releaseHold();
  panel.update({ state: 'error', detail: message, originalLevel: original?.currentLevel() ?? 1 });
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

function pickVideo() {
  return document.querySelector('#movie_player video.html5-main-video') ?? document.querySelector('video');
}

function selectStream(video) {
  const src = video.currentSrc || video.src;
  let match = null;
  for (const stream of streams.values()) if (objectUrls.get(stream.mediaSourceId) === src) match = stream;
  return match;
}

function activate(stream) {
  activeStreamId = stream.streamId;
  failure = null;
  scheduler?.reset();
  send({ type: 'stream-reset', streamId: stream.streamId, mime: stream.mime, model: MODEL });
  if (stream.init) sendChunk(stream.streamId, stream.init);
  for (const chunk of stream.chunks) sendChunk(stream.streamId, chunk);
}

function attach(video) {
  original?.dispose();
  context ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE, latencyHint: 'playback' });
  original = createOriginalAudio(video, context, { mode: isSafari ? 'mute' : 'graph' });
  scheduler?.reset();
  scheduler = new PlaybackScheduler(context, video);
  attachedVideo = video;
  activeStreamId = null;
  heldSince = null;
  video.addEventListener('seeking', () => {
    scheduler?.stopAll();
    tick();
  });
  for (const type of TICK_EVENTS) video.addEventListener(type, () => tick());
  video.addEventListener('play', () => context.resume());
}

async function setEnabled(on) {
  isEnabled = on;
  if (!on) {
    releaseHold();
    scheduler?.stopAll();
    original?.setLevel(1);
    panel.update({ state: 'off', detail: '', originalLevel: 1 });
    return;
  }
  const video = pickVideo();
  if (!video) throw new Error('no video on this page');
  if (video !== attachedVideo) attach(video);
  original.setLevel(0);
  failure = null;
  activeStreamId = null;
  panel.update({ state: 'waiting', detail: '', originalLevel: 0 });
  await context.resume();
  if ('audioSession' in navigator) navigator.audioSession.type = 'playback';
  ensureSeparator().catch(() => {});
  tick();
}

function tick() {
  if (!isEnabled) return;
  const video = pickVideo();
  if (!video) return;
  if (video !== attachedVideo) attach(video);
  const stream = selectStream(video);
  if (stream && stream.streamId !== activeStreamId) activate(stream);
  if (activeStreamId !== null) {
    send({ type: 'playhead', streamId: activeStreamId, seconds: video.currentTime, isPlaying: !video.paused });
  }
  if (context.state !== 'running') context.resume().catch(() => {});

  const isAudioRunning = context.state === 'running';
  const decision = decideHold({
    failure,
    hasStream: activeStreamId !== null,
    playbackRate: video.playbackRate,
    isPaused: video.paused,
    isHeld: heldSince !== null,
    heldSeconds: heldSince === null ? 0 : (performance.now() - heldSince) / 1000,
    isAudioRunning,
    processed: scheduler.ranges,
    now: video.currentTime,
    duration: video.duration,
  });
  if (decision.failure) fail(decision.failure);
  else applyHold(decision.action);

  original.setLevel(0);
  const isFiltered = !failure && decision.state === 'filtered';
  scheduler.tick({ allowProcessed: isFiltered && !video.paused && !video.seeking && isAudioRunning });
  scheduler.setVolume(isFiltered ? original.userVolume() : 0);
  panel.update({
    state: failure ? 'error' : decision.state,
    detail: failure ?? detail,
    originalLevel: original.currentLevel(),
    aheadSeconds: scheduler.secondsAhead(),
    windows: scheduler.windows.length,
  });
}
