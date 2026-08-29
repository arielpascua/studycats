/**
 * The shape of everything that persists. Kept in one place so `save.ts` migrations, the
 * Zustand store and the tests all agree on a single canonical structure.
 */

import type { BreedId } from '../data/breeds';
import type { EnvironmentId } from '../data/environments';
import type { SlotId } from '../data/furniture';
import { DEFAULT_SNACKS } from '../data/snacks';
import { STARTER_BREED } from '../data/breeds';
import { createEconomy, type EconomyState } from './economy';
import { DEFAULT_TIMER_SETTINGS, type TimerSettings, type TimerSnapshot } from './timer';
import { dayKey } from './time';

export interface CatSave {
  id: string;
  breed: BreedId;
  name: string;
  bondXp: number;
  petCount: number;
  snacksEaten: number;
  adoptedOn: string;
  /** Trick ids the cat has learned, gated by bond level. */
  tricks: string[];
  /** Day key of the last max-bond gift, so it's once per day. */
  lastGiftDay: string | null;
}

export interface StatsState {
  totalPomodoros: number;
  totalFocusMin: number;
  totalBreakMin: number;
  /** `YYYY-MM-DD` → { pomodoros, focus minutes } — powers the heatmap and the bar chart. */
  perDay: Record<string, { p: number; m: number }>;
  /** Focus minutes spent in each world. */
  sceneMinutes: Partial<Record<EnvironmentId, number>>;
  /** catId → times petted. */
  petCounts: Record<string, number>;
  sessionsSkipped: number;
  photosTaken: number;
}

export interface UnlockState {
  breeds: BreedId[];
  snacks: string[];
  environments: EnvironmentId[];
  furniture: string[];
  /** environment → slot → furniture id. */
  placements: Partial<Record<EnvironmentId, Partial<Record<SlotId, string>>>>;
  radio: string[];
  filters: string[];
  achievements: string[];
  visitors: string[];
  snacksTasted: string[];
  tricksSeen: string[];
}

/**
 * Live counters for the current local day. Persisted so quests survive a reload, reset by a
 * single rollover check rather than by scattered `if (newDay)` branches.
 */
export interface DailySave {
  day: string;
  pomodoros: number;
  focusMinutes: number;
  breakMinutes: number;
  snacksEaten: number;
  breaksCompleted: number;
  /** Distinct cat ids petted today, for the "pet every cat" quest. */
  pettedCats: string[];
  sceneMinutes: Partial<Record<EnvironmentId, number>>;
  visitorsSeen: number;
}

export interface QuestSave {
  day: string;
  quests: Array<{ id: string; progress: number; claimed: boolean }>;
}

export interface SettingsState {
  /** 1 = crisp, 6 = chunky. Drives the pixelation pass render scale. */
  pixelScale: number;
  bloom: number;
  volume: { master: number; music: number; ambience: number; sfx: number };
  muted: boolean;
  radio: string;
  filter: string;
  motion: 'auto' | 'reduced' | 'full';
  showShadows: boolean;
  environment: EnvironmentId;
  timer: TimerSettings;
}

export interface GameState {
  version: number;
  cats: CatSave[];
  economy: EconomyState;
  unlocks: UnlockState;
  stats: StatsState;
  settings: SettingsState;
  quests: QuestSave;
  daily: DailySave;
  timer: TimerSnapshot;
  /** Visitor currently waiting at the diorama edge, if any. */
  pendingVisitor: string | null;
  createdOn: string;
}

export const SAVE_VERSION = 3;

export function createCat(breed: BreedId, name: string, id?: string, today: string = dayKey()): CatSave {
  return {
    id: id ?? `cat-${Math.random().toString(36).slice(2, 9)}`,
    breed,
    name,
    bondXp: 0,
    petCount: 0,
    snacksEaten: 0,
    adoptedOn: today,
    tricks: [],
    lastGiftDay: null,
  };
}

export function createDaily(day: string): DailySave {
  return {
    day,
    pomodoros: 0,
    focusMinutes: 0,
    breakMinutes: 0,
    snacksEaten: 0,
    breaksCompleted: 0,
    pettedCats: [],
    sceneMinutes: {},
    visitorsSeen: 0,
  };
}

export function createDefaultState(today: string = dayKey()): GameState {
  return {
    version: SAVE_VERSION,
    cats: [createCat(STARTER_BREED, 'Mochi', 'cat-mochi', today)],
    economy: createEconomy(),
    unlocks: {
      breeds: [STARTER_BREED],
      snacks: [...DEFAULT_SNACKS],
      environments: ['room'],
      furniture: [],
      placements: {},
      radio: ['lofi'],
      filters: ['none'],
      achievements: [],
      visitors: [],
      snacksTasted: [],
      tricksSeen: [],
    },
    stats: {
      totalPomodoros: 0,
      totalFocusMin: 0,
      totalBreakMin: 0,
      perDay: {},
      sceneMinutes: {},
      petCounts: {},
      sessionsSkipped: 0,
      photosTaken: 0,
    },
    settings: {
      pixelScale: 1,
      bloom: 0.35,
      volume: { master: 0.7, music: 0.5, ambience: 0.6, sfx: 0.8 },
      muted: false,
      radio: 'lofi',
      filter: 'none',
      motion: 'auto',
      showShadows: true,
      environment: 'room',
      timer: { ...DEFAULT_TIMER_SETTINGS },
    },
    quests: { day: today, quests: [] },
    daily: createDaily(today),
    timer: { mode: 'idle', running: false, remainingMs: DEFAULT_TIMER_SETTINGS.focusMin * 60_000, endsAt: null, round: 0, task: '' },
    pendingVisitor: null,
    createdOn: today,
  };
}

/** Number of distinct days with at least one completed pomodoro. */
export function activeDays(stats: StatsState): number {
  return Object.values(stats.perDay).filter((d) => d.p > 0).length;
}

export function pomodorosOn(stats: StatsState, day: string): number {
  return stats.perDay[day]?.p ?? 0;
}

export function minutesOn(stats: StatsState, day: string): number {
  return stats.perDay[day]?.m ?? 0;
}

export function favouriteScene(stats: StatsState): EnvironmentId | null {
  let best: EnvironmentId | null = null;
  let bestVal = 0;
  for (const [env, mins] of Object.entries(stats.sceneMinutes)) {
    if ((mins ?? 0) > bestVal) {
      bestVal = mins ?? 0;
      best = env as EnvironmentId;
    }
  }
  return bestVal > 0 ? best : null;
}

export function mostPettedCat(stats: StatsState): { id: string; count: number } | null {
  let best: { id: string; count: number } | null = null;
  for (const [id, count] of Object.entries(stats.petCounts)) {
    if (!best || count > best.count) best = { id, count };
  }
  return best && best.count > 0 ? best : null;
}
