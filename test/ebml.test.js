import test from 'node:test';
import assert from 'node:assert/strict';
import { readFloat, readString, readUint, readVint } from '../src/pipeline/ebml.js';

test('readVint decodes sizes and keeps the marker for ids', () => {
  assert.deepEqual(readVint(Uint8Array.of(0x81), 0), { value: 1, length: 1, isUnknown: false });
  assert.deepEqual(readVint(Uint8Array.of(0x40, 0x02), 0), { value: 2, length: 2, isUnknown: false });
  assert.deepEqual(readVint(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), 0, { keepMarker: true }), {
    value: 0x1a45dfa3,
    length: 4,
    isUnknown: false,
  });
});

test('readVint flags unknown sizes, incomplete input and invalid bytes', () => {
  assert.equal(readVint(Uint8Array.of(0xff), 0).isUnknown, true);
  assert.equal(readVint(Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0).isUnknown, true);
  assert.equal(readVint(Uint8Array.of(0x40), 0), null);
  assert.equal(readVint(Uint8Array.of(), 0), null);
  assert.ok(readVint(Uint8Array.of(0x00), 0).error);
});

test('value readers', () => {
  assert.equal(readUint(Uint8Array.of(0x0f, 0x42, 0x40)), 1_000_000);
  assert.equal(readString(Uint8Array.of(0x41, 0x5f, 0x4f, 0x50, 0x55, 0x53, 0x00)), 'A_OPUS');
  assert.equal(readFloat(Uint8Array.of(0x47, 0x3b, 0x80, 0x00)), 48000);
});
