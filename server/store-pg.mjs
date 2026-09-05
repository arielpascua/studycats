/**
 * The party store on Postgres, via `postgres` (zero transitive dependencies).
 *
 * Applies `server/schema.sql` at boot: the DDL is `create ... if not exists` throughout, so a
 * redeploy or rollback is idempotent. Ids are bigserial in the database and strings on the
 * wire (postgres returns bigint as string; we `String()` anyway so the memory store and this
 * one are indistinguishable to the service).
 *
 * Capacity and one-party-per-player are structural: `joinParty` allocates the lowest free seat
 * inside a transaction holding `for update` on the party row, so exactly one writer decides at
 * a time, and the partial unique indexes (`party_members_seat`, `party_members_one_party`,
 * `parties_open_code`) back that up against anything this code gets wrong.
 *
 * Only `sha256(device key)` ever reaches this file; it is never logged.
 */

import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { MAX_PARTY } from './protocol.mjs';
import { JOIN_MESSAGES, lowestFreeSeat, storeError } from './store-memory.mjs';

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);
const UNIQUE_VIOLATION = '23505';
const PARTY_MAX_AGE = '12 hours';
const PLAYER_IDLE_DAYS = 90;

/**
 * @typedef {import('./store-memory.mjs').PartyRecord} PartyRecord
 * @typedef {import('./store-memory.mjs').JoinResult} JoinResult
 * @typedef {import('./protocol.mjs').CatCard} CatCard
 * @typedef {import('./protocol.mjs').WireTimer} WireTimer
 */

/** @param {string} code @param {string} message */
const fail = (code, message) => ({ ok: false, code, message });

/** Ids come from our own records or from validated messages; a non-numeric one is a bug, not a query. */
function asId(value) {
  const id = String(value);
  if (!/^\d{1,19}$/.test(id)) throw new Error(`not a row id: ${id}`);
  return id;
}

/**
 * @param {any} row a `parties` row
 * @param {any[]} members `party_members` rows, seated only, in join order
 * @returns {PartyRecord}
 */
function toRecord(row, members) {
  return {
    id: String(row.id),
    code: row.code,
    room: row.room,
    hostId: String(row.host_id),
    members: members.map((m) => ({
      id: String(m.player_id),
      name: m.name,
      cat: m.cat,
      seat: Number(m.seat),
      joinedAt: new Date(m.joined_at).getTime(),
    })),
    sharedMinutes: Number(row.shared_minutes),
    cheers: Number(row.cheers),
    timer: row.timer ?? null,
    createdAt: new Date(row.created_at).getTime(),
  };
}

/**
 * Connect, apply the schema, and return the store.
 * @param {string} databaseUrl
 * @param {{ log?: { info(...a: any[]): void }, max?: number }} [options]
 */
