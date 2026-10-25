export const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  CODEC_DELAY: 0x56aa,
  SEEK_PRE_ROLL: 0x56bb,
  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  CHANNELS: 0x9f,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
};

export const MAX_ID_LENGTH = 4;

export function readVint(bytes, offset, { keepMarker = false } = {}) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return { error: 'vint has no length marker' };
  const length = Math.clz32(first) - 23;
  if (offset + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let isAllOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i];
    value = value * 256 + byte;
    if (byte !== 0xff) isAllOnes = false;
  }
  return { value, length, isUnknown: !keepMarker && isAllOnes };
}

export function readUint(bytes) {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

export function readFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength === 4) return view.getFloat32(0);
  if (bytes.byteLength === 8) return view.getFloat64(0);
  return 0;
}

export function readString(bytes) {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}
