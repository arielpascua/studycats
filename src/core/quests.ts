/**
 * Daily quests — pure functions of `(state, dayKey)`.
 *
 * The daily set is *derived from a seeded shuffle of the day key*, not stored randomly, so the
 * same day always produces the same three quests no matter how many times the app reloads.
 * Only progress and claim flags persist.
 */

import { QUEST_POOL, QUESTS_PER_DAY, questById, type QuestDef } from '../data/quests';
import type { DailySave, QuestSave } from './state';
import { hashSeed, makeRng } from './rng';

export interface DailyCounters {
  pomodoros: number;
  focusMinutes: number;
  /** Distinct cats petted today ÷ total cats — 1 when every cat has been petted. */
  petsUnique: number;
  snacksEaten: number;
  breaksCompleted: number;
  sceneMinutes: Partial<Record<string, number>>;
}

export function emptyCounters(): DailyCounters {
  return { pomodoros: 0, focusMinutes: 0, petsUnique: 0, snacksEaten: 0, breaksCompleted: 0, sceneMinutes: {} };
}

/** The three quests for `day`, filtered to worlds the player actually owns. */
export function questsForDay(day: string, ownedEnvironments: readonly string[]): QuestDef[] {
  const eligible = QUEST_POOL.filter((q) => !q.requiresEnvironment || ownedEnvironments.includes(q.requiresEnvironment));
  const rng = makeRng(hashSeed(`quests:${day}`));
  const shuffled = rng.shuffle(eligible);
  // Avoid handing out two quests on the same metric — it reads as a bug even when it isn't.
  const chosen: QuestDef[] = [];
  const seen = new Set<string>();
  for (const q of shuffled) {
    const key = q.metric === 'sceneMinutes' ? `scene:${q.environment}` : q.metric;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(q);
    if (chosen.length >= QUESTS_PER_DAY) break;
  }
  // Small pools (day one, only the room owned) can under-fill; top up allowing duplicates by metric.
  for (const q of shuffled) {
    if (chosen.length >= QUESTS_PER_DAY) break;
    if (!chosen.includes(q)) chosen.push(q);
  }
  return chosen;
}

/**
 * Roll the quest board over to `today` if needed. Idempotent: calling it repeatedly within a
 * day is a no-op, so it is safe on every tick.
 */
export function rolloverQuests(save: QuestSave, today: string, ownedEnvironments: readonly string[]): QuestSave {
  if (save.day === today && save.quests.length > 0) return save;
  const quests = questsForDay(today, ownedEnvironments).map((q) => ({ id: q.id, progress: 0, claimed: false }));
  return { day: today, quests };
}

/** Progress for one quest, read straight from today's counters. */
export function questProgress(def: QuestDef, counters: DailyCounters): number {
  switch (def.metric) {
    case 'pomodoros':
      return counters.pomodoros;
    case 'focusMinutes':
      return counters.focusMinutes;
    case 'petsUnique':
      return counters.petsUnique;
    case 'snacksEaten':
      return counters.snacksEaten;
    case 'breaksCompleted':
      return counters.breaksCompleted;
    case 'sceneMinutes':
      return def.environment ? counters.sceneMinutes[def.environment] ?? 0 : 0;
    default:
      return 0;
  }
}

export interface QuestView {
  def: QuestDef;
  progress: number;
  goal: number;
  complete: boolean;
  claimed: boolean;
}

export function questViews(save: QuestSave, counters: DailyCounters): QuestView[] {
  return save.quests
    .map((entry) => {
      const def = questById(entry.id);
      if (!def) return null;
      const progress = Math.min(def.goal, questProgress(def, counters));
      return { def, progress, goal: def.goal, complete: progress >= def.goal, claimed: entry.claimed };
    })
    .filter((v): v is QuestView => v !== null);
}

/**
 * Claim every completed-but-unclaimed quest. Returns the new save plus the coins owed, so the
 * caller does the paying — this module never touches the economy directly.
 */
export function claimCompleted(save: QuestSave, counters: DailyCounters): { save: QuestSave; reward: number; claimedIds: string[] } {
  let reward = 0;
  const claimedIds: string[] = [];
  const quests = save.quests.map((entry) => {
    if (entry.claimed) return entry;
    const def = questById(entry.id);
    if (!def) return entry;
    const progress = questProgress(def, counters);
    if (progress < def.goal) return { ...entry, progress };
    reward += def.reward;
    claimedIds.push(def.id);
    return { ...entry, progress: def.goal, claimed: true };
  });
  return { save: { ...save, quests }, reward, claimedIds };
}

/** Counters the quest board reads, assembled from the persisted daily slice. */
export function countersFrom(daily: DailySave, totalCats: number): DailyCounters {
  const cats = Math.max(1, totalCats);
  const petted = new Set(daily.pettedCats).size;
  return {
    pomodoros: daily.pomodoros,
    focusMinutes: Math.floor(daily.focusMinutes),
    petsUnique: petted >= cats ? 1 : 0,
    snacksEaten: daily.snacksEaten,
    breaksCompleted: daily.breaksCompleted,
    sceneMinutes: { ...daily.sceneMinutes },
  };
}
