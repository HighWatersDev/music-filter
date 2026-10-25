import { OpusDecoder } from 'opus-decoder';
import { parseOpusHead } from './opus-head.js';

const CONTINUITY_TOLERANCE_SECONDS = 0.005;
const DEFAULT_PRE_ROLL_SECONDS = 0.08;

export class FrameDecoder {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.decoder = null;
    this.isReady = false;
  }

  async configure(init) {
    this.free();
    const head = init.codecPrivate
      ? parseOpusHead(init.codecPrivate)
      : { channels: init.channels, preSkip: Math.round((init.codecDelayNs / 1e9) * this.sampleRate) };
    const decoder = new OpusDecoder({
      sampleRate: this.sampleRate,
      channels: head.channels,
      streamCount: head.streamCount,
      coupledStreamCount: head.coupledStreamCount,
      channelMappingTable: head.channelMappingTable,
      forceStereo: true,
      preSkip: 0,
    });
    this.decoder = decoder;
    await decoder.ready;
    if (this.decoder !== decoder) {
      decoder.free();
      return;
    }
    this.preRollSamples = Math.round(((init.seekPreRollNs || DEFAULT_PRE_ROLL_SECONDS * 1e9) / 1e9) * this.sampleRate);
    this.toleranceSamples = Math.round(CONTINUITY_TOLERANCE_SECONDS * this.sampleRate);
    this.expectedNext = null;
    this.preSkip = head.preSkip;
    this.discard = 0;
    this.isReady = true;
  }

  decode({ timeSeconds, data, discardPaddingNs = 0 }) {
    const frameStart = Math.round(timeSeconds * this.sampleRate);
    let start = frameStart;
    if (this.expectedNext === null) this.discard = frameStart <= this.preSkip ? this.preSkip : this.preRollSamples;
    else if (Math.abs(frameStart - this.expectedNext) <= this.toleranceSamples) start = this.expectedNext;
    else this.discard = this.preRollSamples;
    const { channelData, samplesDecoded } = this.decoder.decodeFrame(data);
    if (!samplesDecoded) return null;
    this.expectedNext = start + samplesDecoded;

    const padding = Math.round((Math.abs(discardPaddingNs) / 1e9) * this.sampleRate);
    const end = discardPaddingNs > 0 ? samplesDecoded - padding : samplesDecoded;
    const preRollSkip = Math.min(this.discard, samplesDecoded);
    this.discard -= preRollSkip;
    const skip = Math.max(preRollSkip, discardPaddingNs < 0 ? padding : 0, -start);
    if (skip >= end) return null;
    return { startSample: start + skip, channelData: channelData.map((channel) => channel.slice(skip, end)) };
  }

  free() {
    if (this.isReady) this.decoder.free();
    this.decoder = null;
    this.isReady = false;
  }
}
