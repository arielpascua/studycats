# Online party — design of record

**Status:** locked 2026-09-05. Synthesised from the four hardened architectures the design
workflow produced on 2026-09-04 (r7–r10 in that run's journal) and the owner's decisions across
this project: real online play, no account unless one is needed, self-hosted on the existing
Railway project, Railway Postgres, one cat per person, join codes.

## 1. What it is

A host taps START A PARTY, picks a room and the one cat they are bringing, and gets a six-letter
code. Friends on their own devices tap JOIN, type the code, pick their one cat, and appear in the
host's room live. Everyone sees everyone's cat, name and outfit. Everyone studies to the host's
clock. Each finished focus session feeds the room's hearth for the whole party. Anyone can cheer.
Leaving is one tap; the host can end the party or send someone home.

Single player is untouched: no network call, no account, no networking code in the bundle until
the first START or JOIN tap (PRODUCT.md rule 4 and the 2026-08-30 amendment).

## 2. Non-goals (v1)

- No email, password, username or profile. Identity is an opaque device key.
- No chat, no voice, no friend lists, no public party browser, no spectators.
- No per-member timers: the host runs the clock; members follow.
- No cross-party persistence of anything but the player row.
- The offline cat-card party stays as the fallback and is not redesigned.

## 3. Identity

- On the first START or JOIN tap, the client generates 32 random bytes with
  `crypto.getRandomValues`, base64url-encodes them (43 chars) and stores them under
  `localStorage['study-with-cats:device-key']`. **Never** in the save blob, never in an export.
- The server stores only `sha256(key)`; the key itself is a bearer secret and is never logged.
- `{t:'forget'}` deletes the player's rows; the client then deletes the key. That is "delete my
  account" and the party panel offers it as FORGET ME ON THE SERVER.

## 4. Transport and protocol

One WebSocket at `/party/ws` on the existing `web` service (same origin, so no CORS and the
client derives the URL from `location`). JSON text frames, max 4 KB. The first frame must be
`hello` within 5 s or the socket is closed. The server sends **full snapshots** on every change:
parties hold at most 8 members, so a snapshot is under 2 KB and there is nothing to reconcile.

### Client → server

| t | fields | who |
|---|---|---|
| `hello` | `key` | first frame |
| `ping` | `echo: number` | anyone; for clock offset |
| `create` | `room: RoomId`, `name`, `cat: CatCard` | not in a party |
| `join` | `code`, `name`, `cat: CatCard` | not in a party |
| `leave` | — | member |
| `kick` | `playerId` | host |
| `cheer` | — | member |
| `timer` | `timer: WireTimer` | host |
| `focus` | `minutes: number` | host, once per finished focus session |
| `forget` | — | anyone; deletes the player |

### Server → client

| t | fields |
|---|---|
| `welcome` | `playerId`, `serverNow`, `party: PartySnapshot \| null` (non-null = you are already seated: resume) |
| `pong` | `echo`, `serverNow` |
| `party` | `party: PartySnapshot`, `serverNow` |
| `left` | `reason: 'left' \| 'kicked' \| 'closed' \| 'replaced'` |
| `error` | `code`, `message` (user-facing, lower-case, the panel shows it verbatim) |

### Shapes

```ts
type CatCard = { name: string /* 1..24 */; breed: string /* [a-z0-9-]{1,24} */; outfit: Record<string,string> /* keys hat|collar|cape|charm, values [A-Za-z0-9_-]{1,32} */; bond: number /* 1..10 int */ };
type WireTimer = {
  mode: 'idle'|'focus'|'shortBreak'|'longBreak'; running: boolean;
  endsAt: number | null;      // SERVER epoch ms, only meaningful while running
  remainingMs: number;        // meaningful while paused/idle
  round: number;              // 0..8
  settings: { focusMin: number; shortBreakMin: number; longBreakMin: number; roundsPerLongBreak: number };
};
type PartySnapshot = {
  id: string; code: string; room: RoomId; hostId: string;
  members: Array<{ id: string; name: string; cat: CatCard; seat: number; connected: boolean }>;
  sharedMinutes: number; cheers: number; timer: WireTimer | null;
};
```

The server validates **shape and length** only (it does not know breed ids or cosmetic ids);
every client re-sanitises what it receives with the existing `normalizeParty`/`sanitizeOutfit`
rules, so an unknown breed becomes an ordinary guest failure, never a crash.

### Join codes

Six characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no I, L, O, U, 0, 1). Unique among open
parties (partial unique index). Compared case-insensitively after stripping spaces and dashes.
A kick rotates the code.

### Clock

`offset = localNow − serverNow`, taken from the `pong` with the smallest round trip out of three
pings at connect. A member's local deadline is `wire.endsAt + offset` (a fast local clock pushes
the deadline later, r8's sign fix). The host converts the other way when publishing.

## 5. Server

