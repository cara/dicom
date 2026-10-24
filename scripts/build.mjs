// Baut die App als eine einzige, eigenständige HTML-Datei (funktioniert auch per Doppelklick / file://).
//   node scripts/build.mjs        → dist/
//   node scripts/build.mjs --dev  → Watch-Modus + lokaler Server auf http://localhost:8080
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const dev = process.argv.includes('--dev');

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
let commit = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : '';
if (!commit) {
  try { commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* kein git */ }
}
const version = `${pkg.version}${commit ? ` (${commit})` : ''}`;

// Node-Module, die von den Emscripten-Codecs nur in Node-Umgebungen angefragt werden
const nodeStubs = {
  name: 'node-stubs',
  setup(build) {
    build.onResolve({ filter: /^(fs|path|crypto|ws|worker_threads|module|url)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

const jsOptions = {
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
  loader: { '.wasm': 'binary' },
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'eof',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [nodeStubs],
  write: false,
  logLevel: 'warning',
};

const cssOptions = {
  entryPoints: [path.join(root, 'src/styles.css')],
  bundle: true,
  minify: !dev,
  write: false,
  logLevel: 'warning',
};

const README = `DICOM Cine Viewer – Offline-Version ${version}
=========================================

Start: Datei "dicom-viewer.html" per Doppelklick in Chrome, Edge, Safari oder Firefox öffnen.
Es wird keine Internetverbindung benötigt; alle Daten bleiben auf diesem Rechner.

Tipp: In Chrome/Edge kann der Stapel-Export die Videos direkt in einen
Unterordner "Videos" des geöffneten DICOM-Ordners schreiben.

Kein Medizinprodukt – nicht für die diagnostische Befundung bestimmt.
`;

async function assemble(js, css) {
  const template = await readFile(path.join(root, 'src/index.html'), 'utf8');
  // "</script" im Bundle würde das Script-Tag vorzeitig beenden
  const safeJs = js.replace(/<\/(script)/gi, '<\\/$1');
  const html = template
    .replace('<!--STYLE-->', () => `<style>${css}</style>`)
    .replace('<!--SCRIPT-->', () => `<script>${safeJs}</script>`);
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'index.html'), html);
  await writeFile(path.join(dist, 'dicom-viewer.html'), html);
  await writeFile(path.join(dist, '.nojekyll'), '');
  if (!dev) {
    const zip = zipSync({
      'dicom-viewer/dicom-viewer.html': strToU8(html),
      'dicom-viewer/LIESMICH.txt': strToU8(README),
    });
    await writeFile(path.join(dist, 'dicom-viewer-offline.zip'), zip);
  }
  return html.length;
}

async function buildOnce() {
  const [js, css] = await Promise.all([esbuild.build(jsOptions), esbuild.build(cssOptions)]);
  const size = await assemble(js.outputFiles[0].text, css.outputFiles[0].text);
  console.log(`✓ dist/index.html (${(size / 1024).toFixed(0)} KB) – Version ${version}`);
}

if (!dev) {
  await buildOnce();
} else {
  let css = '';
  let js = '';
  const rebuild = async () => {
    if (js && css) {
      await assemble(js, css);
      console.log(`↻ neu gebaut ${new Date().toLocaleTimeString('de-DE')}`);
    }
  };
  const onEnd = (setter) => ({
    name: 'on-end',
    setup(build) {
      build.onEnd(async (res) => {
        if (res.errors.length) return;
        setter(res.outputFiles[0].text);
        await rebuild();
      });
    },
  });
  const jsCtx = await esbuild.context({ ...jsOptions, plugins: [nodeStubs, onEnd((t) => { js = t; })] });
  const cssCtx = await esbuild.context({ ...cssOptions, plugins: [onEnd((t) => { css = t; })] });
  await Promise.all([jsCtx.watch(), cssCtx.watch()]);
  // HTML-Vorlage beobachten
  const { watch } = await import('node:fs');
  watch(path.join(root, 'src/index.html'), () => rebuild());
  const { startServer } = await import('./serve.mjs');
  startServer(dist, Number(process.env.PORT) || 8080);
}
