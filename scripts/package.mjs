import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'build/store';
const DEV_ONLY_MATCH = 'http://localhost/*';
const FIREFOX_ID = 'music-filter@highwatersdev';
const REQUIRED = ['extension/dist/read-ahead.js', 'extension/dist/separator-worker.js', 'extension/dist/filter-worker.js', 'extension/dist/popup.js', 'extension/popup.html', 'extension/assets/dpdf_bg.wasm',
  'extension/assets/dpdfnet4.onnx', 'extension/assets/dpdfnet2.onnx', 'extension/icons/icon-128.png'];

for (const file of REQUIRED) {
  if (!existsSync(file)) throw new Error(`${file} is missing. Run npm run fetch:models, build:dpdf and build first.`);
}

const devManifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const { version } = devManifest;
const withoutDevMatches = (entries) =>
  entries.map((entry) => ({ ...entry, matches: entry.matches.filter((match) => match !== DEV_ONLY_MATCH) }));
const storeManifest = {
  ...devManifest,
  content_scripts: withoutDevMatches(devManifest.content_scripts),
  web_accessible_resources: withoutDevMatches(devManifest.web_accessible_resources),
};

const firefoxManifest = {
  ...storeManifest,
  browser_specific_settings: {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  },
};

rmSync(OUT, { recursive: true, force: true });

function stage(name, manifest) {
  const dir = join(OUT, name);
  cpSync('extension', dir, { recursive: true, filter: (source) => !source.endsWith('.DS_Store') });
  cpSync('LICENSE', join(dir, 'LICENSE'));
  cpSync('NOTICE', join(dir, 'NOTICE'));
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (JSON.stringify(manifest).includes('localhost')) throw new Error(`${name} manifest still matches localhost`);
  return dir;
}

function zip(dir, file) {
  execFileSync('zip', ['-q', '-r', '-X', join('..', file), '.'], { cwd: dir });
  return join(OUT, file);
}

const outputs = [
  zip(stage('chromium', storeManifest), `music-filter-chromium-${version}.zip`),
  zip(stage('firefox', firefoxManifest), `music-filter-firefox-${version}.zip`),
];
stage('safari-extension', storeManifest);

if (execFileSync('git', ['status', '--porcelain']).toString().trim()) {
  console.warn('warning: the source zip is built from HEAD, and the working tree has uncommitted changes');
}
const sourceZip = join(OUT, `music-filter-source-${version}.zip`);
execFileSync('git', ['archive', '--format=zip', `--prefix=music-filter-${version}/`, '-o', sourceZip, 'HEAD']);
outputs.push(sourceZip);

for (const file of outputs) console.log(file);
console.log(`${join(OUT, 'safari-extension')} (input for scripts/package-safari.sh)`);