Plain ESM JavaScript under `server/`, no build step, two runtime dependencies (`ws`, `postgres`),
both with zero transitive dependencies. `server.mjs` keeps serving `dist/` exactly as today and
gains one upgrade handler for `/party/ws`. `/healthz` never touches the database (a database
blip must not restart the container and drop every live socket).

| file | role |
|---|---|
| `server/protocol.mjs` | pure: `parseClientMessage(text)` → typed message or `{error}`; `sanitizeName`, `sanitizeCat`, `normalizeCode`, `makeCode(random)`, limits |
| `server/store-memory.mjs` | the store interface in memory (tests, and local runs without `DATABASE_URL`) |
| `server/store-pg.mjs` | the same interface on Postgres via `postgres`; applies `server/schema.sql` at boot (idempotent DDL) |
| `server/rooms.mjs` | `createPartyService(store, { now, random, send })`: hello/create/join/leave/kick/cheer/setTimer/reportFocus/forget/disconnect, the party→sockets registry, snapshot broadcast, host succession, the sweeper |
| `server/ws.mjs` | `attachPartyServer(httpServer, service)`: `ws` upgrade on `/party/ws`, same-origin check, hello timeout, per-socket rate limit (20 frames / 10 s), 4 KB frame cap, 30 s ping keepalive |

Store selection: `DATABASE_URL` set → Postgres; unset → memory, with one boot log line saying so.

### Schema (`server/schema.sql`)

```sql
create table if not exists players (
  id           bigserial primary key,
  key_hash     bytea not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table if not exists parties (
  id             bigserial primary key,
  code           text not null check (code ~ '^[A-Z2-9]{6}$'),
  room           text not null check (char_length(room) between 1 and 24),
  host_id        bigint not null references players(id),
  shared_minutes integer not null default 0 check (shared_minutes >= 0),
  cheers         integer not null default 0 check (cheers >= 0),
  timer          jsonb,
  created_at     timestamptz not null default now(),
  closed_at      timestamptz
);
create unique index if not exists parties_open_code on parties (code) where closed_at is null;
create table if not exists party_members (
  party_id  bigint not null references parties(id),
  player_id bigint not null references players(id),
  seat      smallint not null check (seat between 0 and 7),
  name      text not null check (char_length(name) between 1 and 14),
  cat       jsonb not null,
  joined_at timestamptz not null default now(),
  left_at   timestamptz,
  primary key (party_id, player_id)
);
create unique index if not exists party_members_seat      on party_members (party_id, seat) where left_at is null;
create unique index if not exists party_members_one_party on party_members (player_id)      where left_at is null;
```

Capacity and one-party-per-player are structural: the seat is the lowest free seat allocated
inside a transaction with `for update` on the party row, and `check (seat between 0 and 7)`
makes a ninth member impossible. Connection state is not in the database; it lives in the
registry and is folded into snapshots.

### Rules the service enforces

- One party per player at a time (the partial unique index; `create`/`join` while seated → error).
- Names unique within a party, case-insensitively (same rule as `addMember`).
- `timer` and `focus` from a non-host → `error 'not-host'`. `kick` from a non-host → same.
- `focus`: `sharedMinutes += clamp(minutes, 0, 120) × connectedMembers`, at most once per
  30 seconds per party (a host cannot spam the hearth).
- Host succession: when the host leaves, is kicked, or has been disconnected for 60 s while
  someone else is connected, the earliest-joined connected member becomes host (one `update`),
  and a snapshot goes out. A party with nobody seated closes.
- The sweeper (every 30 s): members disconnected for 10 min are marked left; parties open for 12 h
  close; players with no seat and `last_seen_at` older than 90 days are deleted.
- Two sockets for one player: the newer wins, the older gets `left reason:'replaced'` and must
  **not** reconnect on that reason.
- Join failures are rate-limited per player: 5 wrong codes per minute.

## 6. Client

| file | owner | role |
|---|---|---|
| `src/net/party.ts` | net | `connectParty(handlers)` → `PartyLink`; device key; hello/resume; reconnect with backoff 1,2,4,8,16 s then `offline`; clock offset; **loaded only via dynamic `import()`** from the store so the solo bundle carries none of it |
| `src/core/party-online.ts` | net | pure, tested: `toWireTimer`, `adoptRemoteTimer`, `snapshotToParty`, `clockOffsetFrom`, `onlineBonfireGoal` |
| `src/core/party.ts` | net | `bonfireProgress` gains an optional `goal` argument (default unchanged) |
| `src/core/events.ts` | net | `'party:changed': { status: OnlineStatus }` |
| `src/store.ts`, `src/main.ts`, `vite.config.ts` | net | runtime + actions below; dev proxy for `/party` |
| `src/ui/party.ts`, `src/ui/hud.ts`, `src/style.css` | ui | the panel and the HUD's "host runs the clock" state |

### Store contract (what the UI builds against)

