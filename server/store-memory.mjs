/**
 * The party store, in memory. Used by the tests and by local runs without `DATABASE_URL`.
 *
 * Same interface and the same rules as store-pg.mjs: one party per player, capacity 8, names
 * unique within a party case-insensitively, lowest free seat, closed parties invisible. Every
 * record handed out is a copy, so callers cannot mutate the store by accident.
 *
 * Ids are strings ("1", "2", …) to match what Postgres bigserial columns look like on the wire.
 */

import { MAX_PARTY } from './protocol.mjs';

const PARTY_MAX_AGE_MS = 12 * 3_600_000;
const PLAYER_IDLE_MS = 90 * 24 * 3_600_000;

/**
 * @typedef {import('./protocol.mjs').CatCard} CatCard
 * @typedef {import('./protocol.mjs').WireTimer} WireTimer
 * @typedef {{ id: string, name: string, cat: CatCard, seat: number, joinedAt: number }} MemberRecord
 * @typedef {{
 *   id: string, code: string, room: string, hostId: string, members: MemberRecord[],
 *   sharedMinutes: number, cheers: number, timer: WireTimer | null, createdAt: number,
 * }} PartyRecord
 * @typedef {{ ok: true, party: PartyRecord } | { ok: false, code: string, message: string }} JoinResult
 */

/** @param {string} code @param {string} message */
const fail = (code, message) => ({ ok: false, code, message });

/**
 * An error a caller can branch on (`err.code`), thrown where the interface has no result slot.
 * @param {string} code
 * @param {string} message
 */
export function storeError(code, message) {
  const err = new Error(message);
  // @ts-ignore — a plain tag on a plain Error.
  err.code = code;
  return err;
}

/** Lowest seat not in use. Seats are 0..MAX_PARTY-1; the caller has checked capacity. */
export function lowestFreeSeat(taken) {
  const used = new Set(taken);
  for (let seat = 0; seat < MAX_PARTY; seat++) if (!used.has(seat)) return seat;
  return -1;
}

/** The user-facing sentences for the join failures the store decides. */
export const JOIN_MESSAGES = {
  'no-such-party': 'no party has that code — check it and try again',
  'already-seated': 'you are already in a party — leave it first',
  'party-full': `that party is full — a party seats ${MAX_PARTY}`,
  'name-taken': 'someone in that party already has that name — try a different one',
};

/**
 * @param {{ now?: () => number }} [options]
 */
