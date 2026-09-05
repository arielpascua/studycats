/**
 * The online party, minus the network.
 *
 * Pure — no DOM, no Three, no socket, no `Date.now()`. Everything the store has to *decide*
 * about a party that lives on the server is here so it can be tested on a desk: how a host's
 * clock becomes a member's clock, how a server frame becomes the roster the arena already knows
 * how to draw, and how the shared hearth is scored when the minutes come from someone else.
 *
 * The wire types are exported from here rather than from `net/` so the panel can name them
 * without pulling the networking code into the solo bundle (PRODUCT.md rule 4).
 */

import { clampDuration, durationFor, sanitizeSettings, type TimerMode, type TimerState } from './timer';
import { MIN_PARTY, normalizeParty, sanitizePlayerName, type PartyState } from './party';
import { bondLevel } from './economy';
import { sanitizeOutfit } from '../data/cosmetics';
import type { RoomId } from '../data/rooms';

/* ------------------------------------------------------------------- wire */

export type OnlineStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';
export type LeftReason = 'left' | 'kicked' | 'closed' | 'replaced';

/** A cat as it travels: name, breed, outfit, bond level. Nothing else leaves the device. */
export interface CatCard {
  name: string;
  breed: string;
  outfit: Record<string, string>;
  bond: number;
}

export interface WireTimerSettings {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  roundsPerLongBreak: number;
}

export interface WireTimer {
  mode: TimerMode;
  running: boolean;
  /** SERVER epoch ms; only meaningful while running. */
  endsAt: number | null;
  /** Meaningful while paused/idle. */
  remainingMs: number;
  round: number;
  settings: WireTimerSettings;
}

export interface PartySnapshotMember {
  id: string;
  name: string;
  cat: CatCard;
  seat: number;
  connected: boolean;
}

export interface PartySnapshot {
  id: string;
  code: string;
  room: RoomId;
  hostId: string;
  members: PartySnapshotMember[];
  sharedMinutes: number;
  cheers: number;
  timer: WireTimer | null;
}

/** What the panel builds against. `status: 'offline'` plus nulls when nothing is connected. */
export interface OnlineState {
  status: OnlineStatus;
  playerId: string | null;
  partyId: string | null;
  code: string | null;
  hostId: string | null;
  isHost: boolean;
  /** Last error message from the server, cleared on the next successful action. */
  error: string | null;
}

export function blankOnlineState(): OnlineState {
  return { status: 'offline', playerId: null, partyId: null, code: null, hostId: null, isHost: false, error: null };
}

/* ------------------------------------------------------------------- link */

/** The server's answer to `hello`. A non-null party means we were already seated: resume. */
export interface Welcome {
  playerId: string;
  serverNow: number;
  party: PartySnapshot | null;
}

/** What the store gives the socket. Every callback is invoked on the main thread, in frame order. */
export interface PartyHandlers {
  onWelcome(w: Welcome): void;
  onSnapshot(p: PartySnapshot, serverNow: number): void;
  onLeft(reason: LeftReason): void;
  onError(code: string, message: string): void;
  onStatus(s: OnlineStatus): void;
  /** The clock offset got materially better (a shorter round trip came in). Re-adopt or re-publish. */
  onOffset?(offset: number): void;
}

/**
 * One live socket to the party server. Declared here, not in `net/`, so the store can name the
 * type without a static import of the networking module — that module must only ever arrive
 * through `import()` after the first START or JOIN tap.
 */
export interface PartyLink {
  create(room: RoomId, name: string, cat: CatCard): void;
  join(code: string, name: string, cat: CatCard): void;
  leave(): void;
  kick(playerId: string): void;
  cheer(): void;
  setTimer(timer: WireTimer): void;
  reportFocus(minutes: number): void;
  /** Asks the server to delete this player, then drops the device key. True if the ask was sent. */
  forget(): boolean;
  /** Terminal: no reconnect, no more callbacks. */
  close(): void;
  /** `localNow − serverNow`, from the best of the connect-time pings. */
  offset(): number;
}

/* ------------------------------------------------------------------ clock */

export interface ClockSample {
  sentAt: number;
  receivedAt: number;
  serverNow: number;
}

/**
 * `offset = localNow − serverNow`, read off the pong with the smallest round trip.
 *
 * The local reading is taken at the midpoint of that round trip, which is the best guess for
 * when the server stamped the frame. The sign matters: a member converts a server deadline to
 * its own clock with `endsAt + offset`, so a fast local clock pushes the deadline *later* and
 * everyone's session still ends at the same real moment.
 */
export function clockOffsetFrom(samples: readonly ClockSample[]): number {
  let best: ClockSample | null = null;
  let bestTrip = Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s.sentAt) || !Number.isFinite(s.receivedAt) || !Number.isFinite(s.serverNow)) continue;
    const trip = s.receivedAt - s.sentAt;
    if (trip < 0) continue;
    if (trip < bestTrip) {
      bestTrip = trip;
      best = s;
    }
  }
  if (!best) return 0;
  const localAtServerStamp = best.sentAt + bestTrip / 2;
  return Math.round(localAtServerStamp - best.serverNow);
}

/* ------------------------------------------------------------------ timer */

const MODES: readonly TimerMode[] = ['idle', 'focus', 'shortBreak', 'longBreak'];

function isTimerMode(value: unknown): value is TimerMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** The host's clock as the server should hold it: the deadline moved into the server's epoch. */
export function toWireTimer(state: TimerState, offset: number): WireTimer {
  const running = state.running && state.endsAt !== null;
  return {
    mode: state.mode,
    running,
    endsAt: running ? (state.endsAt as number) - offset : null,
    remainingMs: Math.max(0, state.remainingMs),
    round: state.round,
    settings: {
      focusMin: state.settings.focusMin,
      shortBreakMin: state.settings.shortBreakMin,
      longBreakMin: state.settings.longBreakMin,
      roundsPerLongBreak: state.settings.roundsPerLongBreak,
    },
  };
}

