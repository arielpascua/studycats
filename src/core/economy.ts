/**
 * Fish coins, streaks and bond XP — pure.
 *
 * Design rule inherited from PRODUCT.md: nothing here may ever punish. Streaks freeze, they
 * do not shatter; bond levels only rise; coins only accrue and are only spent deliberately.
 */

import { dayKey, daysBetween } from './time';

export const COINS_PER_FOCUS = 10;
export const COINS_PER_BREAK = 2;
export const STREAK_STEP = 0.1;
export const STREAK_MULTIPLIER_CAP = 2;
/** One freeze earned per 7 days of play, stockpiled up to this many. */
export const FREEZE_GRANT_INTERVAL_DAYS = 7;
export const FREEZE_MAX = 2;
export const MAX_BOND_LEVEL = 10;

export interface StreakState {
  current: number;
  best: number;
  /** Local `YYYY-MM-DD` of the last day with a completed focus session. */
  lastDay: string | null;
  freezes: number;
  lastFreezeGrantDay: string | null;
  /** Days that were saved by a freeze, newest last — drives the snowflake in the HUD. */
  frozenDays: string[];
}

export interface EconomyState {
  coins: number;
  lifetimeCoins: number;
  spent: number;
  streak: StreakState;
}

export function createEconomy(): EconomyState {
  return {
    coins: 0,
    lifetimeCoins: 0,
    spent: 0,
    streak: { current: 0, best: 0, lastDay: null, freezes: 0, lastFreezeGrantDay: null, frozenDays: [] },
  };
}

/** ×1.1 per consecutive day, capped at ×2. A streak of 0 or 1 is ×1. */
export function streakMultiplier(streak: number): number {
  const days = Math.max(1, Math.floor(streak || 1));
  return Math.min(STREAK_MULTIPLIER_CAP, 1 + (days - 1) * STREAK_STEP);
}

/** Coins for one completed focus session at the given streak. Always a whole number. */
export function focusReward(streak: number): number {
  return Math.floor(COINS_PER_FOCUS * streakMultiplier(streak));
}

export function breakReward(): number {
  return COINS_PER_BREAK;
}

export function addCoins(state: EconomyState, amount: number): EconomyState {
  const delta = Math.max(0, Math.floor(amount));
  if (delta === 0) return state;
  return { ...state, coins: state.coins + delta, lifetimeCoins: state.lifetimeCoins + delta };
}

export function canAfford(state: EconomyState, price: number): boolean {
  return state.coins >= Math.max(0, Math.floor(price));
}

/** Spend. Returns `null` when unaffordable so callers must handle the failure explicitly. */
export function spend(state: EconomyState, price: number): EconomyState | null {
  const cost = Math.max(0, Math.floor(price));
  if (!canAfford(state, cost)) return null;
  return { ...state, coins: state.coins - cost, spent: state.spent + cost };
}

export interface StreakResult {
  streak: StreakState;
  /** True when a freeze was consumed to bridge a gap. */
  frozen: boolean;
  /** True when today newly counted toward the streak. */
  counted: boolean;
  /** True when a weekly freeze was granted by this call. */
  granted: boolean;
}

/**
 * Register that the user completed a focus session on `today`.
 *
 * - Same day twice → no change (idempotent; a 6-pomodoro day is still one streak day).
 * - Gap of exactly 1 day → streak grows.
 * - Larger gap → spend one freeze per missed day if we have them, else start again at 1.
 *   Never 0: you studied today, so today counts.
 */
