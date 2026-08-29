/**
 * Find a genuinely free port on Windows.
 *
 * A bind probe (`server.listen`) is NOT reliable here: on Windows, binding 127.0.0.1 succeeds
 * even when another process already holds 0.0.0.0 on the same port, so a bind check reports
 * "free" and you end up measuring somebody else's server. Connect instead, and treat
 * ECONNREFUSED as the only proof that nothing is listening.
 */

import net from 'node:net';

export function probe(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (free) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(false)); // something answered → occupied
    socket.once('timeout', () => done(false)); // filtered → treat as occupied
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED'));
    socket.connect(port, host);
  });
}

export async function findFreePort(start = 4318, tries = 40) {
  for (let port = start; port < start + tries; port++) {
    if (await probe(port)) return port;
  }
  throw new Error(`no free port in ${start}..${start + tries}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  findFreePort(Number(process.argv[2]) || 4318)
    .then((p) => {
      process.stdout.write(String(p));
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
