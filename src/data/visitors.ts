/**
 * Rare visitors at the diorama edge (spec §8.4). ~8% chance per completed pomodoro; click to
 * log. Weather/season gates a couple of them so the collection has a reason to take months.
 */

import type { EnvironmentId } from './environments';
import type { Season } from '../core/time';

export interface VisitorDef {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  /** Relative weight in the draw. */
  weight: number;
  colorA: string;
  colorB: string;
  shape: 'bird' | 'hedgehog' | 'cat' | 'bug' | 'frog';
  environments?: readonly EnvironmentId[];
  seasons?: readonly Season[];
  /** Coins paid the first time you log it. */
  bounty: number;
}

export const VISITORS: Record<string, VisitorDef> = {
  pigeon: {
    id: 'pigeon', name: 'Pigeon', icon: '🐦', shape: 'bird', weight: 30,
    blurb: 'arrives with opinions. leaves before you finish reading them.',
    colorA: '#B7ADBE', colorB: '#7C6BB0', bounty: 15,
  },
  hedgehog: {
    id: 'hedgehog', name: 'Hedgehog', icon: '🦔', shape: 'hedgehog', weight: 22,
    blurb: 'came for the crumbs, stayed for the warmth.',
    colorA: '#8A6A55', colorB: '#DCC1A4', bounty: 25,
    environments: ['picnic', 'bonfire'],
  },
  'black-cat': {
    id: 'black-cat', name: 'The one in the rain', icon: '🐈‍⬛', shape: 'cat', weight: 8,
    blurb: 'sits just outside the light. does not come in. does not leave either.',
    colorA: '#241E33', colorB: '#A9D6C0', bounty: 60,
    environments: ['cafe', 'room'],
  },
  firefly: {
    id: 'firefly', name: 'Firefly', icon: '✨', shape: 'bug', weight: 18,
    blurb: 'one, then eleven, then one again.',
    colorA: '#F5E1A4', colorB: '#A9C293', bounty: 20,
    seasons: ['summer'],
  },
  frog: {
    id: 'frog', name: 'Rain frog', icon: '🐸', shape: 'frog', weight: 14,
    blurb: 'the rain is his. we are guests.',
    colorA: '#8FBF8A', colorB: '#4A6B4C', bounty: 30,
    seasons: ['rain'],
  },
  moth: {
    id: 'moth', name: 'Lamp moth', icon: '🦋', shape: 'bug', weight: 16,
    blurb: 'circles the desk lamp with total commitment.',
    colorA: '#DCC1A4', colorB: '#6F5A78', bounty: 18,
  },
};

export const VISITOR_ORDER: readonly string[] = Object.keys(VISITORS);

export const VISITOR_CHANCE = 0.08;

export function eligibleVisitors(env: EnvironmentId, s: Season): VisitorDef[] {
  return VISITOR_ORDER.map((id) => VISITORS[id]).filter((v) => {
    if (v.environments && !v.environments.includes(env)) return false;
    if (v.seasons && !v.seasons.includes(s)) return false;
    return true;
  });
}

/** Weighted pick from the eligible pool. `roll` is 0..1 — inject it for deterministic tests. */
export function pickVisitor(env: EnvironmentId, s: Season, roll: number): VisitorDef | null {
  const pool = eligibleVisitors(env, s);
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, v) => sum + v.weight, 0);
  let cursor = Math.min(0.9999999, Math.max(0, roll)) * total;
  for (const v of pool) {
    cursor -= v.weight;
    if (cursor < 0) return v;
  }
  return pool[pool.length - 1];
}
