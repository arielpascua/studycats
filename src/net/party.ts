/**
 * The socket to the party server.
 *
 * This module is the only place the app talks to a network, and it is loaded by `import()` from
 * the store on the first START or JOIN tap — never at boot, never when the panel opens — so the
 * solo bundle carries none of it (PRODUCT.md rule 4). Nothing in here decides anything about the
 * party; it moves frames and keeps the socket alive. The decisions live in `core/party-online.ts`
 * and the store, where they can be tested without a server.
 *
 * Identity is an opaque device key: 32 random bytes, base64url, minted the first time this
 * function runs and kept in localStorage under its own key. It never touches the save blob.
 */

import { clockOffsetFrom, type CatCard, type ClockSample, type LeftReason, type OnlineStatus, type PartyHandlers, type PartyLink, type PartySnapshot, type WireTimer } from '../core/party-online';
import type { RoomId } from '../data/rooms';

export type { PartyHandlers, PartyLink, Welcome } from '../core/party-online';

export const DEVICE_KEY_STORAGE = 'study-with-cats:device-key';
const SOCKET_PATH = '/party/ws';
/** Reconnect waits, in order. After the last one fails the link reports `offline` and stops. */
const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];
/** Pings at connect; the offset comes from the one with the shortest round trip. */
const PING_COUNT = 3;
const KEY_BYTES = 32;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LEFT_REASONS: readonly LeftReason[] = ['left', 'kicked', 'closed', 'replaced'];

