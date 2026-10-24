import test from 'node:test';
import assert from 'node:assert/strict';
import { Utf8Decoder, Utf8Encoder } from '../src/worklet/text-codec-polyfill.js';

test('round-trips non-ASCII text', () => {
  const text = 'héllo ✓ 音楽';
  const bytes = new Utf8Encoder().encode(text);

  assert.deepEqual(bytes, new TextEncoder().encode(text));
  assert.equal(new Utf8Decoder().decode(bytes), text);
});

test('decodes a subarray view and an empty call', () => {
  const bytes = new TextEncoder().encode('xxabcxx');
  const decoder = new Utf8Decoder('utf-8', { ignoreBOM: true, fatal: true });

  assert.equal(decoder.decode(bytes.subarray(2, 5)), 'abc');
  assert.equal(decoder.decode(), '');
});
