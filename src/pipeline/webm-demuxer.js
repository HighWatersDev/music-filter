import { ID, MAX_ID_LENGTH, readFloat, readString, readUint, readVint } from './ebml.js';

const MASTERS = new Set([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.CLUSTER, ID.BLOCK_GROUP]);
const LEAVES = new Set([
  ID.TIMECODE_SCALE,
  ID.TRACK_NUMBER,
  ID.TRACK_TYPE,
  ID.CODEC_ID,
  ID.CODEC_PRIVATE,
  ID.CODEC_DELAY,
  ID.SEEK_PRE_ROLL,
  ID.SAMPLING_FREQUENCY,
  ID.CHANNELS,
  ID.TIMECODE,
  ID.SIMPLE_BLOCK,
  ID.BLOCK,
]);
const KNOWN_UNUSED_IDS = new Set([
  0xec, 0xbf,
  0x4286, 0x42f7, 0x42f2, 0x42f3, 0x4282, 0x4287, 0x4285,
  0x114d9b74, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469,
  0x4489, 0x4d80, 0x5741, 0x73a4, 0x4461, 0x7ba9, 0x7384, 0x3cb923, 0x3eb923, 0x3c83ab, 0x3e83bb, 0x4444, 0x6924,
  0x73c5, 0xb9, 0x88, 0x55aa, 0x9c, 0x6de7, 0x6df8, 0x23e383, 0x234e7a, 0x23314f, 0x55ee, 0x536e, 0x22b59c, 0x22b59d,
  0x258688, 0xe0, 0x6d80, 0x41e4, 0xaa, 0x7446, 0x6fab, 0x6624, 0xe2, 0x55ab, 0x55ac, 0x55ad, 0x55ae, 0x55af,
  0x78b5, 0x6264, 0x52f1,
  0x5854, 0xa7, 0xab, 0xaf,
  0xa2, 0x75a1, 0x9b, 0xfa, 0xfb, 0xfd, 0xa4, 0x75a2, 0x8e,
]);
const EBML_HEADER_CHILDREN = new Set([0x4286, 0x42f7, 0x42f2, 0x42f3, 0x4282, 0x4287, 0x4285]);
const MAX_LEAF_BYTES = 16 * 1024 * 1024;
const MAX_SKIP_BYTES = 256 * 1024 * 1024;
const AUDIO_TRACK_TYPE = 2;
const LACING_BITS = 0x06;
const DISCARD_PADDING = 0x75a2;

function readInt(bytes) {
  if (bytes.length === 0) return 0;
  const unsigned = readUint(bytes);
  return bytes[0] & 0x80 ? unsigned - 2 ** (8 * bytes.length) : unsigned;
}

export class WebmDemuxer {
  constructor({ onInit, onFrame, onWarning = () => {} }) {
    this.onInit = onInit;
    this.onFrame = onFrame;
    this.onWarning = onWarning;
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.skipRemaining = 0;
    this.isResyncing = false;
    this.pendingResyncReason = null;
    this.resetStream();
  }

  resetStream() {
    this.timecodeScale = 1_000_000;
    this.tracks = [];
    this.currentTrack = null;
    this.audioTrack = null;
    this.hasEmittedInit = false;
    this.clusterTimecode = null;
  }

  push(chunk) {
    const pending = this.buffer.length - this.offset;
    const next = new Uint8Array(pending + chunk.byteLength);
    next.set(this.buffer.subarray(this.offset), 0);
    next.set(chunk, pending);
    this.buffer = next;
    this.offset = 0;
    this.parse();
  }

  abort() {
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.skipRemaining = 0;
    this.clusterTimecode = null;
    this.isResyncing = true;
    this.pendingResyncReason = 'data after abort did not start at a cluster or init segment';
  }

