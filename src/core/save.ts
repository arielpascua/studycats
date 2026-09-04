/**
 * Versioned localStorage save system.
 *
 * Two layers, deliberately separate:
 *  1. **Migrations** rename/reshape fields between schema versions. Each step is small and
 *     tested in isolation.
 *  2. **Normalization** fills anything still missing from the current defaults and clamps
 *     everything into range. This is what makes a hand-edited or truncated save survive:
 *     a migration only has to handle what it renamed, never every possible absence.
 *
 * The invariant the tests hold us to: `load(save(state))` deep-equals `state`, and *any*
 * garbage input yields a playable default rather than a thrown error.
 */

import {
  SAVE_VERSION,
  createDefaultState,
  createDaily,
  type CatSave,
  type GameState,
} from './state';
import { BREEDS, isBreedId, type BreedId } from '../data/breeds';
import { ENVIRONMENTS, isEnvironmentId, isSoloEnvironmentId, type EnvironmentId } from '../data/environments';
import { isSnackId } from '../data/snacks';
import { isFurnitureId, SLOTS, type SlotId } from '../data/furniture';
import { isCosmeticId, sanitizeOutfit } from '../data/cosmetics';
import { DEFAULT_ROOM, isRoomId, type RoomId } from '../data/rooms';
import { isReady, normalizeParty } from './party';
import { sanitizeSettings } from './timer';
import { dayKey } from './time';

export const STORAGE_KEY = 'study-with-cats:save';

export interface LoadResult {
  state: GameState;
  /** 'fresh' = nothing stored, 'loaded' = clean read, 'migrated', 'recovered' = save was broken. */
  status: 'fresh' | 'loaded' | 'migrated' | 'recovered';
  fromVersion?: number;
  error?: string;
}

type Raw = Record<string, unknown>;

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/* ------------------------------------------------------------------ migrations */

/**
 * v1 → v2: the economy grew from a bare `coins` number into an object, cat XP was renamed,
 * and `scenes` became `environments`.
 */
function migrate1to2(raw: Raw): Raw {
  const next: Raw = { ...raw };
  const economy = obj(raw.economy);
  next.economy = {
    coins: num(raw.coins ?? economy.coins, 0),
    lifetimeCoins: num(raw.lifetimeCoins ?? economy.lifetimeCoins ?? raw.coins, 0),
    spent: num(economy.spent, 0),
    streak: obj(raw.streak ?? economy.streak),
  };
  delete next.coins;
  delete next.lifetimeCoins;
  delete next.streak;

  next.cats = arr(raw.cats).map((c) => {
    const cat = obj(c);
    const migrated: Raw = { ...cat, bondXp: num(cat.bondXp ?? cat.xp, 0), petCount: num(cat.petCount ?? cat.pets, 0) };
    delete migrated.xp;
    delete migrated.pets;
    return migrated;
  });

  const unlocks = obj(raw.unlocks);
  next.unlocks = { ...unlocks, environments: arr(unlocks.environments ?? unlocks.scenes) };
  delete (next.unlocks as Raw).scenes;

  next.quests = obj(raw.quests);
  next.version = 2;
  return next;
}

/**
 * v2 → v3: split the flat "today" counters out of `stats` into their own `daily` slice, and
 * introduced slot-based furniture placements.
 */
function migrate2to3(raw: Raw): Raw {
  const next: Raw = { ...raw };
  const stats = obj(raw.stats);
  const today = str(obj(raw.quests).day, dayKey());
  next.daily = {
    ...createDaily(today),
    pomodoros: num(stats.todayPomodoros, 0),
    focusMinutes: num(stats.todayMinutes, 0),
  };
  const cleanStats = { ...stats };
  delete cleanStats.todayPomodoros;
  delete cleanStats.todayMinutes;
  next.stats = cleanStats;

  const unlocks = obj(raw.unlocks);
  next.unlocks = {
    ...unlocks,
    placements: obj(unlocks.placements),
    filters: arr(unlocks.filters).length > 0 ? unlocks.filters : ['none'],
    snacksTasted: arr(unlocks.snacksTasted),
    tricksSeen: arr(unlocks.tricksSeen),
  };
  next.version = 3;
  return next;
}

/**
 * v3 -> v4: multiplayer. Cats gained an `outfit`, the save gained a `party` roster and a
 * `settings.mode`. Nothing is renamed, so this step only has to establish the new shapes —
 * normalization fills the rest, and an existing save opens in solo mode with undressed cats,
 * exactly as it did before.
 */
