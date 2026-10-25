import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTargetOrigin } from '../src/content/separator-client.js';

test('frameTargetOrigin uses the frame origin when it has one', () => {
  assert.equal(frameTargetOrigin('https://example.test/separator.html'), 'https://example.test');
});

test('frameTargetOrigin falls back to * for an opaque origin', () => {
  assert.equal(frameTargetOrigin('safari-web-extension://ABCD-1234/separator.html'), '*');
});