function isLeftReason(value: unknown): value is LeftReason {
  return typeof value === 'string' && (LEFT_REASONS as readonly string[]).includes(value);
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when this device has ever taken a seat — the only case FORGET ME has anything to do. */
export function hasDeviceKey(): boolean {
  const key = storage()?.getItem(DEVICE_KEY_STORAGE);
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

/** Read the key, minting one the first time. Only ever called from `connectParty`. */
function deviceKey(): string {
  const store = storage();
  const existing = store?.getItem(DEVICE_KEY_STORAGE);
  if (typeof existing === 'string' && KEY_PATTERN.test(existing)) return existing;
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  const key = base64url(bytes);
  store?.setItem(DEVICE_KEY_STORAGE, key);
  return key;
}

function socketUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${SOCKET_PATH}`;
}

export function connectParty(handlers: PartyHandlers): PartyLink {
  const key = deviceKey();

  let ws: WebSocket | null = null;
  let status: OnlineStatus = 'connecting';
  /** Consecutive failed reconnects; reset by a welcome. Indexes BACKOFF_MS. */
  let attempt = 0;
  /** Whether this link has ever been welcomed. Before that, a dropped socket fails fast. */
  let welcomed = false;
  /** Set by close(), by `left reason:'replaced'`, or when the backoff runs out. Nothing after. */
  let terminal = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let offset = 0;
  let samples: ClockSample[] = [];
  const pings = new Map<number, number>();
  let echoSeq = 0;
  /** When `hello` left, so the welcome itself is the first clock sample. */
  let helloSentAt = 0;
  /** A better sample only matters to the store once it moves the clock by this much. */
  const OFFSET_NOTABLE_MS = 250;

  /** Fold a sample in; tell the store when the answer changed enough to re-adopt a deadline. */
  function sample(s: ClockSample): void {
    samples.push(s);
    const next = clockOffsetFrom(samples);
    const moved = Math.abs(next - offset) >= OFFSET_NOTABLE_MS;
    offset = next;
    if (moved && welcomed) handlers.onOffset?.(offset);
  }

  /** Inert once terminal: a handler may close the link mid-frame, and nothing may follow that. */
  function setStatus(next: OnlineStatus): void {
    if (terminal || status === next) return;
    status = next;
    handlers.onStatus(next);
  }

  /** Frames go out only on an open socket. A frame with nowhere to go is dropped, not queued. */
  function send(frame: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  function open(): void {
    if (terminal) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch {
      dropped();
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      if (socket !== ws) return;
      // `hello` must be the first frame; the pings follow so the offset is known before any
      // party frame arrives (the server answers in order).
      samples = [];
      pings.clear();
      helloSentAt = Date.now();
      socket.send(JSON.stringify({ t: 'hello', key }));
      for (let i = 0; i < PING_COUNT; i++) {
        const echo = ++echoSeq;
        pings.set(echo, Date.now());
        socket.send(JSON.stringify({ t: 'ping', echo }));
      }
    });
    socket.addEventListener('message', (event) => {
      if (socket !== ws) return;
      receive(event.data);
    });
    socket.addEventListener('close', () => {
      if (socket !== ws) return;
      ws = null;
      dropped();
    });
    // The close event that follows an error carries the decision; nothing to do here.
    socket.addEventListener('error', () => undefined);
  }

  function receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const f = frame as Record<string, unknown>;
    if (typeof f.t !== 'string') return;

    switch (f.t) {
      case 'welcome': {
        attempt = 0;
        // The welcome answers the hello, so its round trip is a clock sample — and it arrives
        // BEFORE the pongs and before any party frame. Without it a resumed party's deadline
        // would be adopted with an offset of zero.
        if (helloSentAt > 0) sample({ sentAt: helloSentAt, receivedAt: Date.now(), serverNow: Number(f.serverNow) });
        welcomed = true;
        const party = f.party && typeof f.party === 'object' ? (f.party as PartySnapshot) : null;
        handlers.onWelcome({ playerId: String(f.playerId ?? ''), serverNow: Number(f.serverNow) || 0, party });
        setStatus('online');
        return;
      }
      case 'pong': {
        const echo = Number(f.echo);
        const sentAt = pings.get(echo);
        if (sentAt === undefined) return;
        pings.delete(echo);
        sample({ sentAt, receivedAt: Date.now(), serverNow: Number(f.serverNow) });
        return;
      }
      case 'forgotten': {
        // The server has deleted our rows. Only now does the key go: dropping it before the
        // acknowledgement would orphan the rows for ninety days. Nothing may follow this.
        storage()?.removeItem(DEVICE_KEY_STORAGE);
        terminal = true;
        handlers.onLeft('left');
        return;
      }
      case 'party': {
        if (!f.party || typeof f.party !== 'object') return;
        handlers.onSnapshot(f.party as PartySnapshot, Number(f.serverNow) || 0);
        return;
      }
      case 'left': {
        const reason = isLeftReason(f.reason) ? f.reason : 'left';
        // A newer socket for this player took over. Reconnecting would only take it back.
        if (reason === 'replaced') terminal = true;
        handlers.onLeft(reason);
        return;
      }
      case 'error': {
        handlers.onError(String(f.code ?? 'error'), String(f.message ?? 'something went wrong'));
        return;
      }
      default:
        return;
    }
  }

  /** The socket went away without close() being called. */
  function dropped(): void {
    if (terminal) return;
    // A link that never got in fails fast: the player is looking at a button and wants an
    // answer, not thirty seconds of retries.
    if (!welcomed || attempt >= BACKOFF_MS.length) {
      setStatus('offline');
      terminal = true;
      return;
    }
    setStatus('reconnecting');
    const delay = BACKOFF_MS[attempt++];
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  open();

  return {
    create(room: RoomId, name: string, cat: CatCard) {
      send({ t: 'create', room, name, cat });
    },
    join(code: string, name: string, cat: CatCard) {
      send({ t: 'join', code, name, cat });
    },
    leave() {
      send({ t: 'leave' });
    },
    kick(playerId: string) {
      send({ t: 'kick', playerId });
    },
    cheer() {
      send({ t: 'cheer' });
    },
    setTimer(timer: WireTimer) {
      send({ t: 'timer', timer });
    },
    reportFocus(minutes: number) {
      send({ t: 'focus', minutes });
    },
    forget() {
      // The key is dropped on the server's `forgotten`, not here: an ask lost on a dying socket
      // must leave the key in place so the player can try again.
      return send({ t: 'forget' });
    },
    close() {
      terminal = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const socket = ws;
      ws = null;
      if (socket) socket.close();
      status = 'offline';
    },
    offset() {
      return offset;
    },
  };
}