/**
 * Take the host's clock as our own.
 *
 * This is a *copy*, never a step: an expired deadline stays an expired running session, so the
 * member's own `tick()` is what completes it and pays for it, exactly as in solo. The host's
 * durations replace ours (everyone studies to the host's clock) but `task` and `autoStart` are
 * personal and stay put. Every field is re-sanitised because the server checks shape, not sense.
 */
export function adoptRemoteTimer(current: TimerState, wire: WireTimer, offset: number): TimerState {
  const settings = sanitizeSettings({ ...current.settings, ...(wire.settings ?? {}) });
  const mode = isTimerMode(wire.mode) ? wire.mode : 'idle';
  const total = durationFor(mode, settings);
  const serverEndsAt = typeof wire.endsAt === 'number' && Number.isFinite(wire.endsAt) ? wire.endsAt : null;
  const running = wire.running === true && mode !== 'idle' && serverEndsAt !== null;
  const remaining = Number.isFinite(wire.remainingMs) ? Math.max(0, Math.min(total, Number(wire.remainingMs))) : total;
  const round = Number.isFinite(wire.round) ? Math.max(0, Math.min(settings.roundsPerLongBreak, Math.floor(Number(wire.round)))) : 0;
  return {
    ...current,
    mode,
    running,
    endsAt: running ? (serverEndsAt as number) + offset : null,
    remainingMs: running ? remaining : mode === 'idle' ? total : remaining,
    round,
    settings,
  };
}

/** How close to our own deadline the host's frame may land and still count as "we finished". */
export const SETTLE_GRACE_MS = 5_000;

/**
 * Before a member adopts a frame that moves them to a new mode, the session they are in gets
 * its chance to end on *their* clock.
 *
 * Two clocks agree to within a round trip, so the host's "focus is over" can arrive a few
 * hundred milliseconds before the member's own deadline. Adopting straight away would skip the
 * member's transition and with it their coins and bond. Returns the instant to `tick()` at
 * (never earlier than `now`), or null when there is nothing to settle — including when the host
 * skipped, because a session with minutes still on it was not finished by anyone.
 */
export function settleBeforeAdopt(
  current: TimerState,
  wire: WireTimer,
  now: number,
  graceMs: number = SETTLE_GRACE_MS,
): number | null {
  if (!current.running || current.endsAt === null) return null;
  if (current.mode === wire.mode) return null;
  if (current.endsAt - now > graceMs) return null;
  return Math.max(now, current.endsAt);
}

/* ----------------------------------------------------------------- roster */

/**
 * The server's frame as the roster the arena already draws.
 *
 * Self is the one member with a local `catId`; everyone else is a guest built from their card.
 * The same `normalizeParty` that guards a loaded save guards this, so an unknown breed or a
 * junk outfit from a newer build is an ordinary dropped guest, not a crash mid-party. Members
 * sit in seat order so every device draws the same room.
 */
export function snapshotToParty(snapshot: PartySnapshot, selfId: string, myCatId: string): PartyState {
  const ordered = [...(Array.isArray(snapshot.members) ? snapshot.members : [])].sort(
    (a, b) => (Number(a.seat) || 0) - (Number(b.seat) || 0),
  );
  // Raw on purpose: normalizeParty is the gate. A breed string it does not recognise drops the
  // member, which is what "an unknown breed becomes an ordinary guest failure" means.
  const members = ordered.map((m) => {
    const id = String(m.id);
    const playerName = sanitizePlayerName(m.name);
    // Self is drawn from the local collection when we know which cat we brought. When we do
    // not (a resume where the choice was lost), the server's own card of us is the truth, and
    // we appear the way everyone else sees us rather than as a blank default cat.
    if (id === selfId && myCatId) return { id, playerName, catId: myCatId, guest: null };
    const cat = m.cat && typeof m.cat === 'object' ? m.cat : ({} as Partial<CatCard>);
    return {
      id,
      playerName,
      catId: null,
      guest: { name: String(cat.name ?? ''), breed: cat.breed, outfit: cat.outfit, bond: cat.bond },
    };
  });
  return normalizeParty(
    { members, sharedMinutes: Number(snapshot.sharedMinutes), cheers: Number(snapshot.cheers) },
    [myCatId],
  );
}

/** What a local cat sends when it takes a seat: name, breed, outfit, bond level. Nothing else. */
export function toCatCard(cat: { name: string; breed: string; outfit: unknown; bondXp: number }): CatCard {
  return {
    name: String(cat.name ?? '').slice(0, 24) || 'Cat',
    breed: cat.breed,
    outfit: sanitizeOutfit(cat.outfit),
    bond: bondLevel(cat.bondXp),
  };
}

/** Six letters, compared the way the server compares them: upper-case, no spaces or dashes. */
export function normalizeJoinCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .slice(0, 12);
}

/* ----------------------------------------------------------------- hearth */

/**
 * Three shared focus sessions light the hearth, whatever the party size.
 *
 * The server credits each finished session as `minutes × connected members`, so the goal scales
 * with the party the same way the credit does and a big party is not lit for free. The floor at
 * a duo keeps a host alone in the room from lighting it by themselves.
 */
export function onlineBonfireGoal(memberCount: number, focusMin: number): number {
  const n = Math.max(MIN_PARTY, Number.isFinite(memberCount) ? Math.floor(memberCount) : MIN_PARTY);
  return 3 * clampDuration('focusMin', focusMin) * n;
}