function migrate3to4(raw: Raw): Raw {
  const next: Raw = { ...raw };
  next.cats = arr(raw.cats).map((c) => {
    const cat = obj(c);
    return { ...cat, outfit: sanitizeOutfit(cat.outfit) };
  });
  const unlocks = obj(raw.unlocks);
  next.unlocks = { ...unlocks, cosmetics: arr(unlocks.cosmetics) };
  next.settings = { ...obj(raw.settings), mode: 'solo' };
  next.party = obj(raw.party);
  next.version = 4;
  return next;
}

/**
 * v4 -> v5: the party can meet somewhere other than the clearing. Adds `unlocks.venues` and
 * `settings.venue`. Existing parties keep meeting in the clearing, which is the free venue and
 * therefore the one every save is guaranteed to own.
 */
function migrate4to5(raw: Raw): Raw {
  const next: Raw = { ...raw };
  const unlocks = obj(raw.unlocks);
  next.unlocks = { ...unlocks, venues: arr(unlocks.venues) };
  // Literal, not a constant: this step must keep producing the v5 shape forever, and the
  // v5 venue ids no longer exist as a type. migrate5to6 maps them on to rooms.
  next.settings = { ...obj(raw.settings), venue: 'clearing' };
  next.version = 5;
  return next;
}

/**
 * v5 -> v6: the party meets in a real room, not on a disc.
 *
 * The circular arena and its five "venues" are gone; the party now sits in an actual library,
 * classroom, meeting room or gallery. Anything the player already paid for is carried across to
 * the room that replaced it rather than refunded or silently dropped — the moonlit clearing had
 * no successor, so its owners land in the library, which is the new free room.
 */
const VENUE_TO_ROOM: Record<string, string> = {
  clearing: 'library',
  library: 'library',
  school: 'classroom',
  cafe: 'conference',
  museum: 'museum',
};

function migrate5to6(raw: Raw): Raw {
  const next: Raw = { ...raw };
  const unlocks = obj(raw.unlocks);
  const owned = arr(unlocks.venues)
    .map((v) => (typeof v === 'string' ? VENUE_TO_ROOM[v] : undefined))
    .filter((v): v is string => Boolean(v));
  const { venues: _dropped, ...restUnlocks } = unlocks;
  next.unlocks = { ...restUnlocks, rooms: owned };

  const settings = obj(raw.settings);
  const { venue, ...restSettings } = settings;
  next.settings = {
    ...restSettings,
    room: (typeof venue === 'string' ? VENUE_TO_ROOM[venue] : undefined) ?? DEFAULT_ROOM,
  };
  next.version = 6;
  return next;
}

const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  1: migrate1to2,
  2: migrate2to3,
  3: migrate3to4,
  4: migrate4to5,
  5: migrate5to6,
};

/** Walk a raw blob up to `SAVE_VERSION`. Unknown/newer versions are passed through untouched. */
export function migrate(raw: Raw): { raw: Raw; migrated: boolean; fromVersion: number } {
  let current = raw;
  const fromVersion = Math.floor(num(raw.version, 1));
  let version = fromVersion;
  let migrated = false;
  let guard = 0;
  while (version < SAVE_VERSION && guard++ < 32) {
    const step = MIGRATIONS[version];
    if (!step) break;
    current = step(current);
    const nextVersion = Math.floor(num(current.version, version + 1));
    if (nextVersion <= version) break;
    version = nextVersion;
    migrated = true;
  }
  current = { ...current, version: SAVE_VERSION };
  return { raw: current, migrated, fromVersion };
}

/* ------------------------------------------------------------------ normalization */

function normalizeCat(input: unknown, today: string, index: number): CatSave | null {
  const c = obj(input);
  const breed = isBreedId(c.breed) ? (c.breed as BreedId) : null;
  if (!breed) return null;
  return {
    id: str(c.id) || `cat-${index}-${breed}`,
    breed,
    name: str(c.name, BREEDS[breed].name).slice(0, 24),
    bondXp: Math.max(0, Math.floor(num(c.bondXp, 0))),
    petCount: Math.max(0, Math.floor(num(c.petCount, 0))),
    snacksEaten: Math.max(0, Math.floor(num(c.snacksEaten, 0))),
    adoptedOn: str(c.adoptedOn, today),
    tricks: arr(c.tricks).filter((t): t is string => typeof t === 'string').slice(0, 8),
    outfit: sanitizeOutfit(c.outfit),
    lastGiftDay: typeof c.lastGiftDay === 'string' ? c.lastGiftDay : null,
  };
}

/**
 * Fill every field from defaults and clamp into range. Never throws, never returns a partially
 * populated object.
 */