export async function createPgStore(databaseUrl, { log = console, max = 5 } = {}) {
  const sql = postgres(databaseUrl, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });

  // No parameters → simple query protocol → several statements in one round trip.
  await sql.unsafe(await readFile(SCHEMA_URL, 'utf8'));
  log.info('party store: postgres schema ready');

  /**
   * @param {any} tx a `sql` or a transaction-scoped one
   * @param {string} partyId
   * @returns {Promise<PartyRecord | null>}
   */
  async function loadParty(tx, partyId) {
    const [row] = await tx`select * from parties where id = ${partyId} and closed_at is null`;
    if (!row) return null;
    const members = await tx`
      select player_id, name, cat, seat, joined_at
      from party_members
      where party_id = ${row.id} and left_at is null
      order by joined_at, seat
    `;
    return toRecord(row, members);
  }

  /** Seat (or re-seat) a member. A returning player reuses their row, as the primary key requires. */
  async function seat(tx, partyId, member, seatNumber) {
    await tx`
      insert into party_members (party_id, player_id, seat, name, cat)
      values (${partyId}, ${asId(member.id)}, ${seatNumber}, ${member.name}, ${sql.json(member.cat)})
      on conflict (party_id, player_id) do update
        set seat = excluded.seat, name = excluded.name, cat = excluded.cat,
            joined_at = now(), left_at = null
    `;
  }

  /** A fragment selecting the players the sweeper may delete. */
  const idlePlayers = (tx, cutoff) => tx`
    select p.id from players p
    where p.last_seen_at < ${cutoff}
      and not exists (select 1 from party_members m where m.player_id = p.id and m.left_at is null)
      and not exists (select 1 from parties x where x.host_id = p.id and x.closed_at is null)
  `;

  return {
    /** @param {Uint8Array} keyHash @returns {Promise<{ id: string }>} */
    async findOrCreatePlayer(keyHash) {
      const [row] = await sql`
        insert into players (key_hash) values (${keyHash})
        on conflict (key_hash) do update set last_seen_at = now()
        returning id
      `;
      return { id: String(row.id) };
    },

    /** @param {string} playerId */
    async touchPlayer(playerId) {
      await sql`update players set last_seen_at = now() where id = ${asId(playerId)}`;
    },

    /** @param {string} playerId @returns {Promise<PartyRecord | null>} */
    async openPartyOf(playerId) {
      const [row] = await sql`
        select party_id from party_members where player_id = ${asId(playerId)} and left_at is null
      `;
      return row ? loadParty(sql, String(row.party_id)) : null;
    },

    /**
     * @param {{ code: string, room: string, hostId: string, timer: WireTimer | null }} fields
     * @param {{ id: string, name: string, cat: CatCard }} member
     * @returns {Promise<PartyRecord>}
     */
    async createParty({ code, room, hostId, timer = null }, member) {
      try {
        return await sql.begin(async (tx) => {
          const [row] = await tx`
            insert into parties (code, room, host_id, timer)
            values (${code}, ${room}, ${asId(hostId)}, ${timer === null ? null : sql.json(timer)})
            returning *
          `;
          await seat(tx, row.id, member, 0);
          return loadParty(tx, String(row.id));
        });
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION) {
          throw err.constraint_name === 'parties_open_code'
            ? storeError('code-taken', 'that code is in use')
            : storeError('already-seated', JOIN_MESSAGES['already-seated']);
        }
        throw err;
      }
    },

    /**
     * @param {string} code already normalised
     * @param {{ id: string, name: string, cat: CatCard }} member
     * @returns {Promise<JoinResult>}
     */
    async joinParty(code, member) {
      const playerId = asId(member.id);
      const lower = member.name.toLowerCase();
      try {
        return await sql.begin(async (tx) => {
          const [row] = await tx`select * from parties where code = ${code} and closed_at is null for update`;
          if (!row) return fail('no-such-party', JOIN_MESSAGES['no-such-party']);
          const [seated] = await tx`select 1 from party_members where player_id = ${playerId} and left_at is null`;
          if (seated) return fail('already-seated', JOIN_MESSAGES['already-seated']);
          const members = await tx`
            select name, seat from party_members where party_id = ${row.id} and left_at is null
          `;
          if (members.length >= MAX_PARTY) return fail('party-full', JOIN_MESSAGES['party-full']);
          if (members.some((m) => m.name.toLowerCase() === lower)) return fail('name-taken', JOIN_MESSAGES['name-taken']);
          await seat(tx, row.id, member, lowestFreeSeat(members.map((m) => Number(m.seat))));
          return { ok: true, party: await loadParty(tx, String(row.id)) };
        });
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION) {
          // Lost a race the row lock should have prevented; report it as the rule it protects.
          return err.constraint_name === 'party_members_one_party'
            ? fail('already-seated', JOIN_MESSAGES['already-seated'])
            : fail('party-full', JOIN_MESSAGES['party-full']);
        }
        throw err;
      }
    },

    /** @param {string} partyId @param {string} playerId @returns {Promise<PartyRecord | null>} */
    async leaveParty(partyId, playerId) {
      const id = asId(partyId);
      await sql`
        update party_members set left_at = now()
        where party_id = ${id} and player_id = ${asId(playerId)} and left_at is null
      `;
      return loadParty(sql, id);
    },

    /** @param {string} partyId @param {string} playerId @returns {Promise<PartyRecord | null>} */
    async setHost(partyId, playerId) {
      const id = asId(partyId);
      await sql`update parties set host_id = ${asId(playerId)} where id = ${id} and closed_at is null`;
      return loadParty(sql, id);
    },

    /** @param {string} partyId */
    async closeParty(partyId) {
      const id = asId(partyId);
      await sql.begin(async (tx) => {
        await tx`update parties set closed_at = now() where id = ${id} and closed_at is null`;
        await tx`update party_members set left_at = now() where party_id = ${id} and left_at is null`;
      });
    },

    /**
     * @param {string} partyId
     * @param {{ timer?: WireTimer | null, sharedMinutes?: number, cheers?: number, code?: string }} patch
     * @returns {Promise<PartyRecord | null>}
     */
    async updateParty(partyId, patch) {
      const id = asId(partyId);
      try {
        await sql.begin(async (tx) => {
          if ('code' in patch) {
            await tx`update parties set code = ${patch.code} where id = ${id} and closed_at is null`;
          }
          if ('timer' in patch) {
            const timer = patch.timer === null ? null : sql.json(patch.timer);
            await tx`update parties set timer = ${timer} where id = ${id} and closed_at is null`;
          }
          if ('sharedMinutes' in patch) {
            const minutes = Math.max(0, Math.floor(Number(patch.sharedMinutes) || 0));
            await tx`update parties set shared_minutes = ${minutes} where id = ${id} and closed_at is null`;
          }
          if ('cheers' in patch) {
            const cheers = Math.max(0, Math.floor(Number(patch.cheers) || 0));
            await tx`update parties set cheers = ${cheers} where id = ${id} and closed_at is null`;
          }
        });
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION) throw storeError('code-taken', 'that code is in use');
        throw err;
      }
      return loadParty(sql, id);
    },

    /** One more cheer, as a single `set cheers = cheers + 1` so concurrent cheers all count. */
    async bumpCheers(partyId) {
      const id = asId(partyId);
      await sql`update parties set cheers = cheers + 1 where id = ${id} and closed_at is null`;
      return loadParty(sql, id);
    },

    /** Credit the hearth in one statement, for the same reason. @param {number} minutes */
    async addSharedMinutes(partyId, minutes) {
      const id = asId(partyId);
      const credit = Math.max(0, Math.floor(Number(minutes) || 0));
      await sql`update parties set shared_minutes = shared_minutes + ${credit} where id = ${id} and closed_at is null`;
      return loadParty(sql, id);
    },

    /** @param {string} partyId @returns {Promise<PartyRecord | null>} */
    async getParty(partyId) {
      return loadParty(sql, asId(partyId));
    },

    /**
     * Delete a player. Their seats are marked left; parties they host pass to the
     * earliest-joined remaining member or close; then every row that references them goes,
     * in foreign-key order, and finally the player.
     * @param {string} playerId
     */
    async forgetPlayer(playerId) {
      const id = asId(playerId);
      await sql.begin(async (tx) => {
        await tx`update party_members set left_at = now() where player_id = ${id} and left_at is null`;
        const hosted = await tx`select id from parties where host_id = ${id} and closed_at is null for update`;
        for (const party of hosted) {
          const [next] = await tx`
            select player_id from party_members
            where party_id = ${party.id} and left_at is null
            order by joined_at, seat limit 1
          `;
          if (next) await tx`update parties set host_id = ${next.player_id} where id = ${party.id}`;
          else await tx`update parties set closed_at = now() where id = ${party.id}`;
        }
        await tx`delete from party_members where player_id = ${id}`;
        await tx`delete from party_members where party_id in (select id from parties where host_id = ${id})`;
        await tx`delete from parties where host_id = ${id}`;
        await tx`delete from players where id = ${id}`;
      });
    },

    /**
     * Storage-shaped housekeeping: parties open longer than 12 h close; players with no seat,
     * hosting nothing open, unseen for 90 days are deleted with everything that references them.
     * @param {{ now?: number }} [options]
     * @returns {Promise<{ closed: string[], deletedPlayers: number }>}
     */
    async sweep({ now = Date.now() } = {}) {
      const at = new Date(now);
      const cutoff = new Date(now - PLAYER_IDLE_DAYS * 24 * 3_600_000);
      return sql.begin(async (tx) => {
        const stale = await tx`
          select id from parties
          where closed_at is null and created_at <= ${at} - ${PARTY_MAX_AGE}::interval
          for update
        `;
        const closed = stale.map((row) => String(row.id));
        if (closed.length) {
          await tx`
            update party_members set left_at = ${at}
            where left_at is null and party_id in (
              select id from parties where closed_at is null and created_at <= ${at} - ${PARTY_MAX_AGE}::interval
            )
          `;
          await tx`
            update parties set closed_at = ${at}
            where closed_at is null and created_at <= ${at} - ${PARTY_MAX_AGE}::interval
          `;
        }

        await tx`delete from party_members where player_id in (${idlePlayers(tx, cutoff)})`;
        await tx`
          delete from party_members where party_id in (
            select id from parties where closed_at is not null and host_id in (${idlePlayers(tx, cutoff)})
          )
        `;
        await tx`delete from parties where closed_at is not null and host_id in (${idlePlayers(tx, cutoff)})`;
        const deleted = await tx`delete from players where id in (${idlePlayers(tx, cutoff)}) returning id`;
        return { closed, deletedPlayers: deleted.length };
      });
    },

    /** Drain the pool. */
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
