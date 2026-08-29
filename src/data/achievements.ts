/**
 * Achievement catalogue. Each is a *pure predicate over a context object* — no side effects,
 * no clocks read inside, so re-evaluating is free and can never double-award (the caller
 * diffs against the already-unlocked set).
 */

import { bondLevel } from '../core/economy';
import type { GameState } from '../core/state';
import { activeDays } from '../core/state';
import { SNACK_ORDER } from './snacks';
import { ENVIRONMENT_ORDER } from './environments';

export interface AchievementContext {
  state: GameState;
  /** Local hour 0-23 of the moment being evaluated — for "Night Owl". */
  hour: number;
  /** Today's key. */
  today: string;
  /** Konami code entered this session. */
  konami: boolean;
}

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  icon: string;
  /** Hidden achievements show as ??? until unlocked. */
  secret?: boolean;
  test: (ctx: AchievementContext) => boolean;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  {
    id: 'first-focus',
    title: 'First Focus',
    description: 'finish one pomodoro',
    icon: '🐟',
    test: ({ state }) => state.stats.totalPomodoros >= 1,
  },
  {
    id: 'night-owl',
    title: 'Night Owl',
    description: 'finish a session after midnight',
    icon: '🌙',
    test: ({ state, hour }) => state.stats.totalPomodoros >= 1 && hour >= 0 && hour < 5,
  },
  {
    id: 'early-bird',
    title: 'Early Bird',
    description: 'finish a session before 7am',
    icon: '🌅',
    test: ({ state, hour }) => state.stats.totalPomodoros >= 1 && hour >= 5 && hour < 7,
  },
  {
    id: 'full-house',
    title: 'Full House',
    description: 'live with 8 cats at once',
    icon: '🏠',
    test: ({ state }) => state.cats.length >= 8,
  },
  {
    id: 'gourmet',
    title: 'Gourmet',
    description: 'every snack tasted at least once',
    icon: '🍙',
    test: ({ state }) => SNACK_ORDER.every((id) => state.unlocks.snacksTasted.includes(id)),
  },
  {
    id: 'marathon',
    title: 'Marathon',
    description: '8 pomodoros in one day',
    icon: '🏃',
    test: ({ state, today }) => (state.stats.perDay[today]?.p ?? 0) >= 8,
  },
  {
    id: 'best-friends',
    title: 'Best Friends',
    description: 'take one cat to bond level 10',
    icon: '💞',
    test: ({ state }) => state.cats.some((c) => bondLevel(c.bondXp) >= 10),
  },
  {
    id: 'weather-watcher',
    title: 'Weather Watcher',
    description: 'study in all four worlds',
    icon: '🌦',
    test: ({ state }) => ENVIRONMENT_ORDER.every((env) => (state.stats.sceneMinutes[env] ?? 0) > 0),
  },
  {
    id: 'week-one',
    title: 'Week One',
    description: 'a 7-day streak',
    icon: '📅',
    test: ({ state }) => state.economy.streak.best >= 7,
  },
  {
    id: 'century',
    title: 'Century',
    description: '100 pomodoros, all time',
    icon: '💯',
    test: ({ state }) => state.stats.totalPomodoros >= 100,
  },
  {
    id: 'regular',
    title: 'Regular',
    description: 'study on 30 different days',
    icon: '🗓',
    test: ({ state }) => activeDays(state.stats) >= 30,
  },
  {
    id: 'photographer',
    title: 'Photographer',
    description: 'take a photo of the room',
    icon: '📷',
    test: ({ state }) => state.stats.photosTaken >= 1,
  },
  {
    id: 'naturalist',
    title: 'Naturalist',
    description: 'log four different visitors',
    icon: '🔭',
    test: ({ state }) => state.unlocks.visitors.length >= 4,
  },
  {
    id: 'trickster',
    title: 'Trickster',
    description: 'see three different tricks',
    icon: '🎪',
    test: ({ state }) => state.unlocks.tricksSeen.length >= 3,
  },
  {
    id: 'patient',
    title: 'Patient',
    description: 'let ten breaks run all the way through',
    icon: '🫖',
    test: ({ state }) => state.stats.totalBreakMin >= 50,
  },
  {
    id: 'secret-robo',
    title: '???',
    description: 'a small metal cat comes to visit',
    icon: '🤖',
    secret: true,
    test: ({ konami, state }) => konami || state.cats.some((c) => c.breed === 'robo'),
  },
];

export function achievementById(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}
