const MAGIC = 'OpusHead';
const MIN_LENGTH = 19;

export function parseOpusHead(bytes) {
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC || bytes.length < MIN_LENGTH) throw new Error('codec private data is not an OpusHead');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = bytes[9];
  const preSkip = view.getUint16(10, true);
  const inputSampleRate = view.getUint32(12, true);
  const mappingFamily = bytes[18];
  if (mappingFamily === 0) {
    return {
      channels,
      preSkip,
      inputSampleRate,
      mappingFamily,
      streamCount: 1,
      coupledStreamCount: channels === 2 ? 1 : 0,
      channelMappingTable: channels === 2 ? [0, 1] : [0],
    };
  }
  return {
    channels,
    preSkip,
    inputSampleRate,
    mappingFamily,
    streamCount: bytes[19],
    coupledStreamCount: bytes[20],
    channelMappingTable: Array.from(bytes.subarray(21, 21 + channels)),
  };
}
