import { FrameDecoder } from './frame-decoder.js';
import { PcmTimeline } from './pcm-timeline.js';
import { addRange, contiguousEnd, trimBefore } from './ranges.js';
import { WebmDemuxer } from './webm-demuxer.js';
import { bridgedStart, isStarved, planNextWindow } from './window-planner.js';

export const DEFAULT_CONFIG = {
  sampleRate: 48000,
  firstWindowSeconds: 2,
  windowSeconds: 10,
  overlapSeconds: 1,
  minWindowSeconds: 1,
  lookaheadSeconds: 30,
  urgencySeconds: 5,
  maxStartGapSeconds: 0.5,
  keepBehindSeconds: 30,
  keepAheadSeconds: 90,
  warmUpBeforeSeconds: 2,
  starvedRearmSeconds: 1,
};

function trimAfter(ranges, point) {
  return ranges.filter(([s]) => s < point).map(([s, e]) => [s, Math.min(e, point)]);
}

class PacketQueue {
  constructor() {
    this.items = [];
    this.head = 0;
    this.bytes = 0;
  }

  get length() {
    return this.items.length - this.head;
  }

  push(entry) {
    this.items.push(entry);
    this.bytes += entry.frame?.data.byteLength ?? 0;
  }

  peek() {
    return this.items[this.head];
  }

  shift() {
    const entry = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    this.bytes -= entry.frame?.data.byteLength ?? 0;
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return entry;
  }
}

export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

export class StreamEngine {
  constructor({
    separate,
    onWindow,
    onStatus = () => {},
    onWarning = () => {},
    config = {},
    enqueue = createSerialQueue(),
    playheadSeconds = 0,
  }) {
    this.separate = separate;
    this.enqueue = enqueue;
    this.onWindow = onWindow;
    this.onStatus = onStatus;
    this.onWarning = onWarning;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.generation = 0;
    this.reset();
    this.playhead = Math.max(0, Math.round(playheadSeconds * this.config.sampleRate));
  }

  reset() {
    this.generation += 1;
    this.demuxer = new WebmDemuxer({
      onInit: (init) => this.handleInit(init),
      onFrame: (frame) => this.handleFrame(frame),
      onWarning: (message) => this.onWarning(message),
    });
    this.decoder?.free();
    this.decoder = null;
    this.latestInit = null;
    this.packets = new PacketQueue();
    this.timeline = new PcmTimeline({ channels: 2, pageSamples: this.config.sampleRate });
    this.processed = [];
    this.inFlight = null;
    this.halted = null;
    this.playhead = 0;
    this.isPlaying = false;
    this.ready = Promise.resolve();
    this.hasDecoded = false;
    this.starvedAt = null;
  }

  pushChunk(bytes) {
    try {
      this.demuxer.push(bytes);
    } finally {
      this.pump();
    }
  }

  abort() {
    this.demuxer.abort();
  }

  setPlayhead(seconds, isPlaying) {
    const { sampleRate: rate, keepBehindSeconds, lookaheadSeconds, windowSeconds } = this.config;
    this.playhead = Math.max(0, Math.round(seconds * rate));
    this.isPlaying = isPlaying;
    const keepFrom = this.playhead - keepBehindSeconds * rate;
    if (keepFrom > 0) {
      this.timeline.evictBefore(keepFrom);
      this.processed = trimBefore(this.processed, keepFrom);
    }
    this.processed = trimAfter(this.processed, this.playhead + (lookaheadSeconds + windowSeconds) * rate);
    this.drainPackets();
    this.pump();
  }

  isIdle() {
    if (this.halted !== null) return true;
    if (this.inFlight || this.hasPendingDecode()) return false;
    return this.plan() === null;
  }

  decodeLimit() {
    return this.playhead + this.config.keepAheadSeconds * this.config.sampleRate;
  }

  frameSample(frame) {
    return Math.round(frame.timeSeconds * this.config.sampleRate);
  }

  hasPendingDecode() {
    if (this.decoder && !this.decoder.isReady) return true;
    const next = this.packets.peek();
    if (!next) return false;
    return Boolean(next.init) || this.frameSample(next.frame) < this.decodeLimit();
  }

  drainPackets() {
    while (this.packets.length > 0 && this.halted === null) {
      const { init, frame } = this.packets.peek();
      if (init) {
        if (this.decoder && !this.decoder.isReady) return;
        this.packets.shift();
        this.configureDecoder(init);
        continue;
      }
      if (!this.decoder?.isReady || this.frameSample(frame) >= this.decodeLimit()) return;
      this.packets.shift();
      this.decodeFrame(frame);
    }
  }

