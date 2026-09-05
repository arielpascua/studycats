/**
 * WebSocket transport for the party service, riding the existing http server.
 *
 * Upgrades only `/party/ws`, only from the same origin (the Origin header's host must equal
 * the request's Host header; a missing Origin is refused unless `PARTY_ALLOW_NO_ORIGIN=1`, an
 * explicit opt-in for local tools rather than a guess from NODE_ENV). At most 32 sockets per
 * address are open at once — enough for a classroom behind one NAT, not enough to matter as a
 * flood. Then, per socket: `hello` within 5 s or the socket is closed, frames over 4 KB close
 * it, a token bucket allows 20 frames per 10 s, and a 30 s ping/pong keepalive terminates
 * clients that vanished without a close frame so they show as disconnected at once rather than
 * when the sweeper notices.
 *
 * The client address comes from `x-forwarded-for`, counted from the RIGHT by the number of
 * trusted proxy hops in front of us (`PARTY_TRUSTED_HOPS`, default 2: Railway's edge appends the
 * client, its internal router appends the edge — observed in production). Entries a client
 * prepends itself sit further left and are never reached, so the address cannot be forged; and
 * when the header carries a different number of hops than configured the server says so once,
 * because a wrong count means every player shares one rate bucket. No header → the peer address.
 *
 * Everything the service needs from a socket is the small `conn` object built here.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { MAX_FRAME, parseClientMessage } from './protocol.mjs';

export const PARTY_PATH = '/party/ws';
const HELLO_TIMEOUT_MS = 5_000;
const PING_EVERY_MS = 30_000;
const BUCKET_CAPACITY = 20;
const BUCKET_WINDOW_MS = 10_000;
/** Overridable in the environment, because the right number depends on what sits in front of us. */
const SOCKETS_PER_ADDRESS = Number(process.env.PARTY_SOCKETS_PER_ADDRESS) || 32;

const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_TOO_BIG = 1009;
const CLOSE_HELLO_TIMEOUT = 4001;

/**
 * Same-origin check on the upgrade request.
 * @param {string | undefined} origin the Origin header
 * @param {string | undefined} host the Host header
 * @param {boolean} allowMissing whether a request without an Origin header may pass
 */
export function sameOrigin(origin, host, allowMissing) {
  if (!origin) return allowMissing;
  if (typeof host !== 'string' || !host) return false;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost.toLowerCase() === host.toLowerCase();
}

/**
 * The address a request came from, as far as it can be trusted. See the header comment.
 * @param {import('node:http').IncomingMessage} req
 */
const TRUSTED_HOPS = Math.max(1, Number(process.env.PARTY_TRUSTED_HOPS) || 2);
let warnedHops = false;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [trustedHops] proxy entries at the right end that are ours, not the client's
 */
export function clientAddress(req, trustedHops = TRUSTED_HOPS) {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof header === 'string' && header.trim()) {
    const hops = header.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length !== trustedHops && !warnedHops) {
      warnedHops = true;
      console.warn(
        `party: x-forwarded-for carries ${hops.length} hops but PARTY_TRUSTED_HOPS is ${trustedHops} — ` +
          'players may be sharing one rate bucket; set it to the real number of proxies',
      );
    }
    // The client is the entry just left of the trusted tail. With fewer entries than trusted
    // hops (a direct connection to a mis-set server) the leftmost is the best there is.
    const pick = hops[Math.max(0, hops.length - trustedHops)];
    if (pick) return pick;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * @param {import('node:http').Server} httpServer
 * @param {ReturnType<import('./rooms.mjs').createPartyService>} service
 * @param {{ log?: { info(...a: any[]): void, warn(...a: any[]): void, error(...a: any[]): void },
 *           helloTimeoutMs?: number, pingEveryMs?: number, allowMissingOrigin?: boolean }} [options]
 * @returns {{ wss: WebSocketServer, close(): void }}
 */
export function attachPartyServer(
  httpServer,
  service,
  {
    log = console,
    helloTimeoutMs = HELLO_TIMEOUT_MS,
    pingEveryMs = PING_EVERY_MS,
    allowMissingOrigin = process.env.PARTY_ALLOW_NO_ORIGIN === '1',
    socketsPerAddress = SOCKETS_PER_ADDRESS,
  } = {},
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  let nextId = 1;
  /** @type {Map<string, number>} address → open sockets */
  const perAddress = new Map();

  /** Answer an upgrade we will not take with a plain HTTP status, then hang up. */
  function refuse(socket, status, text) {
    if (socket.writable) {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    socket.destroy();
  }

  function onUpgrade(req, socket, head) {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== PARTY_PATH) return refuse(socket, 404, 'Not Found');
    if (!sameOrigin(req.headers.origin, req.headers.host, allowMissingOrigin)) {
      log.warn(`party: refused cross-origin upgrade from ${req.headers.origin ?? '(no origin)'}`);
      return refuse(socket, 403, 'Forbidden');
    }
    if ((perAddress.get(clientAddress(req)) ?? 0) >= socketsPerAddress) {
      log.warn(`party: refused upgrade, too many sockets from ${clientAddress(req)}`);
      return refuse(socket, 429, 'Too Many Requests');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws, req) => {
    const ip = clientAddress(req);
    perAddress.set(ip, (perAddress.get(ip) ?? 0) + 1);
    const conn = {
      id: `ws${nextId++}`,
      playerId: null,
      origin: req.headers.origin ?? null,
      ip,
      send(obj) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };

    let tokens = BUCKET_CAPACITY;
    let refilledAt = Date.now();
    let warnedAt = 0;

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const helloTimer = setTimeout(() => {
      if (!conn.playerId) ws.close(CLOSE_HELLO_TIMEOUT, 'hello timeout');
    }, helloTimeoutMs);

    service.connect(conn);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(CLOSE_UNSUPPORTED_DATA, 'text frames only');
      if (data.length > MAX_FRAME) return ws.close(CLOSE_TOO_BIG, 'frame too big');

      const at = Date.now();
      tokens = Math.min(BUCKET_CAPACITY, tokens + ((at - refilledAt) / BUCKET_WINDOW_MS) * BUCKET_CAPACITY);
      refilledAt = at;
      if (tokens < 1) {
        if (at - warnedAt >= BUCKET_WINDOW_MS) {
          warnedAt = at;
          conn.send({ t: 'error', code: 'rate-limited', message: 'slow down — too many messages at once' });
        }
        return;
      }
      tokens -= 1;

      const parsed = parseClientMessage(data.toString('utf8'));
      if (!parsed.ok) return conn.send({ t: 'error', code: parsed.code, message: parsed.message });
      void service.handle(conn, parsed.msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const left = (perAddress.get(ip) ?? 1) - 1;
      if (left > 0) perAddress.set(ip, left);
      else perAddress.delete(ip);
      void service.disconnect(conn);
    });
    ws.on('error', (err) => log.warn(`party: socket ${conn.id}: ${err.message}`));
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, pingEveryMs);
  pinger.unref?.();

  return {
    wss,
    close() {
      clearInterval(pinger);
      httpServer.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