export function normalize(input: unknown, today: string = dayKey()): GameState {
  const base = createDefaultState(today);
  const raw = obj(input);

  const cats = arr(raw.cats)
    .map((c, i) => normalizeCat(c, today, i))
    .filter((c): c is CatSave => c !== null)
    .slice(0, 12);

  const rawEconomy = obj(raw.economy);
  const rawStreak = obj(rawEconomy.streak);
  const economy = {
    coins: Math.max(0, Math.floor(num(rawEconomy.coins, 0))),
    lifetimeCoins: Math.max(0, Math.floor(num(rawEconomy.lifetimeCoins, 0))),
    spent: Math.max(0, Math.floor(num(rawEconomy.spent, 0))),
    streak: {
      current: Math.max(0, Math.floor(num(rawStreak.current, 0))),
      best: Math.max(0, Math.floor(num(rawStreak.best, 0))),
      lastDay: typeof rawStreak.lastDay === 'string' ? rawStreak.lastDay : null,
      freezes: clamp(Math.floor(num(rawStreak.freezes, 0)), 0, 2),
      lastFreezeGrantDay: typeof rawStreak.lastFreezeGrantDay === 'string' ? rawStreak.lastFreezeGrantDay : null,
      frozenDays: arr(rawStreak.frozenDays).filter((d): d is string => typeof d === 'string').slice(-30),
    },
  };

  const rawUnlocks = obj(raw.unlocks);
  const breeds = Array.from(
    new Set([...base.unlocks.breeds, ...arr(rawUnlocks.breeds).filter(isBreedId)]),
  ) as BreedId[];
  const environments = Array.from(
    new Set<EnvironmentId>(['room', ...arr(rawUnlocks.environments).filter(isEnvironmentId)]),
  );
  // The free room is always owned: party mode must always have somewhere to meet, and a save
  // that lost its room list would otherwise open the party with nowhere to go.
  const rooms = Array.from(
    new Set<RoomId>([DEFAULT_ROOM, ...arr(rawUnlocks.rooms).filter(isRoomId)]),
  );

  const placements: GameState['unlocks']['placements'] = {};
  for (const [env, slots] of Object.entries(obj(rawUnlocks.placements))) {
    if (!isEnvironmentId(env)) continue;
    const bySlot: Partial<Record<SlotId, string>> = {};
    for (const [slot, item] of Object.entries(obj(slots))) {
      if (!SLOTS.includes(slot as SlotId)) continue;
      if (!isFurnitureId(item)) continue;
      bySlot[slot as SlotId] = item as string;
    }
    placements[env] = bySlot;
  }

  // The party is resolved before settings, because whether you can BE in party mode depends on
  // whether the party survived normalization.
  const party = normalizeParty(raw.party, (cats.length > 0 ? cats : base.cats).map((c) => c.id));

  const rawStats = obj(raw.stats);
  const perDay: GameState['stats']['perDay'] = {};
  for (const [day, entry] of Object.entries(obj(rawStats.perDay))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const e = obj(entry);
    perDay[day] = { p: Math.max(0, Math.floor(num(e.p, 0))), m: Math.max(0, Math.round(num(e.m, 0))) };
  }
  const sceneMinutes: GameState['stats']['sceneMinutes'] = {};
  for (const [env, mins] of Object.entries(obj(rawStats.sceneMinutes))) {
    if (isEnvironmentId(env)) sceneMinutes[env] = Math.max(0, Math.round(num(mins, 0)));
  }
  const petCounts: Record<string, number> = {};
  for (const [id, n] of Object.entries(obj(rawStats.petCounts))) {
    petCounts[id] = Math.max(0, Math.floor(num(n, 0)));
  }

  const rawSettings = obj(raw.settings);
  const rawVolume = obj(rawSettings.volume);
  // The arena is never a *solo* environment, however a save was edited: it is reached only by
  // entering party mode, and dropping into it alone would show an empty ring of cushions.
  const environment: EnvironmentId =
    isSoloEnvironmentId(rawSettings.environment) && environments.includes(rawSettings.environment)
      ? rawSettings.environment
      : 'room';

  const rawDaily = obj(raw.daily);
  const dailyDay = str(rawDaily.day, today);
  const daily = dailyDay === today
    ? {
        day: today,
        pomodoros: Math.max(0, Math.floor(num(rawDaily.pomodoros, 0))),
        focusMinutes: Math.max(0, num(rawDaily.focusMinutes, 0)),
        breakMinutes: Math.max(0, num(rawDaily.breakMinutes, 0)),
        snacksEaten: Math.max(0, Math.floor(num(rawDaily.snacksEaten, 0))),
        breaksCompleted: Math.max(0, Math.floor(num(rawDaily.breaksCompleted, 0))),
        pettedCats: arr(rawDaily.pettedCats).filter((v): v is string => typeof v === 'string'),
        sceneMinutes: Object.fromEntries(
          Object.entries(obj(rawDaily.sceneMinutes))
            .filter(([env]) => isEnvironmentId(env))
            .map(([env, m]) => [env, Math.max(0, num(m, 0))]),
        ) as Partial<Record<EnvironmentId, number>>,
        visitorsSeen: Math.max(0, Math.floor(num(rawDaily.visitorsSeen, 0))),
      }
    : createDaily(today);

  const rawQuests = obj(raw.quests);

  return {
    version: SAVE_VERSION,
    cats: cats.length > 0 ? cats : base.cats,
    economy,
    unlocks: {
      breeds,
      snacks: Array.from(new Set([...base.unlocks.snacks, ...arr(rawUnlocks.snacks).filter(isSnackId)])),
      environments,
      furniture: Array.from(new Set(arr(rawUnlocks.furniture).filter(isFurnitureId) as string[])),
      placements,
      radio: Array.from(new Set(['lofi', ...arr(rawUnlocks.radio).filter((r): r is string => typeof r === 'string')])),
      filters: Array.from(new Set(['none', ...arr(rawUnlocks.filters).filter((f): f is string => typeof f === 'string')])),
      cosmetics: Array.from(new Set(arr(rawUnlocks.cosmetics).filter(isCosmeticId) as string[])),
      rooms,
      achievements: arr(rawUnlocks.achievements).filter((a): a is string => typeof a === 'string'),
      visitors: arr(rawUnlocks.visitors).filter((v): v is string => typeof v === 'string'),
      snacksTasted: arr(rawUnlocks.snacksTasted).filter(isSnackId) as string[],
      tricksSeen: arr(rawUnlocks.tricksSeen).filter((t): t is string => typeof t === 'string'),
    },
    stats: {
      totalPomodoros: Math.max(0, Math.floor(num(rawStats.totalPomodoros, 0))),
      totalFocusMin: Math.max(0, Math.round(num(rawStats.totalFocusMin, 0))),
      totalBreakMin: Math.max(0, Math.round(num(rawStats.totalBreakMin, 0))),
      perDay,
      sceneMinutes,
      petCounts,
      sessionsSkipped: Math.max(0, Math.floor(num(rawStats.sessionsSkipped, 0))),
      photosTaken: Math.max(0, Math.floor(num(rawStats.photosTaken, 0))),
    },
    settings: {
      pixelScale: clamp(Math.round(num(rawSettings.pixelScale, base.settings.pixelScale)), 1, 6),
      bloom: clamp(num(rawSettings.bloom, base.settings.bloom), 0, 1),
      volume: {
        master: clamp(num(rawVolume.master, 0.7), 0, 1),
        music: clamp(num(rawVolume.music, 0.5), 0, 1),
        ambience: clamp(num(rawVolume.ambience, 0.6), 0, 1),
        sfx: clamp(num(rawVolume.sfx, 0.8), 0, 1),
      },
      muted: Boolean(rawSettings.muted),
      radio: str(rawSettings.radio, 'lofi'),
      filter: str(rawSettings.filter, 'none'),
      motion: rawSettings.motion === 'reduced' || rawSettings.motion === 'full' ? rawSettings.motion : 'auto',
      showShadows: rawSettings.showShadows === undefined ? true : Boolean(rawSettings.showShadows),
      // You cannot be standing in a party that does not exist. A save can arrive below the
      // minimum for honest reasons — the one-cat-per-device rule dropped members written by an
      // older build, or the file was edited — and without this you load into the venue alone,
      // with a shared timer and a bonfire and nobody to share them with.
      mode: rawSettings.mode === 'party' && isReady(party) ? 'party' : 'solo',
      environment,
      // Same rule as the solo environment: you cannot be standing in a room you do not own.
      room: isRoomId(rawSettings.room) && rooms.includes(rawSettings.room) ? rawSettings.room : DEFAULT_ROOM,
      timer: sanitizeSettings(obj(rawSettings.timer) as never),
    },
    quests: {
      day: str(rawQuests.day, today),
      quests: arr(rawQuests.quests)
        .map((q) => {
          const e = obj(q);
          const id = str(e.id);
          if (!id) return null;
          return { id, progress: Math.max(0, Math.floor(num(e.progress, 0))), claimed: Boolean(e.claimed) };
        })
        .filter((q): q is { id: string; progress: number; claimed: boolean } => q !== null),
    },
    daily,
    // The roster is validated against the cats that actually exist, so a member pointing at a
    // cat that was sent home cannot linger and produce an empty seat in the arena.
    party,
    timer: normalizeTimer(obj(raw.timer)),
    pendingVisitor: typeof raw.pendingVisitor === 'string' ? raw.pendingVisitor : null,
    createdOn: str(raw.createdOn, today),
  };
}

