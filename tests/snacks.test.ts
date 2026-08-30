/**
 * The shop must never sell something the world cannot show you.
 *
 * A snack only ever reaches the floor if it is in an environment's pool AND unlocked
 * (`core/feeding.ts` intersects the two). Adding a snack to the catalogue without adding it to
 * any pool therefore produces a purchasable item that silently never appears — which is exactly
 * what happened the first time the meat aisle went in.
 */

import { describe, expect, it } from 'vitest';
import { SNACKS, SNACK_ORDER, DEFAULT_SNACKS } from '../src/data/snacks';
import { ENVIRONMENTS } from '../src/data/environments';
import { VENUES, VENUE_ORDER } from '../src/data/venues';

/** Every place a snack can actually be served. */
const POOLS: Array<{ where: string; snacks: readonly string[] }> = [
  ...Object.values(ENVIRONMENTS).map((e) => ({ where: `environment:${e.id}`, snacks: e.snacks })),
  ...VENUE_ORDER.map((id) => ({ where: `venue:${id}`, snacks: VENUES[id].snacks })),
];

describe('snack pools', () => {
  it('serves every snack in the catalogue somewhere', () => {
    const served = new Set(POOLS.flatMap((p) => [...p.snacks]));
    const orphans = SNACK_ORDER.filter((id) => !served.has(id));
    expect(orphans, 'buyable but never served').toEqual([]);
  });

  it('never lists a snack that does not exist', () => {
    for (const pool of POOLS) {
      for (const id of pool.snacks) {
        expect(SNACKS[id], `${pool.where} serves unknown snack ${id}`).toBeDefined();
      }
    }
  });

  it('gives every pool something a brand-new player already owns', () => {
    // Otherwise a first break in that world falls back to locked snacks.
    for (const pool of POOLS) {
      const free = pool.snacks.filter((id) => DEFAULT_SNACKS.includes(id));
      expect(free.length, `${pool.where} has nothing a new player owns`).toBeGreaterThan(0);
    }
  });

  it('prices the starter snacks at zero and everything else above it', () => {
    for (const id of SNACK_ORDER) {
      const def = SNACKS[id];
      if (DEFAULT_SNACKS.includes(id)) expect(def.price, id).toBe(0);
      else expect(def.price, id).toBeGreaterThan(0);
    }
  });

  it('gives the meat aisle its own shapes rather than reusing a pastry', () => {
    expect(SNACKS.friedchicken.shape).toBe('drumstick');
    expect(SNACKS.yakitori.shape).toBe('skewer');
    expect(SNACKS.steak.shape).toBe('chop');
  });
});
