// @vitest-environment node
/**
 * The online party server: protocol, memory store and service, plus one real socket.
 *
 * Everything but the last describe drives the service through fake connections with a captured
 * `send`, a fake clock and a seeded random, so codes, timings and rate limits are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error node:http has no bundled types here (no @types/node — the server is plain JS)
import http from 'node:http';
// @ts-expect-error ws ships no types; the dependency list is deliberately exactly ws + postgres
import WebSocket from 'ws';
import {
  CODE_ALPHABET,
  MAX_CAT_NAME,
  MAX_FRAME,
  MAX_NAME,
  MAX_PARTY,
  makeCode,
  normalizeCode,
  parseClientMessage,
  sanitizeCat,
  sanitizeName,
} from '../server/protocol.mjs';
import { createMemoryStore } from '../server/store-memory.mjs';
import { createPartyService } from '../server/rooms.mjs';
import { attachPartyServer, clientAddress } from '../server/ws.mjs';

type Msg = Record<string, any>;

interface Fake {
  conn: {
    id: string;
    playerId: string | null;
    origin: string;
    ip?: string;
    send(o: Msg): void;
    close(code: number, reason: string): void;
  };
  sent: Msg[];
  closed: Array<{ code: number; reason: string }>;
}

let connSeq = 0;

/** A captured connection. Ids are unique per socket, as they are in ws.mjs. */
function fake(label: string): Fake {
  const sent: Msg[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  return {
    conn: {
      id: `${label}#${++connSeq}`,
      playerId: null,
      origin: 'http://localhost',
      send: (o) => sent.push(o),
      close: (code, reason) => closed.push({ code, reason }),
    },
    sent,
    closed,
  };
}

/** Deterministic random for join codes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (i: number | string): string => `k${i}`.padEnd(43, 'x');
const CAT = { name: 'Mochi', breed: 'snow', outfit: { hat: 'hat-beanie' }, bond: 3 };
const TIMER = {
  mode: 'focus',
  running: true,
  endsAt: 1_700_000_100_000,
  remainingMs: 0,
  round: 1,
  settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsPerLongBreak: 4 },
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

function lastOf(f: Fake, t: string): Msg | undefined {
  for (let i = f.sent.length - 1; i >= 0; i--) if (f.sent[i].t === t) return f.sent[i];
  return undefined;
}
const errorCodes = (f: Fake): string[] => f.sent.filter((m) => m.t === 'error').map((m) => m.code);
const snapshot = (f: Fake): Msg => lastOf(f, 'party')!.party;

/* ---------------------------------------------------------------- protocol */

describe('protocol', () => {
  it('exports the limits from the spec', () => {
    expect(MAX_PARTY).toBe(8);
    expect(MAX_NAME).toBe(14);
    expect(MAX_CAT_NAME).toBe(24);
    expect(MAX_FRAME).toBe(4096);
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTVWXYZ23456789');
  });

  it('rejects junk, oversize and unknown frames with bad-frame', () => {
    for (const text of ['', 'not json', '[]', '42', 'null', '{"t":5}', '{"t":"nope"}', '{"t":"create"}']) {
      const r = parseClientMessage(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('bad-frame');
        expect(r.message).toMatch(/^[a-z]/);
      }
    }
    const big = JSON.stringify({ t: 'ping', echo: 1, pad: 'x'.repeat(MAX_FRAME) });
    expect(parseClientMessage(big)).toMatchObject({ ok: false, code: 'bad-frame' });
  });

  it('accepts well-formed messages and normalises them', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', key: key(1) }))).toEqual({
      ok: true,
      msg: { t: 'hello', key: key(1) },
    });
    expect(parseClientMessage('{"t":"ping","echo":12}')).toEqual({ ok: true, msg: { t: 'ping', echo: 12 } });
    const create = parseClientMessage(JSON.stringify({ t: 'create', room: 'library', name: '  Ana   Lu ', cat: CAT }));
    expect(create).toMatchObject({ ok: true, msg: { t: 'create', room: 'library', name: 'Ana Lu' } });
    const join = parseClientMessage(JSON.stringify({ t: 'join', code: ' ab-cd ef ', name: 'Bo', cat: CAT }));
    expect(join).toMatchObject({ ok: true, msg: { t: 'join', code: 'ABCDEF', name: 'Bo' } });
    expect(parseClientMessage(JSON.stringify({ t: 'timer', timer: TIMER }))).toEqual({ ok: true, msg: { t: 'timer', timer: TIMER } });
    expect(parseClientMessage('{"t":"focus","minutes":-3}')).toMatchObject({ ok: false, code: 'bad-frame' });
    expect(parseClientMessage('{"t":"kick"}')).toMatchObject({ ok: false, code: 'bad-frame' });
    for (const t of ['leave', 'cheer', 'forget']) {
      expect(parseClientMessage(JSON.stringify({ t }))).toEqual({ ok: true, msg: { t } });
    }
  });

  it('sanitises names and cats', () => {
    expect(sanitizeName('  Ana \n  Lu  ')).toBe('Ana Lu');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(MAX_NAME);
    expect(sanitizeName(null)).toBe('');
    expect(sanitizeCat(null)).toBeNull();
    expect(sanitizeCat({ name: '', breed: 'snow', outfit: {}, bond: 1 })).toBeNull();
    expect(sanitizeCat({ name: 'Mo', breed: 'Bad Breed!', outfit: {}, bond: 1 })).toBeNull();
    expect(
      sanitizeCat({
        name: ' M'.repeat(30),
        breed: 'snow',
        outfit: { hat: 'hat-beanie', shoes: 'x', cape: 'not valid!', collar: 7 },
        bond: 99,
      }),
    ).toEqual({ name: 'M M M M M M M M M M M M ', breed: 'snow', outfit: { hat: 'hat-beanie' }, bond: 10 });
    expect(sanitizeCat({ name: 'Mo', breed: 'snow' })).toEqual({ name: 'Mo', breed: 'snow', outfit: {}, bond: 1 });
  });

  it('makes six-character codes from the safe alphabet and normalises input codes', () => {
    const code = makeCode(mulberry32(1));
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect(makeCode(() => 0)).toBe('AAAAAA');
    expect(makeCode(() => 0.999999)).toBe('999999');
    expect(normalizeCode(' ab-c d\tef ')).toBe('ABCDEF');
    expect(normalizeCode(undefined)).toBe('');
  });
});