  parse() {
    const { buffer } = this;
    while (true) {
      if (this.skipRemaining > 0) {
        const skipped = Math.min(this.skipRemaining, buffer.length - this.offset);
        this.offset += skipped;
        this.skipRemaining -= skipped;
        if (this.skipRemaining > 0) return;
      }
      if (this.isResyncing && !this.findSyncPoint()) return;

      const id = readVint(buffer, this.offset, { keepMarker: true });
      if (!id) return;
      if (id.error || id.length > MAX_ID_LENGTH) {
        this.startResync('invalid element id');
        continue;
      }
      const size = readVint(buffer, this.offset + id.length);
      if (!size) return;
      if (size.error) {
        this.startResync('invalid element size');
        continue;
      }
      const payloadStart = this.offset + id.length + size.length;

      if (id.value === ID.EBML) {
        this.resetStream();
        this.offset = payloadStart;
        this.skipRemaining = size.isUnknown ? 0 : size.value;
        continue;
      }
      if (id.value === ID.BLOCK_GROUP && !size.isUnknown && size.value <= MAX_LEAF_BYTES) {
        const payloadEnd = payloadStart + size.value;
        if (payloadEnd > buffer.length) return;
        this.offset = payloadEnd;
        this.readBlockGroup(buffer.subarray(payloadStart, payloadEnd));
        continue;
      }
      if (MASTERS.has(id.value)) {
        this.offset = payloadStart;
        this.enterMaster(id.value);
        continue;
      }
      const isLeaf = LEAVES.has(id.value);
      if (!isLeaf && !KNOWN_UNUSED_IDS.has(id.value)) {
        this.startResync(`unknown element 0x${id.value.toString(16)}`);
        continue;
      }
      if (size.isUnknown || size.value > (isLeaf ? MAX_LEAF_BYTES : MAX_SKIP_BYTES)) {
        this.startResync(`element 0x${id.value.toString(16)} has an unusable size`);
        continue;
      }
      if (!isLeaf) {
        this.offset = payloadStart;
        this.skipRemaining = size.value;
        continue;
      }
      const payloadEnd = payloadStart + size.value;
      if (payloadEnd > buffer.length) return;
      this.offset = payloadEnd;
      this.readLeaf(id.value, buffer.subarray(payloadStart, payloadEnd));
    }
  }

  startResync(reason) {
    this.onWarning(`resync: ${reason}`);
    this.offset += 1;
    this.isResyncing = true;
    this.pendingResyncReason = null;
  }

  findSyncPoint() {
    const { buffer } = this;
    for (let i = this.offset; i + MAX_ID_LENGTH <= buffer.length; i++) {
      const verdict = this.checkSyncPoint(i);
      if (verdict === 'reject') continue;
      if (i > this.offset) this.reportSkippedBytes();
      this.offset = i;
      if (verdict === 'wait') return false;
      this.isResyncing = false;
      this.pendingResyncReason = null;
      return true;
    }
    const keepFrom = Math.max(this.offset, buffer.length - (MAX_ID_LENGTH - 1));
    if (keepFrom > this.offset) this.reportSkippedBytes();
    this.offset = keepFrom;
    return false;
  }

  reportSkippedBytes() {
    if (!this.pendingResyncReason) return;
    this.onWarning(`resync: ${this.pendingResyncReason}`);
    this.pendingResyncReason = null;
  }

  checkSyncPoint(i) {
    const { buffer } = this;
    const id = readUint(buffer.subarray(i, i + MAX_ID_LENGTH));
    if (id !== ID.CLUSTER && id !== ID.EBML) return 'reject';
    const size = readVint(buffer, i + MAX_ID_LENGTH);
    if (!size) return 'wait';
    if (size.error) return 'reject';
    const child = readVint(buffer, i + MAX_ID_LENGTH + size.length, { keepMarker: true });
    if (!child) return 'wait';
    if (child.error) return 'reject';
    const isValid = id === ID.CLUSTER ? child.value === ID.TIMECODE : EBML_HEADER_CHILDREN.has(child.value);
    return isValid ? 'accept' : 'reject';
  }