  handleInit(init) {
    if (init.codecId !== 'A_OPUS') {
      this.halted = `codec ${init.codecId} is not supported`;
      this.onStatus({ stage: 'unsupported', reason: this.halted });
      return;
    }
    this.latestInit = init;
    this.packets.push({ init });
    this.drainPackets();
  }

  configureDecoder(init) {
    const decoder = new FrameDecoder({ sampleRate: this.config.sampleRate });
    this.decoder?.free();
    this.decoder = decoder;
    this.ready = decoder
      .configure(init)
      .then(() => {
        if (this.decoder !== decoder) return;
        this.drainPackets();
        this.pump();
      })
      .catch((error) => {
        if (this.decoder !== decoder) return;
        this.halted = error.message;
        this.onStatus({ stage: 'error', message: error.message });
      });
  }

  handleFrame(frame) {
    if (this.halted || !this.latestInit) return;
    this.packets.push({ frame });
    this.drainPackets();
  }

  decodeFrame(frame) {
    const span = this.decoder.decode(frame);
    if (!span) return;
    this.hasDecoded = true;
    const { sampleRate: rate, keepBehindSeconds } = this.config;
    const start = span.startSample;
    if (start + span.channelData[0].length <= this.playhead - keepBehindSeconds * rate) return;
    this.timeline.write(start, span.channelData);
  }

  plan() {
    const { sampleRate: rate, ...c } = this.config;
    return planNextWindow({
      playhead: this.playhead,
      decoded: this.timeline.ranges,
      processed: this.processed,
      firstWindow: c.firstWindowSeconds * rate,
      window: c.windowSeconds * rate,
      overlap: c.overlapSeconds * rate,
      minWindow: c.minWindowSeconds * rate,
      lookahead: c.lookaheadSeconds * rate,
      urgency: c.urgencySeconds * rate,
      maxStartGap: c.maxStartGapSeconds * rate,
    });
  }

  readWindow({ start, end }) {
    const length = end - start;
    const covered = this.timeline.read(start, length);
    if (covered) return covered;
    const out = [new Float32Array(length), new Float32Array(length)];
    for (const [s, e] of this.timeline.ranges) {
      const from = Math.max(s, start);
      const to = Math.min(e, end);
      if (to <= from) continue;
      const [left, right] = this.timeline.read(from, to - from);
      out[0].set(left, from - start);
      out[1].set(right, from - start);
    }
    return out;
  }

  readContextBefore({ start }) {
    const { sampleRate: rate, warmUpBeforeSeconds, maxStartGapSeconds } = this.config;
    const earliest = Math.max(0, start - Math.round(warmUpBeforeSeconds * rate));
    const from = Math.max(earliest, bridgedStart(this.timeline.ranges, start, maxStartGapSeconds * rate));
    if (from >= start) return [new Float32Array(0), new Float32Array(0)];
    return this.readWindow({ start: from, end: start });
  }

  reportIfStarved() {
    if (!this.hasDecoded || this.hasPendingDecode()) return;
    const { sampleRate: rate, starvedRearmSeconds } = this.config;
    if (this.starvedAt !== null && Math.abs(this.playhead - this.starvedAt) <= starvedRearmSeconds * rate) return;
    const starved = isStarved({
      playhead: this.playhead,
      decoded: this.timeline.ranges,
      processed: this.processed,
      lookahead: this.config.lookaheadSeconds * rate,
      maxStartGap: this.config.maxStartGapSeconds * rate,
    });
    if (!starved) return;
    this.starvedAt = this.playhead;
    this.onStatus({ stage: 'starved', seconds: this.playhead / rate });
  }

  pump() {
    if (this.inFlight || this.halted) return;
    const window = this.plan();
    if (!window) {
      this.reportIfStarved();
      return;
    }
    const pcm = this.readWindow(window);
    const contextBefore = this.readContextBefore(window);

    const { generation } = this;
    const rate = this.config.sampleRate;
    let startedAt;
    this.inFlight = window;
    this.enqueue(() => {
      startedAt = Date.now();
      return this.separate(pcm[0], pcm[1], rate, { contextBefore });
    })
      .then(([left, right]) => {
        if (generation !== this.generation) return;
        this.processed = addRange(this.processed, window.start, window.end);
        this.onWindow({ startSeconds: window.start / rate, sampleRate: rate, left, right });
        this.onStatus({
          stage: 'window',
          startSeconds: window.start / rate,
          durationSeconds: (window.end - window.start) / rate,
          computeMs: Date.now() - startedAt,
          aheadSeconds: (contiguousEnd(this.processed, this.playhead) - this.playhead) / rate,
        });
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        this.halted = error.message;
        this.onStatus({ stage: 'error', message: error.message });
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.inFlight = null;
        this.pump();
      });
  }
}