function normalizeTimer(t: Raw): GameState['timer'] {
  const mode = t.mode === 'focus' || t.mode === 'shortBreak' || t.mode === 'longBreak' ? t.mode : 'idle';
  return {
    mode,
    running: Boolean(t.running),
    remainingMs: Math.max(0, num(t.remainingMs, 25 * 60_000)),
    endsAt: typeof t.endsAt === 'number' && Number.isFinite(t.endsAt) ? t.endsAt : null,
    round: clamp(Math.floor(num(t.round, 0)), 0, 8),
    task: str(t.task).slice(0, 80),
  };
}

/* ------------------------------------------------------------------ storage */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory fallback so private browsing / disabled storage degrades to "works, doesn't persist". */
export function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let fallback: StorageLike | null = null;

export function defaultStorage(): StorageLike {
  try {
    const probe = '__swc_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    if (!fallback) fallback = memoryStorage();
    return fallback;
  }
}

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string, today: string = dayKey()): { state: GameState; migrated: boolean; fromVersion: number } {
  const parsed = JSON.parse(json) as unknown;
  const { raw, migrated, fromVersion } = migrate(obj(parsed));
  return { state: normalize(raw, today), migrated, fromVersion };
}

export function saveGame(state: GameState, storage: StorageLike = defaultStorage()): boolean {
  try {
    storage.setItem(STORAGE_KEY, serialize(state));
    return true;
  } catch {
    // Quota exceeded or storage disabled — the game keeps running, it just won't persist.
    return false;
  }
}

