/**
 * Static file server for the built app.
 *
 * Deliberately dependency-free: the whole product ships zero runtime dependencies beyond three
 * and zustand, and pulling a server framework in just to hand back four files would be the
 * largest dependency in the project.
 *
 * It does two things a naive server would get wrong:
 *  - hashed assets get `immutable` caching, `index.html` gets none, so a redeploy is picked up
 *    immediately instead of being pinned by a stale cached shell;
 *  - an unknown path 404s rather than silently returning index.html. Falling back to the shell
 *    makes a missing asset look like a working page with a blank canvas, which is exactly the
 *    failure that is hardest to spot from the outside.
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const PORT = Number(process.env.PORT) || 4318;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
  }),
);

/** Vite emits `name-<hash>.ext`; those are safe to cache forever. */
const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
  }

  // Health check for the platform, so an outage is distinguishable from a bad build.
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    return send(res, 200, 'ok', { 'cache-control': 'no-store' });
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT and verify it, so `..` cannot escape the served directory.
  const filePath = join(ROOT, normalize(pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    return send(res, 403, 'forbidden');
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return send(res, 404, 'not found');
  }
  if (info.isDirectory()) return send(res, 404, 'not found');

  const ext = extname(filePath).toLowerCase();
  const headers = {
    'content-type': TYPES.get(ext) ?? 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': HASHED.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
    // The app makes no network calls of its own, so it can be locked down hard.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`study-with-cats serving ${ROOT} on http://${HOST}:${PORT}`);
});
