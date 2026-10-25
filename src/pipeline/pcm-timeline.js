import { addRange, covers, trimBefore } from './ranges.js';

export class PcmTimeline {
  constructor({ channels = 2, pageSamples = 48000 } = {}) {
    this.channels = channels;
    this.pageSamples = pageSamples;
    this.pages = new Map();
    this.ranges = [];
  }

  write(start, channelData) {
    const length = channelData[0].length;
    this.forEachSpan(start, length, (page, pageOffset, written, count) => {
      for (let c = 0; c < this.channels; c++) {
        page[c].set((channelData[c] ?? channelData[0]).subarray(written, written + count), pageOffset);
      }
    }, true);
    this.ranges = addRange(this.ranges, start, start + length);
  }

  read(start, length) {
    if (!covers(this.ranges, start, start + length)) return null;
    const out = Array.from({ length: this.channels }, () => new Float32Array(length));
    this.forEachSpan(start, length, (page, pageOffset, written, count) => {
      for (let c = 0; c < this.channels; c++) out[c].set(page[c].subarray(pageOffset, pageOffset + count), written);
    }, false);
    return out;
  }

  evictBefore(point) {
    const firstKept = Math.floor(point / this.pageSamples);
    for (const index of [...this.pages.keys()]) if (index < firstKept) this.pages.delete(index);
    this.ranges = trimBefore(this.ranges, firstKept * this.pageSamples);
  }

  forEachSpan(start, length, visit, create) {
    for (let done = 0; done < length; ) {
      const position = start + done;
      const index = Math.floor(position / this.pageSamples);
      const pageOffset = position - index * this.pageSamples;
      const count = Math.min(this.pageSamples - pageOffset, length - done);
      let page = this.pages.get(index);
      if (!page && create) {
        page = Array.from({ length: this.channels }, () => new Float32Array(this.pageSamples));
        this.pages.set(index, page);
      }
      visit(page, pageOffset, done, count);
      done += count;
    }
  }
}