  enterMaster(id) {
    if (id === ID.TRACK_ENTRY) {
      this.currentTrack = {};
      this.tracks.push(this.currentTrack);
    }
    if (id === ID.CLUSTER) {
      this.finishInit();
      this.clusterTimecode = null;
    }
  }

  readLeaf(id, payload) {
    const track = this.currentTrack;
    switch (id) {
      case ID.TIMECODE_SCALE:
        this.timecodeScale = readUint(payload);
        break;
      case ID.TRACK_NUMBER:
        if (track) track.number = readUint(payload);
        break;
      case ID.TRACK_TYPE:
        if (track) track.type = readUint(payload);
        break;
      case ID.CODEC_ID:
        if (track) track.codecId = readString(payload);
        break;
      case ID.CODEC_PRIVATE:
        if (track) track.codecPrivate = payload.slice();
        break;
      case ID.CODEC_DELAY:
        if (track) track.codecDelayNs = readUint(payload);
        break;
      case ID.SEEK_PRE_ROLL:
        if (track) track.seekPreRollNs = readUint(payload);
        break;
      case ID.SAMPLING_FREQUENCY:
        if (track) track.sampleRate = readFloat(payload);
        break;
      case ID.CHANNELS:
        if (track) track.channels = readUint(payload);
        break;
      case ID.TIMECODE:
        this.clusterTimecode = readUint(payload);
        break;
      case ID.SIMPLE_BLOCK:
      case ID.BLOCK:
        this.readBlock(payload);
        break;
    }
  }

  finishInit() {
    if (this.hasEmittedInit) return;
    this.hasEmittedInit = true;
    this.audioTrack =
      this.tracks.find((t) => t.codecId === 'A_OPUS') ?? this.tracks.find((t) => t.type === AUDIO_TRACK_TYPE) ?? null;
    if (!this.audioTrack) {
      this.onWarning('no audio track in init segment');
      return;
    }
    const {
      number,
      codecId,
      codecPrivate = null,
      channels = 2,
      sampleRate = 48000,
      codecDelayNs = 0,
      seekPreRollNs = 0,
    } = this.audioTrack;
    this.onInit({
      trackNumber: number,
      codecId,
      codecPrivate,
      channels,
      sampleRate,
      codecDelayNs,
      seekPreRollNs,
      timecodeScale: this.timecodeScale,
    });
  }

  readBlockGroup(payload) {
    let block = null;
    let discardPaddingNs = 0;
    for (let offset = 0; offset < payload.length; ) {
      const id = readVint(payload, offset, { keepMarker: true });
      if (!id || id.error) return;
      const size = readVint(payload, offset + id.length);
      if (!size || size.error || size.isUnknown) return;
      const start = offset + id.length + size.length;
      offset = start + size.value;
      if (offset > payload.length) return;
      if (id.value === ID.BLOCK) block = payload.subarray(start, offset);
      if (id.value === DISCARD_PADDING) discardPaddingNs = readInt(payload.subarray(start, offset));
    }
    if (block) this.readBlock(block, discardPaddingNs);
  }

  readBlock(payload, discardPaddingNs = 0) {
    if (!this.audioTrack) return;
    const trackNumber = readVint(payload, 0);
    if (!trackNumber || trackNumber.error || trackNumber.value !== this.audioTrack.number) return;
    if (this.clusterTimecode === null) {
      this.onWarning('block before cluster timecode skipped');
      return;
    }
    const headerEnd = trackNumber.length + 3;
    if (payload.length < headerEnd) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const relativeTimecode = view.getInt16(trackNumber.length);
    const flags = payload[trackNumber.length + 2];
    if (flags & LACING_BITS) {
      this.onWarning('laced block skipped');
      return;
    }
    const { codecDelayNs = 0 } = this.audioTrack;
    const timeSeconds = ((this.clusterTimecode + relativeTimecode) * this.timecodeScale - codecDelayNs) / 1e9;
    const frame = { timeSeconds, data: payload.slice(headerEnd) };
    if (discardPaddingNs) frame.discardPaddingNs = discardPaddingNs;
    this.onFrame(frame);
  }
}
