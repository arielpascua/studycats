/**
 * Wire protocol for the online party — pure: parsing and sanitising, no I/O.
 *
 * The server validates *shape and length* only. It does not know breed ids or cosmetic ids;
 * every client re-sanitises what it receives with the same rules it applies to a cat card, so
 * an unknown breed becomes an ordinary guest failure and never a crash.
 *
 * Every rejection is `{ ok:false, code, message }` where `message` is a lower-case, user-facing
 * sentence the party panel can show verbatim.
 */

export const MAX_PARTY = 8;
export const MAX_NAME = 14;
export const MAX_CAT_NAME = 24;
export const MAX_FRAME = 4096;
export const MAX_ROOM = 24;

/** Six characters from this alphabet: no I, L, O, U, 0, 1, so a code read aloud survives. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const CODE_LENGTH = 6;

const OUTFIT_SLOTS = ['hat', 'collar', 'cape', 'charm'];
const BREED_RE = /^[a-z0-9-]{1,24}$/;
const COSMETIC_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ROOM_RE = /^[a-z0-9-]{1,24}$/;
/** base64url of 32 random bytes is 43 chars; tolerate a little slack and optional padding. */
const KEY_RE = /^[A-Za-z0-9_-]{22,128}={0,2}$/;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_RAW_CODE = 32;
const TIMER_MODES = new Set(['idle', 'focus', 'shortBreak', 'longBreak']);
/** Same limits as src/core/timer.ts DURATION_LIMITS, restated so the server has no client import. */
const TIMER_LIMITS = {
  focusMin: [1, 120, 25],
  shortBreakMin: [1, 60, 5],
  longBreakMin: [1, 60, 15],
  roundsPerLongBreak: [2, 8, 4],
};
const MAX_ROUND = 8;

/**
 * @typedef {{ name: string, breed: string, outfit: Record<string, string>, bond: number }} CatCard
 * @typedef {{
 *   mode: 'idle'|'focus'|'shortBreak'|'longBreak', running: boolean, endsAt: number|null,
 *   remainingMs: number, round: number,
 *   settings: { focusMin: number, shortBreakMin: number, longBreakMin: number, roundsPerLongBreak: number },
 * }} WireTimer
 * @typedef {(
 *   { t: 'hello', key: string } | { t: 'ping', echo: number } |
 *   { t: 'create', room: string, name: string, cat: CatCard } |
 *   { t: 'join', code: string, name: string, cat: CatCard } |
 *   { t: 'leave' } | { t: 'cheer' } | { t: 'forget' } |
 *   { t: 'kick', playerId: string } | { t: 'timer', timer: WireTimer } | { t: 'focus', minutes: number }
 * )} ClientMessage
 * @typedef {{ ok: true, msg: ClientMessage } | { ok: false, code: 'bad-frame', message: string }} ParseResult
 */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** @returns {{ ok: false, code: 'bad-frame', message: string }} */
const bad = (message) => ({ ok: false, code: 'bad-frame', message });
/** @returns {{ ok: true, msg: any }} */
const ok = (msg) => ({ ok: true, msg });

/* ------------------------------------------------------------------ pieces */

/**
 * A player's display name: whitespace collapsed, trimmed, at most MAX_NAME characters. Same
 * rule as the client's `sanitizePlayerName`, so both sides agree on what "taken" means.
 * @param {unknown} input
 * @returns {string}
 */
/**
 * Control and format characters have no place in a name: a bidi override turns a roster label
 * inside out on every other member's screen, a NUL is refused by jsonb, and none of them are
 * something a person typed on purpose. The zero-width joiner stays so emoji sequences survive.
 */
