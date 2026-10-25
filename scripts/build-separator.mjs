import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

const OUT_DIR = 'extension/dist';
const ORT_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
];

await build({
  entryPoints: {
    'separator-frame': 'src/separator/frame.js',
    'separator-worker': 'src/separator/worker.js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outdir: OUT_DIR,
  // neural-separate and neural-runtime import node: modules only on their Node code paths.
  external: ['node:*'],
  logLevel: 'info',
});

await build({
  entryPoints: { 'read-ahead': 'src/content/read-ahead.js' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outdir: OUT_DIR,
  logLevel: 'info',
});

const require = createRequire(import.meta.url);
mkdirSync(join(OUT_DIR, 'ort'), { recursive: true });
for (const file of ORT_FILES) {
  const source = require.resolve(`onnxruntime-web/${file}`);
  copyFileSync(source, join(OUT_DIR, 'ort', basename(source)));
}
console.log(`copied ${ORT_FILES.length} onnxruntime-web files to ${OUT_DIR}/ort/`);
