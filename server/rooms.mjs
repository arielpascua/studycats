/**
 * The party service: everything between a validated message and the store.
 *
 * It owns the registry of live connections (one per player), folds `connected` into every
 * snapshot, broadcasts a full snapshot to the whole party on every change, and enforces the
 * rules the store cannot see because they are about sockets and time:
 *
 *  - host succession: the earliest-joined connected member takes over when the host leaves,
 *    is kicked, forgets themselves, or has been disconnected for 60 s while someone else is on;
 *  - a member disconnected for 10 minutes is evicted; a party with nobody seated closes;
 *  - a second socket for the same player replaces the first (`left reason:'replaced'`);
 *  - join failures are limited to 5 wrong codes per minute, per player AND per address, so a
 *    fresh key does not buy a fresh allowance;
 *  - one `hello` per socket, and at most 60 hellos per address per 10 minutes: an identity is
 *    free to mint, so minting has to be slow;
 *  - `focus` credits `clamp(minutes, 0, 120) × connected members` at most once per 30 s.
 *
 * Messages for one connection are processed strictly in order (a per-connection promise
 * chain), so `hello` then `create` in one burst cannot race each other.
 *
 * Device keys are hashed on arrival and neither the key nor the hash is ever logged.
 */

import { createHash } from 'node:crypto';
import { makeCode, validateClientMessage } from './protocol.mjs';

const CODE_RE = /^[A-Z2-9]{6}$/;
const SWEEP_EVERY_MS = 30_000;
const HOST_HANDOVER_MS = 60_000;
const EVICT_AFTER_MS = 10 * 60_000;
const FOCUS_COOLDOWN_MS = 30_000;
const FOCUS_MAX_MINUTES = 120;
const JOIN_FAILURE_WINDOW_MS = 60_000;
const JOIN_FAILURES_PER_WINDOW = 5;
const HELLO_WINDOW_MS = 10 * 60_000;
const HELLOS_PER_WINDOW = Number(process.env.PARTY_HELLOS_PER_WINDOW) || 60;
const CODE_ATTEMPTS = 8;
const CLOSE_REPLACED = 4000;
const CLOSE_HELLO_ONCE = 4002;
const CLOSE_HELLO_FLOOD = 4003;

/** User-facing sentences for the errors the service decides. Lower-case, shown verbatim. */
const MESSAGES = {
  'hello-first': 'say hello first — reload the page if this keeps happening',
  'already-seated': 'you are already in a party — leave it first',
  'no-such-party': 'no party has that code — check it and try again',
  'not-host': 'only the host can do that',
  'rate-limited': 'too many wrong codes — wait a minute and try again',
  'bad-frame': 'the app sent something this server does not understand — try reloading',
};

/**
 * @typedef {import('./protocol.mjs').ClientMessage} ClientMessage
 * @typedef {import('./store-memory.mjs').PartyRecord} PartyRecord
 * @typedef {{
 *   id: string, playerId: string | null, origin?: string | null, ip?: string,
 *   send(obj: object): void, close(code: number, reason: string): void,
 * }} Conn
 * @typedef {{ conn: Conn, playerId: string | null, queue: Promise<void> }} ConnState
 * @typedef {{ info(...a: any[]): void, warn(...a: any[]): void, error(...a: any[]): void }} Log
 */

/**
 * sha256 of the device key. The only form of the key the store ever sees.
 * @param {string} key
 * @returns {Uint8Array}
 */
