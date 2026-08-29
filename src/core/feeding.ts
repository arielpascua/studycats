/**
 * Break-time feeding — the claim/bite/cleanup model, deliberately separate from the meshes.
 *
 * The signature bug this design exists to prevent (spec §13): a cat picked up mid-eat leaving a
 * snack permanently claimed, so no other cat will ever touch it. Because claims live here and
 * nowhere else, `release(catId)` is the single, total answer, and cleanup is a set difference
 * rather than a hopeful traversal of the scene graph.
 *
 * Invariants, asserted by the tests:
 *   I1  every snack is claimed by at most one cat
 *   I2  a cat holds at most one claim (snack OR bowl seat)
 *   I3  a bowl seats at most MAX_CATS_PER_BOWL cats
 *   I4  after `end()` there are zero snacks, zero bowls and zero claims
 */

import { BITES_PER_SNACK, MAX_CATS_PER_BOWL, SNACKS } from '../data/snacks';
import type { Rng } from './rng';

export interface BowlState {
  id: string;
  kind: 'milk' | 'kibble';
  x: number;
  z: number;
  occupants: string[];
}

export interface SnackItem {
  id: string;
  /** Key into the SNACKS table. */
  def: string;
  x: number;
  z: number;
  bites: number;
  claimedBy: string | null;
}

export interface FeedingState {
  active: boolean;
  bowls: BowlState[];
  snacks: SnackItem[];
  /** catId → snack id or bowl id. The one place a claim is recorded. */
  claims: Record<string, string>;
  /** Snack ids fully eaten this break, for stats/quests. */
  eaten: string[];
}

export const MIN_SNACKS = 4;
export const MAX_SNACKS = 6;

export function createFeeding(): FeedingState {
  return { active: false, bowls: [], snacks: [], claims: {}, eaten: [] };
}

export interface BeginOptions {
  /** Snack ids the player has unlocked; the environment pool is intersected with this. */
  unlocked: readonly string[];
  /** Snack ids this environment offers. */
  pool: readonly string[];
  floor: { w: number; d: number };
  rng: Rng;
}

/** Start a feeding scene: two bowls plus 4-6 snacks scattered on the floor. */
export function begin(opts: BeginOptions): FeedingState {
  const available = opts.pool.filter((id) => opts.unlocked.includes(id) && SNACKS[id]);
  // A player who somehow owns nothing from this world still gets fed — bowls are never empty,
  // and we fall back to the environment's own pool rather than showing an empty floor.
  const source = available.length > 0 ? available : opts.pool.filter((id) => SNACKS[id]);

  const count = MIN_SNACKS + opts.rng.int(MAX_SNACKS - MIN_SNACKS + 1);
  const halfW = Math.max(1, opts.floor.w / 2 - 1.4);
  const halfD = Math.max(1, opts.floor.d / 2 - 1.4);

  const snacks: SnackItem[] = [];
  for (let i = 0; i < count; i++) {
    const def = source.length > 0 ? opts.rng.pick(source) : 'onigiri';
    snacks.push({
      id: `snack-${i}-${def}`,
      def,
      x: opts.rng.range(-halfW, halfW),
      z: opts.rng.range(-halfD * 0.7, halfD),
      bites: BITES_PER_SNACK,
      claimedBy: null,
    });
  }

  const bowls: BowlState[] = [
    { id: 'bowl-milk', kind: 'milk', x: -1.5, z: halfD * 0.55, occupants: [] },
    { id: 'bowl-kibble', kind: 'kibble', x: 1.5, z: halfD * 0.55, occupants: [] },
  ];

  return { active: true, bowls, snacks, claims: {}, eaten: [] };
}

/* ------------------------------------------------------------------ claims */

export function snackById(state: FeedingState, id: string): SnackItem | undefined {
  return state.snacks.find((s) => s.id === id);
}

export function bowlById(state: FeedingState, id: string): BowlState | undefined {
  return state.bowls.find((b) => b.id === id);
}

/** What a cat currently holds, if anything. */
export function claimOf(state: FeedingState, catId: string): string | null {
  return state.claims[catId] ?? null;
}

/**
 * Drop every claim held by `catId` — the total, idempotent answer to "the cat stopped eating",
 * whatever the reason (picked up, distracted, break ended, cat sent home).
 */
export function release(state: FeedingState, catId: string): FeedingState {
  if (!(catId in state.claims)) {
    // Still scrub the scene: a desynced occupant/claimedBy would otherwise deadlock a slot.
    const strayBowl = state.bowls.some((b) => b.occupants.includes(catId));
    const straySnack = state.snacks.some((s) => s.claimedBy === catId);
    if (!strayBowl && !straySnack) return state;
  }
  const claims = { ...state.claims };
  delete claims[catId];
  return {
    ...state,
    claims,
    snacks: state.snacks.map((s) => (s.claimedBy === catId ? { ...s, claimedBy: null } : s)),
    bowls: state.bowls.map((b) =>
      b.occupants.includes(catId) ? { ...b, occupants: b.occupants.filter((o) => o !== catId) } : b,
    ),
  };
}

export interface ClaimResult {
  state: FeedingState;
  /** The target the cat should walk to, or null when everything is taken. */
  target: { kind: 'snack' | 'bowl'; id: string; x: number; z: number } | null;
}

/**
 * Give `catId` something to eat: the nearest unclaimed snack, else a bowl with a free seat.
 * Releasing first keeps I2 true without the caller having to remember.
 */
