import { FrameDecoder, isSameDecoderConfig } from './frame-decoder.js';
import { PcmTimeline } from './pcm-timeline.js';
import { addRange, contiguousEnd, trimBefore } from './ranges.js';
import { WebmDemuxer } from './webm-demuxer.js';
import { bridgedEnd, bridgedStart, isStarved, planNextWindow } from './window-planner.js';

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
  // tools/listen/engine-check.mjs on synth-6db-original.wav (2026-10-26): every join with audio in it
  // stayed at -21.6 dB or better with 1 s (-22.1 dB with 2 s, -19.0 dB with 0.25 s), and the compute RTF
  // fell from 0.268 to 0.252. The join at 19 s sits near -17 dB whatever the context length.
  warmUpBeforeSeconds: 1,
  starvedRearmSeconds: 1,
};

// An Opus packet is at most 120 ms, and the decoder discards up to 80 ms of pre-roll after a gap, so a
// packet is only dropped once that much audio separates it from the oldest sample still kept.
const STALE_PACKET_MARGIN_SECONDS = 0.25;

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

  push(frame) {
    this.items.push(frame);
    this.bytes += frame.data.byteLength;
  }

  peek() {
    return this.items[this.head];
  }

  shift() {
    const frame = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    this.bytes -= frame.data.byteLength;
    if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return frame;
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
    this.segments = [];
    this.activeSegment = null;
    this.timeline = new PcmTimeline({ channels: 2, pageSamples: this.config.sampleRate });
    this.processed = [];
    this.inFlight = null;
    this.halted = null;
    this.playhead = 0;
    this.isPlaying = false;
    this.ready = Promise.resolve();
    this.hasSeenAudio = false;
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

  queuedPackets() {
    let count = 0;
    let bytes = 0;
    for (const { packets } of this.segments) {
      count += packets.length;
      bytes += packets.bytes;
    }
    return { count, bytes };
  }

  hasPendingDecode() {
    if (this.decoder && !this.decoder.isReady) return true;
    const segment = this.selectSegment();
    return segment !== null && this.isDecodable(segment);
  }

  isDecodable(segment) {
    const next = segment.packets.peek();
    return next !== undefined && this.frameSample(next) < this.decodeLimit();
  }

  decodedFrontier() {
    return bridgedEnd(this.timeline.ranges, this.playhead, this.config.maxStartGapSeconds * this.config.sampleRate);
  }

  // Segments arrive in append order, which after a backward seek is not time order. Decoding sticks to
  // one segment where it can, because every switch costs the decoder its continuity.
  selectSegment() {
    const frontier = this.decodedFrontier() + this.config.maxStartGapSeconds * this.config.sampleRate;
    const continues = (segment) => this.isDecodable(segment) && this.frameSample(segment.packets.peek()) <= frontier;
    const active = this.activeSegment;
    const continuing = this.segments.find(continues) ?? null;
    if (active && this.isDecodable(active) && (continues(active) || !continuing)) return active;
    if (continuing) return continuing;
    if (!active) return this.segments.find((segment) => this.isDecodable(segment)) ?? this.segments[0] ?? null;
    return this.segments.slice(this.segments.indexOf(active) + 1).find((segment) => this.isDecodable(segment)) ?? null;
  }

  dropStalePackets() {
    const { sampleRate: rate, keepBehindSeconds } = this.config;
    const staleBefore = this.playhead - (keepBehindSeconds + STALE_PACKET_MARGIN_SECONDS) * rate;
    for (const { packets } of this.segments) {
      while (packets.length > 0 && this.frameSample(packets.peek()) < staleBefore) {
        packets.shift();
        this.hasSeenAudio = true;
      }
    }
    const last = this.segments.at(-1);
    this.segments = this.segments.filter((segment) => segment === last || segment.packets.length > 0);
    if (!this.segments.includes(this.activeSegment)) this.activeSegment = null;
  }

  enterSegment(segment) {
    this.activeSegment = segment;
    if (this.decoder && isSameDecoderConfig(this.decoder.init, segment.init)) this.decoder.markJoin();
    else this.configureDecoder(segment.init);
  }

  drainPackets() {
    if (this.halted !== null) return;
    this.dropStalePackets();
    while (this.halted === null && !(this.decoder && !this.decoder.isReady)) {
      const segment = this.selectSegment();
      if (!segment) return;
      if (segment !== this.activeSegment) {
        this.enterSegment(segment);
        continue;
      }
      if (!this.isDecodable(segment)) return;
      this.decodeFrame(segment.packets.shift());
    }
  }

  handleInit(init) {
    if (init.codecId !== 'A_OPUS') {
      this.halted = `codec ${init.codecId} is not supported`;
      this.onStatus({ stage: 'unsupported', reason: this.halted });
      return;
    }
    this.segments.push({ init, packets: new PacketQueue() });
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
    if (this.halted || this.segments.length === 0) return;
    this.segments.at(-1).packets.push(frame);
    this.drainPackets();
  }

  decodeFrame(frame) {
    const span = this.decoder.decode(frame);
    if (!span) return;
    this.hasSeenAudio = true;
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
    if (!this.hasSeenAudio || this.hasPendingDecode()) return;
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