```ts
type OnlineStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';
interface OnlineState {
  status: OnlineStatus;
  playerId: string | null;
  partyId: string | null;
  code: string | null;
  hostId: string | null;
  isHost: boolean;
  /** Last error message from the server, cleared on the next successful action. */
  error: string | null;
}
// Game gains:
online(): OnlineState;                                   // status 'offline' + nulls when not connected
startOnlineParty(name: string, catId: string, room: RoomId): Promise<{ ok: boolean; error?: string }>;
joinOnlineParty(code: string, name: string, catId: string): Promise<{ ok: boolean; error?: string }>;
leaveOnlineParty(): Promise<void>;                        // host leaving = ends the party for nobody else; succession applies
kickOnline(playerId: string): void;
forgetMeOnline(): Promise<void>;                          // deletes server rows and the device key
// existing sendCheer(memberId) routes to the link while online.
```

`bus.emit('party:changed', { status })` fires after every snapshot, status change or error, and
the panel re-renders on it.

### Runtime rules

- `runtime.offline = { party, room }` is stashed when a party goes online; `persist()` and
  `exportSave()` write **that** in place of `state.party`/`settings.room`, so friends' names and
  cats never reach the disk or an export. Restored on leave.
- The live roster is projected into `state.party` by `snapshotToParty(snapshot, selfId, myCatId)`:
  self → `{ id: playerId, playerName, catId: myCatId, guest: null }`, everyone else → a guest
  built from their `CatCard`, sanitised with the existing rules. `world.ts` is not modified.
- `settings.room` is set to the party's room while online (it may be a room this player does not
  own; the stash restores their own on leave).
- `settings.mode` becomes `'party'` on a successful create/join and `'solo'` on leave.
- Boot never connects. A saved `mode:'party'` with no live session behaves exactly as today.
- Timer: the host publishes `toWireTimer(runtime.timer, offset)` after every local timer
  mutation (start, pause, toggle, reset, skip, settings change, and each `tick` transition).
  Members' `startTimer/pauseTimer/toggleTimer/resetTimer/skip/updateTimerSettings` are no-ops
  while online and not host. On every snapshot with a timer, a member does
  `runtime.timer = adoptRemoteTimer(runtime.timer, wire, offset)` — it **never advances** a
  session; members are paid by their own `tick()` exactly as in solo.
- Hearth: `completeFocus` does not add to `sharedMinutes` while online. The host sends
  `focus { minutes }` on a natural focus→break transition. Progress is
  `bonfireProgress(sharedMinutes, members, onlineBonfireGoal(members, focusMin))` with
  `onlineBonfireGoal = 3 × focusMin × members` (three shared sessions light it, any party size).
  The maxed reward is granted once per party per device (`runtime.hearthRewardedFor = partyId`).
- Leaving, `left`, or a terminal `offline` restores the stash, sets solo, and toasts why.

## 7. UI

The party panel leads with online. Sections, in order:

1. **Status + disclosure.** One line of state (offline / connecting / in party with code /
   reconnecting), and the disclosure that replaces the retired "nothing leaves this device":
   *"to be in a party your cat's name, breed, outfit and bond level, and the name you type, are
   sent to our server and shown to everyone with the code. nothing else — not your save, not what
   you are studying. leaving deletes the party's rows."*
2. **Not in a party:** START A PARTY (name, cat picker, room picker) and JOIN (code, name, cat).
   Both disabled with a reason when the player has no cats.
3. **In a party:** the code, large, with COPY; the roster with a connection dot per member, a
   host mark, a cheer button per member, SEND HOME (host only); the hearth bar; LEAVE, and for
   the host END PARTY.
4. **Offline fallback:** the existing cat-card section, collapsed by default, titled "no
   internet? cat cards".
5. **Forget me on the server**, small, at the bottom, with a confirm.

HUD: while online and not host, the start/pause/reset controls are disabled and a caption reads
"the host runs the clock".

## 8. Deploy

- `railway.json` unchanged except nothing: the start command is still `node server.mjs`.
- The `web` service gets `DATABASE_URL=${{Postgres.DATABASE_URL}}` as a reference variable.
- Rollback is a redeploy of the previous commit; the schema is additive and idempotent.

## 9. Verification

- Unit: `tests/party-server.test.ts` (memory store + service: create, join, capacity 8, duplicate
  name, one party per player, leave, host succession, kick + code rotation, cheer, timer
  authority, focus crediting and its rate limit, forget, invalid frames) and
  `tests/party-online.test.ts` (offset sign, adoptRemoteTimer never advances, snapshotToParty,
  onlineBonfireGoal).
- e2e (Playwright, two browser contexts against `node server.mjs` with the memory store): host
  creates, guest joins by code, both rosters show both cats, host starts the clock and the guest's
  HUD follows, guest cheers, host ends, both return to solo, solo save contains no guest.
- Production: the same journey against the Railway URL after deploy, with Postgres.
