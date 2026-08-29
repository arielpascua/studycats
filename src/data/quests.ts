/**
 * Daily quest catalogue. Progress is always derived from a counter the app already tracks, so
 * a quest can never desync from reality — there is no separate quest bookkeeping to drift.
 */

import type { EnvironmentId } from './environments';

export type QuestMetric =
  | 'pomodoros'
  | 'focusMinutes'
  | 'petsUnique'
  | 'snacksEaten'
  | 'breaksCompleted'
  | 'sceneMinutes';

export interface QuestDef {
  id: string;
  /** Copy in the product voice: an invitation, never an order. */
  title: string;
  metric: QuestMetric;
  goal: number;
  reward: number;
  /** Only for `sceneMinutes`. */
  environment?: EnvironmentId;
  /** Quests needing an unlocked world are filtered out until you own it. */
  requiresEnvironment?: EnvironmentId;
}

export const QUEST_POOL: readonly QuestDef[] = [
  { id: 'three-pomodoros', title: 'finish 3 pomodoros', metric: 'pomodoros', goal: 3, reward: 25 },
  { id: 'five-pomodoros', title: 'finish 5 pomodoros', metric: 'pomodoros', goal: 5, reward: 45 },
  { id: 'fifty-minutes', title: 'study for 50 minutes', metric: 'focusMinutes', goal: 50, reward: 30 },
  { id: 'ninety-minutes', title: 'study for 90 minutes', metric: 'focusMinutes', goal: 90, reward: 50 },
  { id: 'pet-every-cat', title: 'pet every cat once', metric: 'petsUnique', goal: 1, reward: 20 },
  { id: 'two-breaks', title: 'let 2 breaks run all the way', metric: 'breaksCompleted', goal: 2, reward: 20 },
  { id: 'four-snacks', title: 'watch 4 snacks get eaten', metric: 'snacksEaten', goal: 4, reward: 25 },
  { id: 'cafe-fifty', title: 'study 50 min in the café', metric: 'sceneMinutes', goal: 50, reward: 40, environment: 'cafe', requiresEnvironment: 'cafe' },
  { id: 'picnic-thirty', title: 'study 30 min on the hill', metric: 'sceneMinutes', goal: 30, reward: 35, environment: 'picnic', requiresEnvironment: 'picnic' },
  { id: 'bonfire-thirty', title: 'study 30 min by the fire', metric: 'sceneMinutes', goal: 30, reward: 35, environment: 'bonfire', requiresEnvironment: 'bonfire' },
];

export const QUESTS_PER_DAY = 3;

export function questById(id: string): QuestDef | undefined {
  return QUEST_POOL.find((q) => q.id === id);
}
