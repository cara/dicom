// Minimaler statischer Webserver (ohne Abhängigkeiten) für lokalen Betrieb und Entwicklung.
//   node scripts/serve.mjs [verzeichnis] [port]
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startServer(dir, port = 8080, host = process.env.HOST || '127.0.0.1') {
  const base = path.resolve(dir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.normalize(path.join(base, decodeURIComponent(url.pathname)));
      if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
      let st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await stat(file).catch(() => null); }
      if (!st) { res.writeHead(404, { 'content-type': 'text/plain' }).end('404'); return; }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(port, host, () => console.log(`→ http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer(process.argv[2] || 'dist', Number(process.argv[3]) || Number(process.env.PORT) || 8080);
}