export function loadGame(storage: StorageLike = defaultStorage(), today: string = dayKey()): LoadResult {
  let json: string | null = null;
  try {
    json = storage.getItem(STORAGE_KEY);
  } catch {
    return { state: createDefaultState(today), status: 'fresh', error: 'storage unavailable' };
  }
  if (!json) return { state: createDefaultState(today), status: 'fresh' };
  try {
    const { state, migrated, fromVersion } = deserialize(json, today);
    return { state, status: migrated ? 'migrated' : 'loaded', fromVersion };
  } catch (err) {
    return {
      state: createDefaultState(today),
      status: 'recovered',
      error: err instanceof Error ? err.message : 'unreadable save',
    };
  }
}

export function clearSave(storage: StorageLike = defaultStorage()): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do — the next load returns defaults anyway */
  }
}

/* ------------------------------------------------------------------ export / import */

export function exportSave(state: GameState): string {
  return JSON.stringify(state, null, 2);
}

export type ImportResult =
  | { ok: true; state: GameState; migrated: boolean }
  | { ok: false; error: string };

/**
 * Import a pasted blob. Errors name the problem *and* the fix — DESIGN.md §7 requires it, and
 * "invalid JSON" alone helps nobody staring at a text area at 1am.
 */
export function importSave(text: string, today: string = dayKey()): ImportResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: 'nothing pasted yet — paste the whole save, starting with {' };
  }
  if (!trimmed.startsWith('{')) {
    return { ok: false, error: "that isn't a Study With Cats save — paste the whole { … } block, including the braces" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'that save is cut off or has a typo — copy it again, all the way to the final }' };
  }
  const raw = obj(parsed);
  if (!Array.isArray(raw.cats) && raw.economy === undefined && raw.version === undefined) {
    return { ok: false, error: 'this is valid JSON but not a save file — it has no cats, coins, or version' };
  }
  const { raw: upgraded, migrated } = migrate(raw);
  return { ok: true, state: normalize(upgraded, today), migrated };
}

/** Human-readable summary used by the import confirmation ("this save has 4 cats, 320 🐟"). */
export function describeSave(state: GameState): string {
  const cats = state.cats.length;
  const envs = state.unlocks.environments.length;
  return `${cats} cat${cats === 1 ? '' : 's'} · ${state.economy.coins} 🐟 · ${state.stats.totalPomodoros} pomodoros · ${envs}/${Object.keys(ENVIRONMENTS).length} worlds`;
}