/* ----------------------------------------------------------------- service */

describe('party service', () => {
  let clock: number;
  let store: ReturnType<typeof createMemoryStore>;
  let service: ReturnType<typeof createPartyService>;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    store = createMemoryStore({ now: () => clock });
    service = createPartyService(store, { now: () => clock, random: mulberry32(7), log: silent });
  });
  afterEach(() => service.stop());

  async function connected(i: number | string): Promise<Fake> {
    const f = fake(`c${i}`);
    service.connect(f.conn);
    await service.handle(f.conn, { t: 'hello', key: key(i) });
    return f;
  }
  async function hosting(i = 0, name = 'Host'): Promise<Fake> {
    const f = await connected(i);
    await service.handle(f.conn, { t: 'create', room: 'library', name, cat: CAT });
    return f;
  }
  async function joined(i: number, code: string, name: string): Promise<Fake> {
    const f = await connected(i);
    await service.handle(f.conn, { t: 'join', code, name, cat: { ...CAT, name: `Cat${i}` } });
    return f;
  }

  it('answers hello with welcome and refuses everything before it', async () => {
    const f = fake('c0');
    service.connect(f.conn);
    await service.handle(f.conn, { t: 'cheer' });
    expect(errorCodes(f)).toEqual(['hello-first']);
    await service.handle(f.conn, { t: 'hello', key: key(0) });
    const welcome = lastOf(f, 'welcome')!;
    expect(typeof welcome.playerId).toBe('string');
    expect(welcome.party).toBeNull();
    expect(welcome.serverNow).toBe(clock);
    expect(f.conn.playerId).toBe(welcome.playerId);
    await service.handle(f.conn, { t: 'ping', echo: 7 });
    expect(lastOf(f, 'pong')).toEqual({ t: 'pong', echo: 7, serverNow: clock });
  });

  it('create: a fresh code and the host seated at seat 0', async () => {
    const h = await hosting();
    const party = snapshot(h);
    expect(party.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(party.room).toBe('library');
    expect(party.hostId).toBe(h.conn.playerId);
    expect(party.members).toEqual([{ id: h.conn.playerId, name: 'Host', cat: CAT, seat: 0, connected: true }]);
    expect(party).toMatchObject({ sharedMinutes: 0, cheers: 0, timer: null });
    expect(await store.openPartyOf(h.conn.playerId!)).toMatchObject({ id: party.id });
  });

  it('join by code is case-insensitive and ignores spaces and dashes', async () => {
    const h = await hosting();
    const code = snapshot(h).code;
    const messy = ` ${code.slice(0, 2).toLowerCase()}-${code.slice(2, 4)} ${code.slice(4).toLowerCase()} `;
    const g = await joined(1, messy, 'Guest');
    expect(errorCodes(g)).toEqual([]);
    expect(snapshot(g).members.map((m: Msg) => [m.name, m.seat])).toEqual([['Host', 0], ['Guest', 1]]);
    // The host was told too.
    expect(snapshot(h).members).toHaveLength(2);
  });

  it('a wrong code is no-such-party, and five of them in a minute rate-limits', async () => {
    const g = await connected(1);
    for (let i = 0; i < 5; i++) await service.handle(g.conn, { t: 'join', code: 'ZZZZZZ', name: 'G', cat: CAT });
    expect(errorCodes(g)).toEqual(Array(5).fill('no-such-party'));
    await service.handle(g.conn, { t: 'join', code: 'ZZZZZZ', name: 'G', cat: CAT });
    expect(errorCodes(g).at(-1)).toBe('rate-limited');
    clock += 61_000;
    await service.handle(g.conn, { t: 'join', code: 'ZZZZZZ', name: 'G', cat: CAT });
    expect(errorCodes(g).at(-1)).toBe('no-such-party');
  });

  it('capacity: the ninth join fails with party-full', async () => {
    const h = await hosting();
    const code = snapshot(h).code;
    for (let i = 1; i < MAX_PARTY; i++) {
      const g = await joined(i, code, `G${i}`);
      expect(errorCodes(g)).toEqual([]);
    }
    expect(snapshot(h).members).toHaveLength(MAX_PARTY);
    const ninth = await joined(9, code, 'G9');
    expect(errorCodes(ninth)).toEqual(['party-full']);
    expect(lastOf(ninth, 'error')!.message).toMatch(/^[a-z]/);
  });

  it('duplicate names are refused case-insensitively', async () => {
    const h = await hosting(0, 'Ana');
    const g = await joined(1, snapshot(h).code, 'aNA');
    expect(errorCodes(g)).toEqual(['name-taken']);
  });

  it('a seated player cannot create or join a second party', async () => {
    const h = await hosting();
    const other = await hosting(1);
    await service.handle(h.conn, { t: 'create', room: 'museum', name: 'Again', cat: CAT });
    await service.handle(h.conn, { t: 'join', code: snapshot(other).code, name: 'Again', cat: CAT });
    expect(errorCodes(h)).toEqual(['already-seated', 'already-seated']);
    expect(snapshot(other).members).toHaveLength(1);
  });

  it('leave frees the seat and tells everyone', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    await service.handle(g.conn, { t: 'leave' });
    expect(lastOf(g, 'left')).toEqual({ t: 'left', reason: 'left' });
    expect(snapshot(h).members.map((m: Msg) => m.name)).toEqual(['Host']);
    expect(await store.openPartyOf(g.conn.playerId!)).toBeNull();
    // Rejoining takes the lowest free seat again.
    await service.handle(g.conn, { t: 'join', code: snapshot(h).code, name: 'Guest', cat: CAT });
    expect(snapshot(g).members.map((m: Msg) => m.seat)).toEqual([0, 1]);
  });

  it('host leaves: the earliest-joined connected member becomes host', async () => {
    const h = await hosting();
    const code = snapshot(h).code;
    const a = await joined(1, code, 'A');
    const b = await joined(2, code, 'B');
    await service.disconnect(a.conn);
    await service.handle(h.conn, { t: 'leave' });
    expect(snapshot(b).hostId).toBe(b.conn.playerId);
    expect(snapshot(b).members.map((m: Msg) => [m.name, m.connected])).toEqual([['A', false], ['B', true]]);
  });

  it('host leaves with everyone connected: the earliest-joined member becomes host', async () => {
    const h = await hosting();
    const code = snapshot(h).code;
    const a = await joined(1, code, 'A');
    const b = await joined(2, code, 'B');
    await service.handle(h.conn, { t: 'leave' });
    expect(snapshot(a).hostId).toBe(a.conn.playerId);
    expect(snapshot(b).hostId).toBe(a.conn.playerId);
  });

  it('last member leaves: the party closes', async () => {
    const h = await hosting();
    const id = snapshot(h).id;
    await service.handle(h.conn, { t: 'leave' });
    expect(await store.openPartyOf(h.conn.playerId!)).toBeNull();
    expect(await store.getParty(id)).toBeNull();
  });

  it('kick by the host rotates the code and sends the kicked player home', async () => {
    const h = await hosting();
    const before = snapshot(h).code;
    const g = await joined(1, before, 'Guest');
    const bystander = await joined(2, before, 'Other');
    await service.handle(h.conn, { t: 'kick', playerId: g.conn.playerId });
    expect(lastOf(g, 'left')).toEqual({ t: 'left', reason: 'kicked' });
    const after = snapshot(h);
    expect(after.code).not.toBe(before);
    expect(after.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(after.members.map((m: Msg) => m.name)).toEqual(['Host', 'Other']);
    expect(snapshot(bystander).code).toBe(after.code);
    expect(await store.openPartyOf(g.conn.playerId!)).toBeNull();
  });

  it('kick by a non-host is not-host', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    await service.handle(g.conn, { t: 'kick', playerId: h.conn.playerId });
    expect(errorCodes(g)).toEqual(['not-host']);
    expect(snapshot(h).members).toHaveLength(2);
  });

  it('cheer increments and broadcasts to everyone', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    await service.handle(g.conn, { t: 'cheer' });
    expect(snapshot(h).cheers).toBe(1);
    expect(snapshot(g).cheers).toBe(1);
    await service.handle(h.conn, { t: 'cheer' });
    expect(snapshot(g).cheers).toBe(2);
    expect((await store.getParty(snapshot(g).id))!.cheers).toBe(2);
  });

  it('timer: only the host sets it, and it is stored and broadcast', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    await service.handle(g.conn, { t: 'timer', timer: TIMER });
    expect(errorCodes(g)).toEqual(['not-host']);
    expect(snapshot(h).timer).toBeNull();
    await service.handle(h.conn, { t: 'timer', timer: TIMER });
    expect(snapshot(g).timer).toEqual(TIMER);
    expect((await store.getParty(snapshot(h).id))!.timer).toEqual(TIMER);
  });

  it('focus credits minutes × connected members, at most once per 30 s', async () => {
    const h = await hosting();
    const code = snapshot(h).code;
    const a = await joined(1, code, 'A');
    const b = await joined(2, code, 'B');
    await service.disconnect(b.conn);
    await service.handle(a.conn, { t: 'focus', minutes: 25 });
    expect(errorCodes(a)).toEqual(['not-host']);
    await service.handle(h.conn, { t: 'focus', minutes: 25 });
    expect(snapshot(h).sharedMinutes).toBe(50);
    expect(snapshot(a).sharedMinutes).toBe(50);
    clock += 10_000;
    await service.handle(h.conn, { t: 'focus', minutes: 25 });
    expect(snapshot(h).sharedMinutes).toBe(50);
    clock += 21_000;
    await service.handle(h.conn, { t: 'focus', minutes: 500 });
    expect(snapshot(h).sharedMinutes).toBe(50 + 120 * 2);
  });

  it('forget deletes the player and their seat', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    const gone = g.conn.playerId!;
    await service.handle(g.conn, { t: 'forget' });
    // No `left` — the client tears down on `forgotten`, and only then drops its key.
    expect(g.sent.some((m) => m.t === 'left')).toBe(false);
    expect(g.sent.at(-1)).toEqual({ t: 'forgotten' });
    expect(await store.openPartyOf(gone)).toBeNull();
    expect(snapshot(h).members.map((m: Msg) => m.name)).toEqual(['Host']);
    // The same device key now registers as a brand-new player.
    const again = await connected(1);
    expect(again.conn.playerId).not.toBe(gone);
    // The forgotten socket has to hello again before doing anything.
    await service.handle(g.conn, { t: 'cheer' });
    expect(errorCodes(g).at(-1)).toBe('hello-first');
  });

  it('forget by a host hands the party to the earliest-joined connected member', async () => {
    const h = await hosting();
    const a = await joined(1, snapshot(h).code, 'A');
    await service.handle(h.conn, { t: 'forget' });
    expect(snapshot(a).hostId).toBe(a.conn.playerId);
    expect(snapshot(a).members).toHaveLength(1);
  });

  it('a second socket for the same player replaces the first', async () => {
    const first = await hosting();
    const partyId = snapshot(first).id;
    const playerId = first.conn.playerId;
    const second = await connected(0);
    expect(lastOf(first, 'left')).toEqual({ t: 'left', reason: 'replaced' });
    expect(first.closed).toHaveLength(1);
    expect(first.conn.playerId).toBeNull();
    expect(second.conn.playerId).toBe(playerId);
    expect(lastOf(second, 'welcome')!.party).toMatchObject({ id: partyId });
    // The old socket going away must not count as the player disconnecting.
    await service.disconnect(first.conn);
    await service.handle(second.conn, { t: 'cheer' });
    expect(snapshot(second).members[0].connected).toBe(true);
  });

  it('a disconnected host is handed over after 60 s when someone else is connected', async () => {
    const h = await hosting();
    const hostId = h.conn.playerId;
    const g = await joined(1, snapshot(h).code, 'Guest');
    await service.disconnect(h.conn);
    expect(h.conn.playerId).toBeNull();
    expect(snapshot(g).members[0].connected).toBe(false);
    clock += 30_000;
    await service.sweep();
    expect(snapshot(g).hostId).toBe(hostId);
    clock += 31_000;
    await service.sweep();
    expect(snapshot(g).hostId).toBe(g.conn.playerId);
  });

  it('a member disconnected for 10 minutes is evicted', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    await service.disconnect(g.conn);
    clock += 9 * 60_000;
    await service.sweep();
    expect(snapshot(h).members).toHaveLength(2);
    clock += 2 * 60_000;
    await service.sweep();
    expect(snapshot(h).members.map((m: Msg) => m.name)).toEqual(['Host']);
    expect(await store.openPartyOf(g.conn.playerId!)).toBeNull();
  });

  it('sweep closes a party older than 12 h and tells its members', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    const id = snapshot(h).id;
    clock += 11 * 3_600_000;
    await service.sweep();
    expect(await store.getParty(id)).not.toBeNull();
    clock += 3_600_000 + 1_000;
    await service.sweep();
    expect(await store.getParty(id)).toBeNull();
    expect(lastOf(h, 'left')).toEqual({ t: 'left', reason: 'closed' });
    expect(lastOf(g, 'left')).toEqual({ t: 'left', reason: 'closed' });
    expect(await store.openPartyOf(h.conn.playerId!)).toBeNull();
  });

  it('store.sweep deletes players idle for 90 days but keeps seated ones', async () => {
    const h = await hosting();
    const hostId = h.conn.playerId!;
    const idle = await connected(5);
    const idleId = idle.conn.playerId;
    await service.disconnect(idle.conn);
    clock += 91 * 24 * 3_600_000;
    await store.touchPlayer(hostId);
    await store.sweep({ now: clock });
    const fresh = await connected(5);
    expect(fresh.conn.playerId).not.toBe(idleId);
    const same = await connected(0);
    expect(same.conn.playerId).toBe(hostId);
  });

  it('a second hello on one socket closes it instead of minting another identity', async () => {
    const f = await connected(0);
    const first = f.conn.playerId;
    await service.handle(f.conn, { t: 'hello', key: key(99) });
    expect(f.closed.at(-1)?.code).toBe(4002);
    expect(f.conn.playerId).toBe(first);
    // Nothing new was minted: the fresh key still registers as a new player later, on its own socket.
    const other = await connected(99);
    expect(other.conn.playerId).not.toBe(first);
  });

  it('wrong codes are limited per address as well as per player', async () => {
    // Five different identities from one address burn the address's allowance together.
    for (let i = 1; i <= 5; i++) {
      const f = fake(`c${i}`);
      f.conn.ip = '10.0.0.7';
      service.connect(f.conn);
      await service.handle(f.conn, { t: 'hello', key: key(i) });
      await service.handle(f.conn, { t: 'join', code: 'ZZZZZZ', name: `P${i}`, cat: CAT });
      expect(errorCodes(f).at(-1)).toBe('no-such-party');
    }
    const sixth = fake('c6');
    sixth.conn.ip = '10.0.0.7';
    service.connect(sixth.conn);
    await service.handle(sixth.conn, { t: 'hello', key: key(6) });
    await service.handle(sixth.conn, { t: 'join', code: 'ZZZZZZ', name: 'P6', cat: CAT });
    expect(errorCodes(sixth).at(-1)).toBe('rate-limited');
    // A different address is unaffected.
    const elsewhere = fake('c7');
    elsewhere.conn.ip = '10.0.0.8';
    service.connect(elsewhere.conn);
    await service.handle(elsewhere.conn, { t: 'hello', key: key(7) });
    await service.handle(elsewhere.conn, { t: 'join', code: 'ZZZZZZ', name: 'P7', cat: CAT });
    expect(errorCodes(elsewhere).at(-1)).toBe('no-such-party');
  });

  it('too many hellos from one address close the socket', async () => {
    for (let i = 0; i < 60; i++) {
      const f = fake(`h${i}`);
      f.conn.ip = '10.0.0.9';
      service.connect(f.conn);
      await service.handle(f.conn, { t: 'hello', key: key(`h${i}`) });
      expect(f.closed).toEqual([]);
    }
    const flood = fake('h60');
    flood.conn.ip = '10.0.0.9';
    service.connect(flood.conn);
    await service.handle(flood.conn, { t: 'hello', key: key('h60') });
    expect(flood.closed.at(-1)?.code).toBe(4003);
    expect(flood.conn.playerId).toBeNull();
  });

  it('two members cheering at the same instant both count', async () => {
    const h = await hosting();
    const g = await joined(1, snapshot(h).code, 'Guest');
    await Promise.all([service.handle(h.conn, { t: 'cheer' }), service.handle(g.conn, { t: 'cheer' })]);
    expect((await store.getParty(snapshot(h).id))!.cheers).toBe(2);
  });

  it('strips control and bidi characters from names before they reach anyone', async () => {
    expect(sanitizeName('A\u202EBC\u0007')).toBe('ABC');
    expect(sanitizeCat({ ...CAT, name: 'Mo\u0000chi' })!.name).toBe('Mochi');
    // The zero-width joiner survives so emoji sequences do.
    expect(sanitizeName('a\u200Db')).toBe('a\u200Db');
  });

  it('validates messages handed to it directly', async () => {
    const h = await hosting();
    await service.handle(h.conn, { t: 'timer', timer: { mode: 'nap' } });
    await service.handle(h.conn, { t: 'bogus' } as Msg);
    expect(errorCodes(h)).toEqual(['bad-frame', 'bad-frame']);
  });
});