export function hashKey(key) {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * @param {ReturnType<import('./store-memory.mjs').createMemoryStore>} store
 * @param {{ now?: () => number, random?: () => number, log?: Log }} [options]
 */
export function createPartyService(store, { now = () => Date.now(), random = Math.random, log = console } = {}) {
  /** @type {Map<string, ConnState>} conn id → state */
  const conns = new Map();
  /** @type {Map<string, ConnState>} player id → the one live connection */
  const live = new Map();
  /** @type {Map<string, Set<string>>} party id → seated player ids this process has seen */
  const membersOf = new Map();
  /** @type {Map<string, string>} player id → party id */
  const partyOf = new Map();
  /** @type {Map<string, number>} seated player with no socket → since when */
  const offlineSince = new Map();
  /** @type {Map<string, number[]>} player id or `ip:` address → timestamps of recent wrong codes */
  const joinFailures = new Map();
  /** @type {Map<string, number[]>} address → timestamps of recent hellos */
  const hellos = new Map();
  /** @type {Map<string, number>} party id → last credited focus report */
  const lastFocusAt = new Map();
  /** @type {Promise<void> | null} */
  let sweeping = null;

  const interval = setInterval(() => {
    sweep().catch((err) => log.error('party sweep failed:', err));
  }, SWEEP_EVERY_MS);
  interval.unref?.();

  /* ------------------------------------------------------------ registry */

  /** @param {Conn} conn */
  function register(conn) {
    const state = { conn, playerId: null, queue: Promise.resolve() };
    conns.set(conn.id, state);
    conn.playerId = null;
    return state;
  }

  /** @param {PartyRecord} party */
  function remember(party) {
    const previous = membersOf.get(party.id) ?? new Set();
    const current = new Set(party.members.map((m) => m.id));
    for (const id of previous) if (!current.has(id)) forgetSeat(id, party.id);
    for (const m of party.members) {
      partyOf.set(m.id, party.id);
      if (!live.has(m.id) && !offlineSince.has(m.id)) offlineSince.set(m.id, now());
    }
    membersOf.set(party.id, current);
  }

  /** @param {string} playerId @param {string} partyId */
  function forgetSeat(playerId, partyId) {
    if (partyOf.get(playerId) === partyId) partyOf.delete(playerId);
    offlineSince.delete(playerId);
    membersOf.get(partyId)?.delete(playerId);
  }

  /** @param {string} partyId */
  function forgetParty(partyId) {
    for (const id of membersOf.get(partyId) ?? []) {
      if (partyOf.get(id) === partyId) partyOf.delete(id);
      offlineSince.delete(id);
    }
    membersOf.delete(partyId);
    lastFocusAt.delete(partyId);
  }

  /**
   * Detach a socket from its player: after `forget`, a re-`hello`, or being replaced.
   * @param {ConnState} state
   * @param {{ offline: boolean }} options whether the player is now offline (still exists)
   */
  function detachPlayer(state, { offline }) {
    const playerId = state.playerId;
    state.playerId = null;
    state.conn.playerId = null;
    if (!playerId || live.get(playerId) !== state) return;
    live.delete(playerId);
    if (offline && partyOf.has(playerId)) offlineSince.set(playerId, now());
  }

  /* ----------------------------------------------------------- snapshots */

  /** @param {PartyRecord} party */
  function snapshot(party) {
    return {
      id: party.id,
      code: party.code,
      room: party.room,
      hostId: party.hostId,
      members: party.members.map((m) => ({
        id: m.id,
        name: m.name,
        cat: m.cat,
        seat: m.seat,
        connected: live.has(m.id),
      })),
      sharedMinutes: party.sharedMinutes,
      cheers: party.cheers,
      timer: party.timer,
    };
  }

  /** Full snapshot to every connected member. @param {PartyRecord} party */
  function broadcast(party) {
    remember(party);
    const message = { t: 'party', party: snapshot(party), serverNow: now() };
    for (const m of party.members) live.get(m.id)?.conn.send(message);
  }

  /** @param {Conn} conn @param {keyof MESSAGES | string} code @param {string} [message] */
  function sendError(conn, code, message = MESSAGES[code] ?? MESSAGES['bad-frame']) {
    conn.send({ t: 'error', code, message });
  }

  /* ------------------------------------------------------------- helpers */

  /** Earliest-joined connected member, or the earliest-joined member if nobody is on. */
  const pickHost = (party) => party.members.find((m) => live.has(m.id)) ?? party.members[0];

  /**
   * Try up to CODE_ATTEMPTS fresh codes against a store operation that throws `code-taken`.
   * @template T
   * @param {(code: string) => Promise<T>} attempt
   * @returns {Promise<T>}
   */
  async function withFreshCode(attempt) {
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      try {
        return await attempt(makeCode(random));
      } catch (err) {
        if (err?.code !== 'code-taken') throw err;
      }
    }
    throw new Error('no free party code found');
  }

  /**
   * Count the recent timestamps under a key, dropping the stale ones.
   * @param {Map<string, number[]>} map @param {string} key @param {number} windowMs
   */
  function recent(map, key, windowMs) {
    const cutoff = now() - windowMs;
    const kept = (map.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length) map.set(key, kept);
    else map.delete(key);
    return kept.length;
  }

  /** @param {Map<string, number[]>} map @param {string} key */
  function note(map, key) {
    map.set(key, [...(map.get(key) ?? []), now()]);
  }

  /** Wrong codes are counted against the player and against the address they came from. */
  const joinKeys = (state) => [/** @type {string} */ (state.playerId), `ip:${state.conn.ip ?? 'unknown'}`];

  /** @param {ConnState} state */
  function joinLimited(state) {
    return joinKeys(state).some((k) => recent(joinFailures, k, JOIN_FAILURE_WINDOW_MS) >= JOIN_FAILURES_PER_WINDOW);
  }

  /** @param {ConnState} state */
  function noteJoinFailure(state) {
    for (const k of joinKeys(state)) note(joinFailures, k);
  }

  /** The party this player hosts, or null. @param {string} playerId */
  async function hostedParty(playerId) {
    const party = await store.openPartyOf(playerId);
    return party && party.hostId === playerId ? party : null;
  }

  /**
   * After someone's seat is freed: close an empty party, hand over an orphaned one, and tell
   * everyone who is left.
   * @param {PartyRecord | null} party the record after the departure
   * @param {string} partyId
   */
  async function afterDeparture(party, partyId) {
    if (!party || party.members.length === 0) {
      await store.closeParty(partyId);
      forgetParty(partyId);
      log.info(`party ${partyId} closed`);
      return;
    }
    if (!party.members.some((m) => m.id === party.hostId)) {
      const next = pickHost(party);
      party = (await store.setHost(partyId, next.id)) ?? party;
      log.info(`party ${partyId}: player ${next.id} is now host`);
    }
    broadcast(party);
  }

  /* ------------------------------------------------------------ handlers */

  /** @param {ConnState} state @param {{ key: string }} msg */
  async function onHello(state, { key }) {
    // A socket introduces itself once. A second hello is a client minting identities, and the
    // socket is closed rather than answered so the attempt costs a reconnect.
    if (state.playerId) {
      state.conn.close(CLOSE_HELLO_ONCE, 'hello once');
      return;
    }
    const ip = state.conn.ip ?? 'unknown';
    if (recent(hellos, ip, HELLO_WINDOW_MS) >= HELLOS_PER_WINDOW) {
      log.warn(`party: hello flood from ${ip}`);
      state.conn.close(CLOSE_HELLO_FLOOD, 'too many hellos');
      return;
    }
    note(hellos, ip);
    const { id } = await store.findOrCreatePlayer(hashKey(key));

    const previous = live.get(id);
    if (previous && previous !== state) {
      previous.conn.send({ t: 'left', reason: 'replaced' });
      detachPlayer(previous, { offline: false });
      previous.conn.close(CLOSE_REPLACED, 'replaced');
    }

    state.playerId = id;
    state.conn.playerId = id;
    live.set(id, state);
    offlineSince.delete(id);
    await store.touchPlayer(id);

    const party = await store.openPartyOf(id);
    state.conn.send({ t: 'welcome', playerId: id, serverNow: now(), party: party ? snapshot(party) : null });
    if (party) broadcast(party);
  }

  /** @param {ConnState} state @param {{ room: string, name: string, cat: object }} msg */
  async function onCreate(state, { room, name, cat }) {
    const playerId = /** @type {string} */ (state.playerId);
    if (await store.openPartyOf(playerId)) return sendError(state.conn, 'already-seated');
    const party = await withFreshCode((code) =>
      store.createParty({ code, room, hostId: playerId, timer: null }, { id: playerId, name, cat }),
    );
    log.info(`party ${party.id} created by player ${playerId} in ${room}`);
    broadcast(party);
  }

  /** @param {ConnState} state @param {{ code: string, name: string, cat: object }} msg */
  async function onJoin(state, { code, name, cat }) {
    const playerId = /** @type {string} */ (state.playerId);
    if (await store.openPartyOf(playerId)) return sendError(state.conn, 'already-seated');
    if (joinLimited(state)) return sendError(state.conn, 'rate-limited');

    const result = CODE_RE.test(code)
      ? await store.joinParty(code, { id: playerId, name, cat })
      : { ok: false, code: 'no-such-party', message: MESSAGES['no-such-party'] };
    if (!result.ok) {
      if (result.code === 'no-such-party') noteJoinFailure(state);
      return sendError(state.conn, result.code, result.message);
    }
    log.info(`party ${result.party.id}: player ${playerId} joined`);
    broadcast(result.party);
  }

  /** @param {ConnState} state */
  async function onLeave(state) {
    const playerId = /** @type {string} */ (state.playerId);
    const party = await store.openPartyOf(playerId);
    state.conn.send({ t: 'left', reason: 'left' });
    if (!party) return;
    const after = await store.leaveParty(party.id, playerId);
    forgetSeat(playerId, party.id);
    log.info(`party ${party.id}: player ${playerId} left`);
    await afterDeparture(after, party.id);
  }

  /** @param {ConnState} state @param {{ playerId: string }} msg */
  async function onKick(state, { playerId: target }) {
    const playerId = /** @type {string} */ (state.playerId);
    const party = await hostedParty(playerId);
    if (!party) return sendError(state.conn, 'not-host');
    if (target === playerId) return sendError(state.conn, 'bad-frame', 'you cannot send yourself home — leave instead');
    if (!party.members.some((m) => m.id === target)) {
      return sendError(state.conn, 'bad-frame', 'that player is not in your party');
    }
    await store.leaveParty(party.id, target);
    forgetSeat(target, party.id);
    live.get(target)?.conn.send({ t: 'left', reason: 'kicked' });
    // The old code is burnt: whoever was sent home must not walk straight back in.
    const after = await withFreshCode((code) => store.updateParty(party.id, { code }));
    log.info(`party ${party.id}: host sent player ${target} home; code rotated`);
    await afterDeparture(after, party.id);
  }

  /** @param {ConnState} state */
  async function onCheer(state) {
    const playerId = /** @type {string} */ (state.playerId);
    const party = await store.openPartyOf(playerId);
    if (!party) return sendError(state.conn, 'no-such-party', 'you are not in a party — join one first');
    // Atomic in the store: two members cheering in the same instant both count.
    const after = await store.bumpCheers(party.id);
    if (after) broadcast(after);
  }

  /** @param {ConnState} state @param {{ timer: object }} msg */
  async function onTimer(state, { timer }) {
    const party = await hostedParty(/** @type {string} */ (state.playerId));
    if (!party) return sendError(state.conn, 'not-host');
    const after = await store.updateParty(party.id, { timer });
    if (after) broadcast(after);
  }

  /** @param {ConnState} state @param {{ minutes: number }} msg */
  async function onFocus(state, { minutes }) {
    const party = await hostedParty(/** @type {string} */ (state.playerId));
    if (!party) return sendError(state.conn, 'not-host');
    const at = now();
    // A host cannot spam the hearth: one credit per party per 30 s, extras silently dropped.
    if (at - (lastFocusAt.get(party.id) ?? -Infinity) < FOCUS_COOLDOWN_MS) return;
    lastFocusAt.set(party.id, at);
    const connected = Math.max(1, party.members.filter((m) => live.has(m.id)).length);
    const credit = Math.round(Math.min(FOCUS_MAX_MINUTES, Math.max(0, minutes)) * connected);
    const after = await store.addSharedMinutes(party.id, credit);
    if (after) broadcast(after);
  }

  /**
   * Delete the player. The seat is given up quietly (no `left`, or the client would tear down
   * before the acknowledgement), the rows go, and `forgotten` is the one frame the client waits
   * for before it drops its device key — a key dropped early would orphan the rows for 90 days.
   * @param {ConnState} state
   */
  async function onForget(state) {
    const playerId = /** @type {string} */ (state.playerId);
    const party = await store.openPartyOf(playerId);
    if (party) {
      const after = await store.leaveParty(party.id, playerId);
      forgetSeat(playerId, party.id);
      await afterDeparture(after, party.id);
    }
    await store.forgetPlayer(playerId);
    detachPlayer(state, { offline: false });
    joinFailures.delete(playerId);
    state.conn.send({ t: 'forgotten' });
    log.info(`player ${playerId} forgotten`);
  }

  /**
   * @param {ConnState} state
   * @param {unknown} raw
   */
  async function dispatch(state, raw) {
    const parsed = validateClientMessage(raw);
    if (!parsed.ok) return sendError(state.conn, parsed.code, parsed.message);
    const msg = parsed.msg;
    if (msg.t === 'hello') return onHello(state, msg);
    if (!state.playerId) return sendError(state.conn, 'hello-first');
    switch (msg.t) {
      case 'ping':
        return state.conn.send({ t: 'pong', echo: msg.echo, serverNow: now() });
      case 'create':
        return onCreate(state, msg);
      case 'join':
        return onJoin(state, msg);
      case 'leave':
        return onLeave(state);
      case 'kick':
        return onKick(state, msg);
      case 'cheer':
        return onCheer(state);
      case 'timer':
        return onTimer(state, msg);
      case 'focus':
        return onFocus(state, msg);
      case 'forget':
        return onForget(state);
      default:
        return sendError(state.conn, 'bad-frame');
    }
  }

  /** @param {ConnState} state */
  async function onDisconnect(state) {
    conns.delete(state.conn.id);
    const playerId = state.playerId;
    if (!playerId || live.get(playerId) !== state) return; // replaced, forgotten, or never said hello
    detachPlayer(state, { offline: true });
    await store.touchPlayer(playerId);
    const partyId = partyOf.get(playerId);
    if (!partyId) return;
    const party = await store.getParty(partyId);
    if (party) broadcast(party);
    else forgetParty(partyId);
  }

  /* ------------------------------------------------------------- sweeper */

  /** One pass of the time-based rules, then the store's own housekeeping. */
  async function runSweep() {
    const at = now();
    for (const partyId of [...membersOf.keys()]) {
      let party = await store.getParty(partyId);
      if (!party) {
        forgetParty(partyId);
        continue;
      }
      let changed = false;
      for (const m of party.members) {
        const since = offlineSince.get(m.id);
        if (since === undefined || live.has(m.id) || at - since < EVICT_AFTER_MS) continue;
        party = (await store.leaveParty(partyId, m.id)) ?? party;
        forgetSeat(m.id, partyId);
        changed = true;
        log.info(`party ${partyId}: player ${m.id} evicted after ${EVICT_AFTER_MS / 60_000} min offline`);
      }
      if (party.members.length === 0) {
        await store.closeParty(partyId);
        forgetParty(partyId);
        log.info(`party ${partyId} closed`);
        continue;
      }
      const hostSeated = party.members.some((m) => m.id === party.hostId);
      const hostAway = !live.has(party.hostId) && at - (offlineSince.get(party.hostId) ?? at) >= HOST_HANDOVER_MS;
      const othersOn = party.members.some((m) => m.id !== party.hostId && live.has(m.id));
      if ((!hostSeated || hostAway) && othersOn) {
        const next = pickHost(party);
        if (next.id !== party.hostId) {
          party = (await store.setHost(partyId, next.id)) ?? party;
          changed = true;
          log.info(`party ${partyId}: player ${next.id} is now host (previous host away)`);
        }
      }
      if (changed) broadcast(party);
    }

    const { closed = [] } = (await store.sweep({ now: at })) ?? {};
    for (const partyId of closed) {
      for (const playerId of membersOf.get(partyId) ?? []) {
        live.get(playerId)?.conn.send({ t: 'left', reason: 'closed' });
      }
      forgetParty(partyId);
      log.info(`party ${partyId} closed by the sweeper`);
    }
    for (const k of [...joinFailures.keys()]) recent(joinFailures, k, JOIN_FAILURE_WINDOW_MS);
    for (const k of [...hellos.keys()]) recent(hellos, k, HELLO_WINDOW_MS);
  }

  /** Run one sweep now (the interval calls this; tests call it with a fake clock). */
  function sweep() {
    if (!sweeping) {
      sweeping = runSweep().finally(() => {
        sweeping = null;
      });
    }
    return sweeping;
  }

  /* ----------------------------------------------------------------- api */

  return {
    /** A socket has opened. @param {Conn} conn */
    connect(conn) {
      register(conn);
    },

    /**
     * Handle one (untrusted) message for a socket, in order with that socket's other messages.
     * @param {Conn} conn
     * @param {unknown} raw
     * @returns {Promise<void>}
     */
    handle(conn, raw) {
      const state = conns.get(conn.id) ?? register(conn);
      const run = () =>
        dispatch(state, raw).catch((err) => {
          // A store error that names one of our codes (a create that lost a race to a join, say)
          // is the user's answer, not a server fault.
          if (typeof err?.code === 'string' && err.code in MESSAGES) return sendError(conn, err.code);
          log.error(`party: handling a message for ${conn.id} failed:`, err);
          sendError(conn, 'bad-frame', 'something went wrong on the server — try again');
        });
      state.queue = state.queue.then(run, run);
      return state.queue;
    },

    /** The socket has closed. @param {Conn} conn @returns {Promise<void>} */
    disconnect(conn) {
      const state = conns.get(conn.id);
      if (!state) return Promise.resolve();
      const run = () => onDisconnect(state).catch((err) => log.error(`party: disconnect of ${conn.id} failed:`, err));
      state.queue = state.queue.then(run, run);
      return state.queue;
    },

    sweep,

    /** Stop the sweeper interval. */
    stop() {
      clearInterval(interval);
    },
  };
}