export function createMemoryStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { id: string, hash: string, createdAt: number, lastSeenAt: number }>} */
  const players = new Map();
  /** @type {Map<string, string>} hash → player id */
  const byHash = new Map();
  /** @type {Map<string, any>} party id → internal party (members include left ones) */
  const parties = new Map();
  let nextPlayerId = 1;
  let nextPartyId = 1;

  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const seatedOf = (party) => party.members.filter((m) => m.leftAt === null);
  const openParties = () => [...parties.values()].filter((p) => p.closedAt === null);
  const openById = (id) => {
    const party = parties.get(String(id));
    return party && party.closedAt === null ? party : null;
  };
  const openByCode = (code) => openParties().find((p) => p.code === code) ?? null;
  const partyOfPlayer = (playerId) => {
    const id = String(playerId);
    return openParties().find((p) => seatedOf(p).some((m) => m.id === id)) ?? null;
  };

  /** @returns {PartyRecord} */
  const record = (party) => ({
    id: party.id,
    code: party.code,
    room: party.room,
    hostId: party.hostId,
    members: seatedOf(party).map((m) => ({
      id: m.id,
      name: m.name,
      cat: structuredClone(m.cat),
      seat: m.seat,
      joinedAt: m.joinedAt,
    })),
    sharedMinutes: party.sharedMinutes,
    cheers: party.cheers,
    timer: party.timer === null ? null : structuredClone(party.timer),
    createdAt: party.createdAt,
  });

  const seatMember = (party, member, seat) => {
    // A player who left and comes back reuses their row, as the Postgres primary key forces.
    party.members = party.members.filter((m) => m.id !== String(member.id));
    party.members.push({
      id: String(member.id),
      name: member.name,
      cat: structuredClone(member.cat),
      seat,
      joinedAt: now(),
      leftAt: null,
    });
  };

  const closeNow = (party, at = now()) => {
    party.closedAt = at;
    for (const m of party.members) if (m.leftAt === null) m.leftAt = at;
  };

  /** Drop every row that references a player, then the player. Mirrors the FK order in Postgres. */
  const deletePlayerRows = (playerId) => {
    for (const party of [...parties.values()]) {
      party.members = party.members.filter((m) => m.id !== playerId);
      if (party.closedAt !== null && party.hostId === playerId) parties.delete(party.id);
    }
    const player = players.get(playerId);
    if (player) {
      byHash.delete(player.hash);
      players.delete(playerId);
    }
  };

  return {
    /** @param {Uint8Array} keyHash @returns {Promise<{ id: string }>} */
    async findOrCreatePlayer(keyHash) {
      const hash = hex(keyHash);
      let id = byHash.get(hash);
      if (id === undefined) {
        id = String(nextPlayerId++);
        players.set(id, { id, hash, createdAt: now(), lastSeenAt: now() });
        byHash.set(hash, id);
      } else {
        players.get(id).lastSeenAt = now();
      }
      return { id };
    },

    /** @param {string} playerId */
    async touchPlayer(playerId) {
      const player = players.get(String(playerId));
      if (player) player.lastSeenAt = now();
    },

    /** @param {string} playerId @returns {Promise<PartyRecord | null>} */
    async openPartyOf(playerId) {
      const party = partyOfPlayer(playerId);
      return party ? record(party) : null;
    },

    /**
     * @param {{ code: string, room: string, hostId: string, timer: WireTimer | null }} fields
     * @param {{ id: string, name: string, cat: CatCard }} member
     * @returns {Promise<PartyRecord>}
     */
    async createParty({ code, room, hostId, timer = null }, member) {
      if (openByCode(code)) throw storeError('code-taken', 'that code is in use');
      if (partyOfPlayer(member.id)) throw storeError('already-seated', JOIN_MESSAGES['already-seated']);
      const party = {
        id: String(nextPartyId++),
        code,
        room,
        hostId: String(hostId),
        sharedMinutes: 0,
        cheers: 0,
        timer: timer === null ? null : structuredClone(timer),
        createdAt: now(),
        closedAt: null,
        members: [],
      };
      seatMember(party, member, 0);
      parties.set(party.id, party);
      return record(party);
    },

    /**
     * @param {string} code already normalised
     * @param {{ id: string, name: string, cat: CatCard }} member
     * @returns {Promise<JoinResult>}
     */
    async joinParty(code, member) {
      const party = openByCode(code);
      if (!party) return fail('no-such-party', JOIN_MESSAGES['no-such-party']);
      if (partyOfPlayer(member.id)) return fail('already-seated', JOIN_MESSAGES['already-seated']);
      const seated = seatedOf(party);
      if (seated.length >= MAX_PARTY) return fail('party-full', JOIN_MESSAGES['party-full']);
      const lower = member.name.toLowerCase();
      if (seated.some((m) => m.name.toLowerCase() === lower)) return fail('name-taken', JOIN_MESSAGES['name-taken']);
      seatMember(party, member, lowestFreeSeat(seated.map((m) => m.seat)));
      return { ok: true, party: record(party) };
    },

    /** @param {string} partyId @param {string} playerId @returns {Promise<PartyRecord | null>} */
    async leaveParty(partyId, playerId) {
      const party = openById(partyId);
      if (!party) return null;
      const member = party.members.find((m) => m.id === String(playerId) && m.leftAt === null);
      if (member) member.leftAt = now();
      return record(party);
    },

    /** @param {string} partyId @param {string} playerId @returns {Promise<PartyRecord | null>} */
    async setHost(partyId, playerId) {
      const party = openById(partyId);
      if (!party) return null;
      party.hostId = String(playerId);
      return record(party);
    },

    /** @param {string} partyId */
    async closeParty(partyId) {
      const party = openById(partyId);
      if (party) closeNow(party);
    },

    /**
     * @param {string} partyId
     * @param {{ timer?: WireTimer | null, sharedMinutes?: number, cheers?: number, code?: string }} patch
     * @returns {Promise<PartyRecord | null>}
     */
    async updateParty(partyId, patch) {
      const party = openById(partyId);
      if (!party) return null;
      if ('code' in patch) {
        const clash = openByCode(patch.code);
        if (clash && clash !== party) throw storeError('code-taken', 'that code is in use');
        party.code = patch.code;
      }
      if ('timer' in patch) party.timer = patch.timer === null ? null : structuredClone(patch.timer);
      if ('sharedMinutes' in patch) party.sharedMinutes = Math.max(0, Math.floor(Number(patch.sharedMinutes) || 0));
      if ('cheers' in patch) party.cheers = Math.max(0, Math.floor(Number(patch.cheers) || 0));
      return record(party);
    },

    /** One more cheer, atomically. @param {string} partyId @returns {Promise<PartyRecord | null>} */
    async bumpCheers(partyId) {
      const party = openById(partyId);
      if (!party) return null;
      party.cheers += 1;
      return record(party);
    },

    /** Credit the hearth, atomically. @param {string} partyId @param {number} minutes */
    async addSharedMinutes(partyId, minutes) {
      const party = openById(partyId);
      if (!party) return null;
      party.sharedMinutes += Math.max(0, Math.floor(Number(minutes) || 0));
      return record(party);
    },

    /** @param {string} partyId @returns {Promise<PartyRecord | null>} */
    async getParty(partyId) {
      const party = openById(partyId);
      return party ? record(party) : null;
    },

    /**
     * Delete a player: their seats are marked left, parties they host go to the earliest-joined
     * remaining member or close, and every row that mentions them goes.
     * @param {string} playerId
     */
    async forgetPlayer(playerId) {
      const id = String(playerId);
      for (const party of openParties()) {
        const seat = seatedOf(party).find((m) => m.id === id);
        if (seat) seat.leftAt = now();
        if (party.hostId !== id) continue;
        const rest = seatedOf(party);
        if (rest.length === 0) closeNow(party);
        else party.hostId = rest[0].id;
      }
      deletePlayerRows(id);
    },

    /**
     * Storage-shaped housekeeping: parties open longer than 12 h close; players with no seat,
     * hosting nothing open, unseen for 90 days are deleted.
     * @param {{ now?: number }} [options]
     * @returns {Promise<{ closed: string[], deletedPlayers: number }>}
     */
    async sweep({ now: at = now() } = {}) {
      const closed = [];
      for (const party of openParties()) {
        if (at - party.createdAt >= PARTY_MAX_AGE_MS) {
          closeNow(party, at);
          closed.push(party.id);
        }
      }
      let deletedPlayers = 0;
      const cutoff = at - PLAYER_IDLE_MS;
      for (const player of [...players.values()]) {
        if (player.lastSeenAt >= cutoff) continue;
        const busy = openParties().some(
          (p) => p.hostId === player.id || seatedOf(p).some((m) => m.id === player.id),
        );
        if (busy) continue;
        deletePlayerRows(player.id);
        deletedPlayers++;
      }
      return { closed, deletedPlayers };
    },

    async close() {},
  };
}