/* ------------------------------------------------------------------ socket */

describe('clientAddress', () => {
  const req = (xff: string | undefined, remote = '10.9.9.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });
  it('reads the client just left of the trusted proxy tail', () => {
    // Railway: edge appends the client, the internal router appends the edge — two trusted hops.
    expect(clientAddress(req('203.0.113.7, 10.0.0.2') as any, 2)).toBe('203.0.113.7');
    // Whatever a client prepends sits further left and is never reached.
    expect(clientAddress(req('6.6.6.6, 203.0.113.7, 10.0.0.2') as any, 2)).toBe('203.0.113.7');
    // One trusted hop: the rightmost entry.
    expect(clientAddress(req('6.6.6.6, 203.0.113.7') as any, 1)).toBe('203.0.113.7');
  });
  it('falls back to the peer address without the header', () => {
    expect(clientAddress(req(undefined, '192.168.1.5') as any, 2)).toBe('192.168.1.5');
  });
});

describe('websocket transport', () => {
  let server: any;
  let attached: { close(): void };
  let service: ReturnType<typeof createPartyService>;
  let port: number;

  beforeEach(async () => {
    service = createPartyService(createMemoryStore(), { log: silent });
    server = http.createServer();
    attached = attachPartyServer(server, service, { log: silent });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  afterEach(async () => {
    attached.close();
    service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(path: string, origin?: string): Promise<{ ws: any; status?: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
      ws.on('open', () => resolve({ ws }));
      ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) => resolve({ ws, status: res.statusCode }));
      ws.on('error', (err: Error) => resolve({ ws, status: Number((err.message.match(/\d{3}/) ?? [0])[0]) }));
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
  }

  it('upgrades /party/ws and answers hello with welcome', async () => {
    const { ws, status } = await open('/party/ws', `http://127.0.0.1:${port}`);
    expect(status).toBeUndefined();
    const welcome = await new Promise<Msg>((resolve, reject) => {
      ws.on('message', (data: { toString(): string }) => resolve(JSON.parse(data.toString())));
      ws.on('error', reject);
      ws.send(JSON.stringify({ t: 'hello', key: key('socket') }));
    });
    expect(welcome.t).toBe('welcome');
    expect(welcome.party).toBeNull();
    expect(typeof welcome.playerId).toBe('string');
    ws.close();
  });

  it('refuses other paths and cross-origin upgrades', async () => {
    const wrongPath = await open('/other', `http://127.0.0.1:${port}`);
    expect(wrongPath.status).toBe(404);
    const crossOrigin = await open('/party/ws', 'http://evil.example');
    expect(crossOrigin.status).toBe(403);
  });

  it('closes a socket that sends an oversize frame', async () => {
    const { ws } = await open('/party/ws', `http://127.0.0.1:${port}`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c: number) => resolve(c));
      ws.send('x'.repeat(MAX_FRAME + 1));
    });
    expect(code).toBe(1009);
  });
});
