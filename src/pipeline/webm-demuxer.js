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
const RESYNC_IDS = [ID.CLUSTER, ID.EBML];
const MAX_LEAF_BYTES = 16 * 1024 * 1024;
const MAX_SKIP_BYTES = 256 * 1024 * 1024;
const AUDIO_TRACK_TYPE = 2;
const LACING_BITS = 0x06;

export class WebmDemuxer {
  constructor({ onInit, onFrame, onWarning = () => {} }) {
    this.onInit = onInit;
    this.onFrame = onFrame;
    this.onWarning = onWarning;
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.skipRemaining = 0;
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

      const id = readVint(buffer, this.offset, { keepMarker: true });
      if (!id) return;
      if (id.error || id.length > MAX_ID_LENGTH) {
        if (!this.resync('invalid element id')) return;
        continue;
      }
      const size = readVint(buffer, this.offset + id.length);
      if (!size) return;
      if (size.error) {
        if (!this.resync('invalid element size')) return;
        continue;
      }
      const payloadStart = this.offset + id.length + size.length;

      if (id.value === ID.EBML) {
        this.resetStream();
        this.offset = payloadStart;
        this.skipRemaining = size.isUnknown ? 0 : size.value;
        continue;
      }
      if (MASTERS.has(id.value)) {
        this.offset = payloadStart;
        this.enterMaster(id.value);
        continue;
      }
      if (size.isUnknown || size.value > MAX_SKIP_BYTES) {
        if (!this.resync(`element 0x${id.value.toString(16)} has an unusable size`)) return;
        continue;
      }
      if (LEAVES.has(id.value)) {
        if (size.value > MAX_LEAF_BYTES) {
          if (!this.resync(`element 0x${id.value.toString(16)} is too large`)) return;
          continue;
        }
        const payloadEnd = payloadStart + size.value;
        if (payloadEnd > buffer.length) return;
        this.readLeaf(id.value, buffer.subarray(payloadStart, payloadEnd));
        this.offset = payloadEnd;
        continue;
      }
      this.offset = payloadStart;
      this.skipRemaining = size.value;
    }
  }

  resync(reason) {
    this.onWarning(`resync: ${reason}`);
    const { buffer } = this;
    for (let i = this.offset + 1; i + MAX_ID_LENGTH <= buffer.length; i++) {
      if (RESYNC_IDS.includes(readUint(buffer.subarray(i, i + MAX_ID_LENGTH)))) {
        this.offset = i;
        return true;
      }
    }
    this.offset = Math.max(this.offset, buffer.length - (MAX_ID_LENGTH - 1));
    return false;
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

  readBlock(payload) {
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
    const timeSeconds = ((this.clusterTimecode + relativeTimecode) * this.timecodeScale) / 1e9;
    this.onFrame({ timeSeconds, data: payload.slice(headerEnd) });
  }
}