const CONTROL_RE = /(?!\u200D)[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;

/** @param {unknown} input @param {number} max */
function cleanText(input, max) {
  return String(input ?? '')
    .replace(CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sanitizeName(input) {
  return cleanText(input, MAX_NAME);
}

/**
 * A cat card, shape-checked. Unknown outfit slots and malformed values are dropped, bond is
 * clamped to 1..10. Returns null when nothing usable is left (no name, or a breed id that
 * could not possibly exist).
 * @param {unknown} input
 * @returns {CatCard | null}
 */
export function sanitizeCat(input) {
  if (!isRecord(input)) return null;
  const name = cleanText(input.name, MAX_CAT_NAME);
  if (!name) return null;
  const breed = typeof input.breed === 'string' ? input.breed : '';
  if (!BREED_RE.test(breed)) return null;

  /** @type {Record<string, string>} */
  const outfit = {};
  if (isRecord(input.outfit)) {
    for (const slot of OUTFIT_SLOTS) {
      const value = input.outfit[slot];
      if (typeof value === 'string' && COSMETIC_RE.test(value)) outfit[slot] = value;
    }
  }
  const bond = Math.max(1, Math.min(10, Math.round(Number(input.bond) || 1)));
  return { name, breed, outfit, bond };
}

/**
 * Codes are compared case-insensitively after stripping spaces and dashes, so "ab-cd ef" finds
 * ABCDEF.
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

/**
 * A fresh six-character code. `random` is injectable so tests get deterministic codes.
 * @param {() => number} random returns a number in [0, 1)
 * @returns {string}
 */
export function makeCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const index = Math.min(CODE_ALPHABET.length - 1, Math.max(0, Math.floor(random() * CODE_ALPHABET.length)));
    out += CODE_ALPHABET[index];
  }
  return out;
}

/**
 * A timer as the host publishes it, shape-checked and clamped. Returns null when a required
 * field is missing or of the wrong type.
 * @param {unknown} input
 * @returns {WireTimer | null}
 */
export function sanitizeTimer(input) {
  if (!isRecord(input)) return null;
  const { mode } = input;
  if (typeof mode !== 'string' || !TIMER_MODES.has(mode)) return null;
  if (typeof input.running !== 'boolean') return null;
  const endsAt = input.endsAt === null || input.endsAt === undefined ? null : input.endsAt;
  if (endsAt !== null && !isFiniteNumber(endsAt)) return null;
  if (!isFiniteNumber(input.remainingMs)) return null;
  if (!isFiniteNumber(input.round)) return null;
  if (!isRecord(input.settings)) return null;

  /** @type {Record<string, number>} */
  const settings = {};
  for (const [key, [lo, hi, fallback]] of Object.entries(TIMER_LIMITS)) {
    const raw = Number(input.settings[key]);
    settings[key] = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, Math.round(raw))) : fallback;
  }
  return {
    mode: /** @type {WireTimer['mode']} */ (mode),
    running: input.running,
    endsAt,
    remainingMs: Math.max(0, input.remainingMs),
    round: Math.min(MAX_ROUND, Math.max(0, Math.round(input.round))),
    settings: /** @type {WireTimer['settings']} */ (settings),
  };
}

/* ---------------------------------------------------------------- messages */

/**
 * Validate an already-parsed (untrusted) value as a client message. The service runs this on
 * every message it is handed, whatever the transport did, so nothing unvalidated gets through.
 * @param {unknown} value
 * @returns {ParseResult}
 */
export function validateClientMessage(value) {
  if (!isRecord(value)) return bad('that message was not an object');
  const { t } = value;
  if (typeof t !== 'string') return bad('that message had no type');

  switch (t) {
    case 'hello': {
      if (typeof value.key !== 'string' || !KEY_RE.test(value.key)) {
        return bad('that device key does not look right — reload and try again');
      }
      return ok({ t, key: value.key });
    }
    case 'ping': {
      if (!isFiniteNumber(value.echo)) return bad('a ping needs a number to echo');
      return ok({ t, echo: value.echo });
    }
    case 'create': {
      if (typeof value.room !== 'string' || !ROOM_RE.test(value.room)) return bad('pick a room first');
      const seat = seatFields(value);
      if (!seat.ok) return seat;
      return ok({ t, room: value.room, name: seat.name, cat: seat.cat });
    }
    case 'join': {
      if (typeof value.code !== 'string') return bad('type the code your friend sent you');
      const code = normalizeCode(value.code);
      if (!code || code.length > MAX_RAW_CODE) return bad('type the code your friend sent you');
      const seat = seatFields(value);
      if (!seat.ok) return seat;
      return ok({ t, code, name: seat.name, cat: seat.cat });
    }
    case 'leave':
    case 'cheer':
    case 'forget':
      return ok({ t });
    case 'kick': {
      if (typeof value.playerId !== 'string' || !PLAYER_ID_RE.test(value.playerId)) {
        return bad('pick who to send home');
      }
      return ok({ t, playerId: value.playerId });
    }
    case 'timer': {
      const timer = sanitizeTimer(value.timer);
      if (!timer) return bad('that clock could not be read — the app may need an update');
      return ok({ t, timer });
    }
    case 'focus': {
      if (!isFiniteNumber(value.minutes) || value.minutes < 0) return bad('a focus report needs the minutes studied');
      return ok({ t, minutes: value.minutes });
    }
    default:
      return bad('the app sent something this server does not understand — try reloading');
  }
}

/**
 * The name and cat a `create` or `join` brings along.
 * @param {Record<string, unknown>} value
 * @returns {{ ok: true, name: string, cat: CatCard } | { ok: false, code: 'bad-frame', message: string }}
 */
function seatFields(value) {
  const name = sanitizeName(value.name);
  if (!name) return bad('give yourself a name first');
  const cat = sanitizeCat(value.cat);
  if (!cat) return bad('pick a cat to bring');
  return { ok: true, name, cat };
}

/**
 * Parse one text frame into a client message. Oversize frames, non-JSON, non-objects and
 * unknown types are all `bad-frame`.
 * @param {unknown} text
 * @returns {ParseResult}
 */
export function parseClientMessage(text) {
  if (typeof text !== 'string') return bad('that message was not text');
  if (text.length > MAX_FRAME) return bad('that message was too big');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return bad('that message was not valid json');
  }
  return validateClientMessage(value);
}
