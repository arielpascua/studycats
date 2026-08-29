/**
 * Achievement evaluation. Idempotent by construction: `evaluate` returns only the ids that are
 * newly true, and the caller folds them into `unlocks.achievements`. Re-running with the same
 * state yields an empty array.
 */

import { ACHIEVEMENTS, type AchievementContext, type AchievementDef } from '../data/achievements';

export function evaluate(ctx: AchievementContext): AchievementDef[] {
  const owned = new Set(ctx.state.unlocks.achievements);
  const newly: AchievementDef[] = [];
  for (const def of ACHIEVEMENTS) {
    if (owned.has(def.id)) continue;
    let passed = false;
    try {
      passed = def.test(ctx);
    } catch {
      // A malformed save must never take the whole app down over a trophy.
      passed = false;
    }
    if (passed) newly.push(def);
  }
  return newly;
}

/** Progress for the cat-alogue page: how many of the catalogue are unlocked. */
export function achievementProgress(unlocked: readonly string[]): { done: number; total: number } {
  const owned = new Set(unlocked);
  return { done: ACHIEVEMENTS.filter((a) => owned.has(a.id)).length, total: ACHIEVEMENTS.length };
}

/** Konami sequence — the Robo cat Easter egg (spec §8.8). */
export const KONAMI: readonly string[] = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'b', 'a',
];

/**
 * Fold one key into a rolling buffer and report whether the code just completed.
 * Pure: the caller owns the buffer.
 */
export function pushKonami(buffer: readonly string[], key: string): { buffer: string[]; complete: boolean } {
  const k = key.length === 1 ? key.toLowerCase() : key;
  const next = [...buffer, k].slice(-KONAMI.length);
  const complete = next.length === KONAMI.length && next.every((v, i) => v === KONAMI[i]);
  return { buffer: complete ? [] : next, complete };
}
