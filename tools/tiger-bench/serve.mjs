import { appendFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8791' },
    models: { type: 'string' },
    clips: { type: 'string' },
    results: { type: 'string', default: 'results.jsonl' },
  },
});
if (!values.models || !values.clips) {
  console.error('usage: node serve.mjs --models <dir> --clips <dir> [--port 8791] [--results results.jsonl]');
  process.exit(1);
}

const here = resolve(import.meta.dirname);
const roots = {
  '/models/': resolve(values.models),
  '/clips/': resolve(values.clips),
  '/node_modules/onnxruntime-web/dist/': join(here, 'node_modules/onnxruntime-web/dist'),
  '/': here,
};
const pageFiles = new Set(['/index.html', '/bench.js', '/worker.js', '/dsp.mjs']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.wav': 'audio/wav' };

function resolvePath(pathname) {
  for (const [prefix, dir] of Object.entries(roots)) {
    if (!pathname.startsWith(prefix)) continue;
    if (prefix === '/' && !pageFiles.has(pathname)) return null;
    const file = normalize(join(dir, pathname.slice(prefix.length)));
    return file.startsWith(dir) ? file : null;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // COOP/COEP only on request, so the default run matches the extension (not cross-origin isolated).
  const isolated = url.searchParams.get('isolated') === '1' || (req.headers.referer ?? '').includes('isolated=1');
  const headers = { 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (isolated) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }
  if (req.method === 'POST' && url.pathname === '/report') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      appendFileSync(values.results, body.replace(/\n/g, ' ') + '\n');
      console.log(`report ${body.length} bytes`);
      res.writeHead(204, headers).end();
    });
    return;
  }
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = resolvePath(pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size });
  createReadStream(file).pipe(res);
}).listen(Number(values.port), '127.0.0.1', () => console.log(`http://localhost:${values.port}/`));
