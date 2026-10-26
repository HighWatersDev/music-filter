import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { toBindingsFactory } from '../scripts/dpdf-bindings-factory.mjs';

const GLUE = new URL('../vendor/dpdf/dpdf.js', import.meta.url);
const WASM = new URL('../extension/assets/dpdf_bg.wasm', import.meta.url);
const MODEL = new URL('../extension/assets/dpdfnet2.onnx', import.meta.url);
const missing = [GLUE, WASM, MODEL].filter((url) => !existsSync(url));
const skip = missing.length ? `missing ${missing.map((url) => url.pathname).join(', ')}` : false;

const importSource = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// Rust copies the result into the output array through an imported function. A throw there unwinds
// through the wasm frame like a trap, so Rust never releases its borrow of the engine.
class ThrowsOnCopyBack extends Float32Array {
  get buffer() {
    throw new Error('trap mid-hop');
  }
}

test('glue of an unexpected shape is refused', () => {
  assert.throws(() => toBindingsFactory('export function initSync() {}'), /changed shape/);
  assert.throws(
    () => toBindingsFactory("import x from 'y';\nexport class Dpdf {}\nexport { initSync, __wbg_init as default };"),
    /import or export left/,
  );
});

test('a trap mid-hop poisons the instance, and the factory gives a fresh one that works', { skip }, async () => {
  const { default: createBindings } = await importSource(toBindingsFactory(readFileSync(GLUE, 'utf8')));
  const module = new WebAssembly.Module(readFileSync(WASM));
  const model = new Uint8Array(readFileSync(MODEL));
  const input = new Float32Array(160).fill(0.1);
  const output = new Float32Array(160);

  const first = createBindings();
  const firstExports = first.initSync({ module });
  const engine = new first.Dpdf(model);
  engine.process_hop(input, output);
  assert.throws(() => engine.process_hop(input, new ThrowsOnCopyBack(160)), /trap mid-hop/);
  assert.throws(() => engine.process_hop(input, output), /recursive use of an object/);
  assert.equal(first.initSync({ module }), firstExports, 'initSync hands back the poisoned instance');

  const second = createBindings();
  assert.notEqual(second.initSync({ module }).memory, firstExports.memory);
  const fresh = new second.Dpdf(model);
  fresh.process_hop(input, output);
  assert.ok(output.every(Number.isFinite));
});