export function claimNearest(state: FeedingState, catId: string, from: { x: number; z: number }): ClaimResult {
  if (!state.active) return { state, target: null };

  const existing = claimOf(state, catId);
  if (existing) {
    const snack = snackById(state, existing);
    if (snack && snack.bites > 0) return { state, target: { kind: 'snack', id: snack.id, x: snack.x, z: snack.z } };
    const bowl = bowlById(state, existing);
    if (bowl) return { state, target: { kind: 'bowl', id: bowl.id, x: bowl.x, z: bowl.z } };
  }

  let next = release(state, catId);

  let best: SnackItem | null = null;
  let bestDist = Infinity;
  for (const s of next.snacks) {
    if (s.claimedBy !== null || s.bites <= 0) continue;
    const d = (s.x - from.x) ** 2 + (s.z - from.z) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }

  if (best) {
    const chosen = best;
    next = {
      ...next,
      claims: { ...next.claims, [catId]: chosen.id },
      snacks: next.snacks.map((s) => (s.id === chosen.id ? { ...s, claimedBy: catId } : s)),
    };
    return { state: next, target: { kind: 'snack', id: chosen.id, x: chosen.x, z: chosen.z } };
  }

  let bestBowl: BowlState | null = null;
  let bowlDist = Infinity;
  for (const b of next.bowls) {
    if (b.occupants.length >= MAX_CATS_PER_BOWL) continue;
    const d = (b.x - from.x) ** 2 + (b.z - from.z) ** 2;
    if (d < bowlDist) {
      bowlDist = d;
      bestBowl = b;
    }
  }

  if (bestBowl) {
    const chosen = bestBowl;
    next = {
      ...next,
      claims: { ...next.claims, [catId]: chosen.id },
      bowls: next.bowls.map((b) => (b.id === chosen.id ? { ...b, occupants: [...b.occupants, catId] } : b)),
    };
    return { state: next, target: { kind: 'bowl', id: chosen.id, x: chosen.x, z: chosen.z } };
  }

  return { state: next, target: null };
}

export interface BiteResult {
  state: FeedingState;
  /** True when that bite finished the snack. */
  finished: boolean;
  /** Bites left, for the shrink animation. */
  remaining: number;
  accepted: boolean;
}

/**
 * Take one bite. Only the claiming cat may bite, so a raced double-bite from two cats is
 * impossible by construction rather than by timing luck.
 */
export function bite(state: FeedingState, catId: string, snackId: string): BiteResult {
  const snack = snackById(state, snackId);
  if (!state.active || !snack || snack.claimedBy !== catId || snack.bites <= 0) {
    return { state, finished: false, remaining: snack?.bites ?? 0, accepted: false };
  }
  const bites = snack.bites - 1;
  const finished = bites <= 0;
  const claims = { ...state.claims };
  if (finished) delete claims[catId];
  return {
    state: {
      ...state,
      claims,
      snacks: finished
        ? state.snacks.filter((s) => s.id !== snackId)
        : state.snacks.map((s) => (s.id === snackId ? { ...s, bites } : s)),
      eaten: finished ? [...state.eaten, snackId] : state.eaten,
    },
    finished,
    remaining: Math.max(0, bites),
    accepted: true,
  };
}

/** Bowls are infinite (spec reference notes) — a sip is pure flavour, it consumes nothing. */
export function sip(state: FeedingState, catId: string, bowlId: string): boolean {
  const bowl = bowlById(state, bowlId);
  return Boolean(state.active && bowl && bowl.occupants.includes(catId));
}

/**
 * End the scene. Returns the ids that must be removed from the 3D scene graph, so cleanup is a
 * set the renderer consumes rather than a traversal it hopes covers everything.
 */
export function end(state: FeedingState): { state: FeedingState; removed: string[] } {
  const removed = [...state.snacks.map((s) => s.id), ...state.bowls.map((b) => b.id)];
  return { state: createFeeding(), removed };
}

/** True when everything edible is gone — cats should drift back to lounging. */
export function isPickedClean(state: FeedingState): boolean {
  return state.active && state.snacks.length === 0;
}

/**
 * Development/test invariant check. Returns the list of violated invariants (empty = healthy).
 * Cheap enough to assert in tests after every operation.
 */
export function checkInvariants(state: FeedingState): string[] {
  const problems: string[] = [];

  for (const s of state.snacks) {
    if (s.claimedBy && state.claims[s.claimedBy] !== s.id) {
      problems.push(`I1: snack ${s.id} claimed by ${s.claimedBy} who does not hold it`);
    }
    if (s.bites < 0) problems.push(`bites went negative on ${s.id}`);
  }

  const holders = new Map<string, string>();
  for (const [catId, target] of Object.entries(state.claims)) {
    if (holders.has(catId)) problems.push(`I2: ${catId} holds two claims`);
    holders.set(catId, target);
    const snack = snackById(state, target);
    const bowl = bowlById(state, target);
    if (!snack && !bowl) problems.push(`I2: ${catId} claims missing target ${target}`);
    if (snack && snack.claimedBy !== catId) problems.push(`I1: ${target} does not point back at ${catId}`);
    if (bowl && !bowl.occupants.includes(catId)) problems.push(`I3: ${catId} not seated at ${target}`);
  }

  for (const b of state.bowls) {
    if (b.occupants.length > MAX_CATS_PER_BOWL) problems.push(`I3: bowl ${b.id} over capacity`);
    if (new Set(b.occupants).size !== b.occupants.length) problems.push(`I3: bowl ${b.id} seats a cat twice`);
    for (const o of b.occupants) {
      if (state.claims[o] !== b.id) problems.push(`I3: ${o} seated at ${b.id} without a claim`);
    }
  }

  if (!state.active && (state.snacks.length || state.bowls.length || Object.keys(state.claims).length)) {
    problems.push('I4: inactive feeding still holds objects');
  }

  return problems;
}