export function registerStudyDay(streak: StreakState, today: string = dayKey()): StreakResult {
  const s: StreakState = { ...streak, frozenDays: streak.frozenDays.slice() };

  if (s.lastDay === today) {
    return { streak: s, frozen: false, counted: false, granted: false };
  }

  let frozen = false;
  if (s.lastDay === null) {
    s.current = 1;
  } else {
    const gap = daysBetween(s.lastDay, today);
    if (!Number.isFinite(gap) || gap <= 0) {
      // Clock moved backwards (timezone travel, manual clock change). Be generous: keep it.
      s.current = Math.max(1, s.current);
    } else if (gap === 1) {
      s.current = s.current + 1;
    } else {
      const missed = gap - 1;
      if (missed <= s.freezes) {
        s.freezes -= missed;
        s.current = s.current + 1;
        frozen = true;
        s.frozenDays = [...s.frozenDays, today].slice(-30);
      } else {
        s.current = 1;
      }
    }
  }

  s.lastDay = today;
  s.best = Math.max(s.best, s.current);

  const granted = grantFreezeIfDue(s, today);
  return { streak: s, frozen, counted: true, granted };
}

/** Mutates `s` in place (it is already a copy) — grants at most one freeze per interval. */
function grantFreezeIfDue(s: StreakState, today: string): boolean {
  if (s.freezes >= FREEZE_MAX) {
    // Still advance the clock so the user isn't punished for being at cap.
    if (s.lastFreezeGrantDay === null) s.lastFreezeGrantDay = today;
    return false;
  }
  if (s.lastFreezeGrantDay === null) {
    s.lastFreezeGrantDay = today;
    s.freezes += 1;
    return true;
  }
  const since = daysBetween(s.lastFreezeGrantDay, today);
  if (Number.isFinite(since) && since >= FREEZE_GRANT_INTERVAL_DAYS) {
    s.lastFreezeGrantDay = today;
    s.freezes += 1;
    return true;
  }
  return false;
}

/**
 * Is the streak still live as of `today`, without mutating anything? Used by the HUD so the
 * chip can show "❄ frozen" before the next session rather than after.
 */
export function streakStatus(streak: StreakState, today: string = dayKey()): 'active' | 'at-risk' | 'frozen' | 'idle' {
  if (streak.lastDay === null || streak.current === 0) return 'idle';
  const gap = daysBetween(streak.lastDay, today);
  if (!Number.isFinite(gap) || gap <= 0) return 'active';
  if (gap === 1) return 'at-risk';
  const missed = gap - 1;
  return missed <= streak.freezes ? 'frozen' : 'idle';
}

/* ------------------------------------------------------------------ bond */

/**
 * Cumulative XP needed to *reach* each level. Deliberately shallow early (a first petting
 * session should visibly move the needle) and long at the top end.
 */
export const BOND_THRESHOLDS: readonly number[] = [0, 20, 55, 110, 190, 300, 450, 650, 900, 1250];

export function bondLevel(xp: number): number {
  const x = Math.max(0, Math.floor(xp || 0));
  let level = 1;
  for (let i = 0; i < BOND_THRESHOLDS.length; i++) {
    if (x >= BOND_THRESHOLDS[i]) level = i + 1;
  }
  return Math.min(MAX_BOND_LEVEL, level);
}

/** XP into the current level and XP needed for the next, for the bond bar. */
export function bondProgress(xp: number): { level: number; into: number; needed: number; maxed: boolean } {
  const level = bondLevel(xp);
  if (level >= MAX_BOND_LEVEL) return { level, into: 1, needed: 1, maxed: true };
  const floor = BOND_THRESHOLDS[level - 1];
  const ceil = BOND_THRESHOLDS[level];
  return { level, into: Math.max(0, xp - floor), needed: Math.max(1, ceil - floor), maxed: false };
}

export const BOND_XP = {
  pet: 3,
  /** Diminishing after the first few pets in a session, applied by the caller. */
  petRepeat: 1,
  snackEaten: 8,
  focusCompleted: 12,
  breakTogether: 4,
} as const;

export function addBondXp(xp: number, amount: number): { xp: number; level: number; leveledUp: boolean } {
  const before = bondLevel(xp);
  const next = Math.max(0, Math.floor(xp + Math.max(0, amount)));
  const after = bondLevel(next);
  return { xp: next, level: after, leveledUp: after > before };
}
