import { build } from 'esbuild';
import { resolve } from 'node:path';
import { dpdfBindingsPlugin } from './dpdf-bindings-factory.mjs';

const OUT_DIR = 'extension/dist';

await build({
  entryPoints: {
    'separator-frame': 'src/separator/frame.js',
    'separator-worker': 'src/separator/worker.js',
    'filter-worker': 'src/separator/filter-worker.js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outdir: OUT_DIR,
  plugins: [dpdfBindingsPlugin(resolve('vendor/dpdf/dpdf.js'))],
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
