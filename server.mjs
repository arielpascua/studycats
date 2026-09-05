/**
 * Static file server for the built app, plus the online party's WebSocket at /party/ws.
 *
 * Deliberately framework-free: the only runtime dependencies beyond three and zustand are `ws`
 * and `postgres`, both with zero transitive dependencies, and pulling a server framework in
 * just to hand back four files would be the largest dependency in the project.
 *
 * It does two things a naive server would get wrong:
 *  - hashed assets get `immutable` caching, `index.html` gets none, so a redeploy is picked up
 *    immediately instead of being pinned by a stale cached shell;
 *  - an unknown path 404s rather than silently returning index.html. Falling back to the shell
 *    makes a missing asset look like a working page with a blank canvas, which is exactly the
 *    failure that is hardest to spot from the outside.
 *
 * The party lives in `server/`: `DATABASE_URL` set → Postgres, otherwise memory. `/healthz`
 * never touches the database, so a database blip cannot get the container restarted and drop
 * every live socket.
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryStore } from './server/store-memory.mjs';
import { createPartyService } from './server/rooms.mjs';
import { attachPartyServer } from './server/ws.mjs';

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

// Headers every response carries. The page must never be framed (SEND HOME and FORGET ME are
// one tap each), and once it has been reached over https a browser should not try http again.
const HARDENING = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000',
};

/**
 * One bad request must never take the process down: with live parties on the same process, a
 * crash is every socket in every party dropping at once. The handler is wrapped, and anything
 * that still escapes is logged rather than fatal.
 */
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

const server = http.createServer((req, res) => {
  serve(req, res).catch((err) => {
    console.error('request failed:', err);
    if (!res.headersSent) send(res, 500, 'server error', HARDENING);
    else res.end();
  });
});

async function serve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'method not allowed', { allow: 'GET, HEAD', ...HARDENING });
  }

  // Health check for the platform, so an outage is distinguishable from a bad build.
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    return send(res, 200, 'ok', { 'cache-control': 'no-store', ...HARDENING });
  }

  // A malformed escape (`/%E0%A4%A`) throws here. Before the guard that was a fatal unhandled
  // rejection: one curl took the server, and every party on it, down.
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad request', HARDENING);
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT and verify it, so `..` cannot escape the served directory.
  const filePath = join(ROOT, normalize(pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    return send(res, 403, 'forbidden', HARDENING);
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return send(res, 404, 'not found', HARDENING);
  }
  if (info.isDirectory()) return send(res, 404, 'not found', HARDENING);

  const ext = extname(filePath).toLowerCase();
  const headers = {
    'content-type': TYPES.get(ext) ?? 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': HASHED.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...HARDENING,
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

server.listen(PORT, HOST, () => {
  console.log(`study-with-cats serving ${ROOT} on http://${HOST}:${PORT}`);
});

/* ------------------------------------------------------------------ party */

const STORE_BOOT_ATTEMPTS = 5;

/**
 * The party store: Postgres when `DATABASE_URL` is set, memory otherwise. A database that is
 * still coming up gets a few tries before we give up; the connection string is never logged.
 */
async function bootStore() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('party store: memory (no DATABASE_URL)');
    return createMemoryStore();
  }
  const { createPgStore } = await import('./server/store-pg.mjs');
  let lastError;
  for (let attempt = 1; attempt <= STORE_BOOT_ATTEMPTS; attempt++) {
    try {
      const store = await createPgStore(databaseUrl, { log: console });
      console.log('party store: postgres');
      return store;
    } catch (err) {
      lastError = err;
      console.error(`party store: postgres not ready (attempt ${attempt}/${STORE_BOOT_ATTEMPTS}): ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

bootStore()
  .then((store) => {
    const service = createPartyService(store, { log: console });
    attachPartyServer(server, service, { log: console });
    console.log('party server listening for upgrades on /party/ws');
  })
  .catch((err) => {
    console.error('party server failed to start:', err);
    process.exit(1);
  });
