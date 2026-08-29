import { describe, it, expect } from 'vitest';
import {
  begin,
  bite,
  checkInvariants,
  claimNearest,
  claimOf,
  createFeeding,
  end,
  isPickedClean,
  MAX_SNACKS,
  MIN_SNACKS,
  release,
  sip,
  snackById,
  type FeedingState,
} from '../src/core/feeding';
import { makeRng } from '../src/core/rng';
import { BITES_PER_SNACK, MAX_CATS_PER_BOWL } from '../src/data/snacks';
import { ENVIRONMENTS } from '../src/data/environments';

const ROOM = ENVIRONMENTS.room;

function startScene(seed = 7, unlocked: readonly string[] = ROOM.snacks): FeedingState {
  return begin({ unlocked, pool: ROOM.snacks, floor: ROOM.floor, rng: makeRng(seed) });
}

const healthy = (s: FeedingState) => expect(checkInvariants(s)).toEqual([]);

describe('AC-11 spawn and cleanup', () => {
  it('spawns two bowls and 4-6 snacks inside the floor', () => {
    for (let seed = 0; seed < 40; seed++) {
      const s = startScene(seed);
      expect(s.active).toBe(true);
      expect(s.bowls).toHaveLength(2);
      expect(s.snacks.length).toBeGreaterThanOrEqual(MIN_SNACKS);
      expect(s.snacks.length).toBeLessThanOrEqual(MAX_SNACKS);
      for (const snack of s.snacks) {
        expect(Math.abs(snack.x)).toBeLessThanOrEqual(ROOM.floor.w / 2);
        expect(Math.abs(snack.z)).toBeLessThanOrEqual(ROOM.floor.d / 2);
        expect(snack.bites).toBe(BITES_PER_SNACK);
      }
      healthy(s);
    }
  });

  it('is deterministic for a given seed', () => {
    expect(startScene(11).snacks).toEqual(startScene(11).snacks);
  });

  it('only spawns snacks the player has unlocked', () => {
    const s = startScene(3, ['onigiri']);
    expect(new Set(s.snacks.map((x) => x.def))).toEqual(new Set(['onigiri']));
  });

  it('still feeds the cats when the player owns nothing from this world', () => {
    const s = startScene(3, []);
    expect(s.snacks.length).toBeGreaterThanOrEqual(MIN_SNACKS);
    expect(s.bowls).toHaveLength(2);
  });

  it('end() removes every object and leaves zero claims — even mid-meal', () => {
    let s = startScene(5);
    s = claimNearest(s, 'cat-a', { x: 0, z: 0 }).state;
    s = claimNearest(s, 'cat-b', { x: 2, z: 1 }).state;
    s = bite(s, 'cat-a', claimOf(s, 'cat-a')!).state;

    const before = s.snacks.length + s.bowls.length;
    const { state: after, removed } = end(s);

    expect(removed).toHaveLength(before);
    expect(after.snacks).toHaveLength(0);
    expect(after.bowls).toHaveLength(0);
    expect(after.claims).toEqual({});
    expect(after.active).toBe(false);
    healthy(after);
  });

  it('a fresh scene after a mid-break skip leaks nothing from the previous one', () => {
    let s = startScene(9);
    s = claimNearest(s, 'cat-a', { x: 0, z: 0 }).state;
    const { state: cleaned } = end(s);
    const next = startScene(10);
    expect(cleaned.claims).toEqual({});
    expect(next.claims).toEqual({});
    healthy(next);
  });

  it('cleanup is idempotent', () => {
    const first = end(startScene(2));
    const second = end(first.state);
    expect(second.removed).toEqual([]);
    healthy(second.state);
  });
});

describe('AC-12 no claimed-snack deadlock', () => {
  it('picking a cat up mid-eat frees its snack for another cat', () => {
    let s = startScene(4);
    const a = claimNearest(s, 'cat-a', { x: 0, z: 0 });
    s = a.state;
    const target = a.target!;
    expect(target.kind).toBe('snack');
    expect(snackById(s, target.id)!.claimedBy).toBe('cat-a');

    // Yanked off the floor by the user mid-bite.
    s = release(s, 'cat-a');
    expect(snackById(s, target.id)!.claimedBy).toBeNull();
    expect(claimOf(s, 'cat-a')).toBeNull();
    healthy(s);

    const b = claimNearest(s, 'cat-b', { x: target.x, z: target.z });
    expect(b.target!.id).toBe(target.id);
    healthy(b.state);
  });

  it('release is idempotent and safe for a cat that never ate', () => {
    let s = startScene(4);
    s = release(s, 'ghost');
    s = release(s, 'ghost');
    healthy(s);
  });

  it('never lets two cats claim the same snack', () => {
    let s = startScene(6);
    const seen = new Set<string>();
    for (let i = 0; i < s.snacks.length + 4; i++) {
      const r = claimNearest(s, `cat-${i}`, { x: 0, z: 0 });
      s = r.state;
      if (r.target?.kind === 'snack') {
        expect(seen.has(r.target.id)).toBe(false);
        seen.add(r.target.id);
      }
      healthy(s);
    }
  });

  it('re-claiming returns the same target instead of stealing a second one', () => {
    let s = startScene(8);
    const first = claimNearest(s, 'cat-a', { x: 0, z: 0 });
    s = first.state;
    const second = claimNearest(s, 'cat-a', { x: 3, z: 3 });
    expect(second.target!.id).toBe(first.target!.id);
    expect(Object.keys(second.state.claims)).toEqual(['cat-a']);
  });

  it('seats at most two cats per bowl and hands out null when everything is taken', () => {
    // One snack, so the rest must go to bowls.
    let s = startScene(1, ['onigiri']);
    s = { ...s, snacks: s.snacks.slice(0, 1) };

    const targets: Array<string | null> = [];
    for (let i = 0; i < 8; i++) {
      const r = claimNearest(s, `cat-${i}`, { x: i - 4, z: 0 });
      s = r.state;
      targets.push(r.target?.id ?? null);
      healthy(s);
    }

    for (const bowl of s.bowls) {
      expect(bowl.occupants.length).toBeLessThanOrEqual(MAX_CATS_PER_BOWL);
    }
    // 1 snack + 2 bowls x 2 seats = 5 fed, the rest get nothing rather than a broken claim.
    expect(targets.filter((t) => t !== null)).toHaveLength(5);
    expect(targets.filter((t) => t === null)).toHaveLength(3);
  });

  it('leaving a bowl frees the seat', () => {
    let s = startScene(1, ['onigiri']);
    s = { ...s, snacks: [] };
    s = claimNearest(s, 'cat-a', { x: -1.5, z: 2 }).state;
    s = claimNearest(s, 'cat-b', { x: -1.5, z: 2 }).state;
    const bowl = s.bowls.find((b) => b.occupants.length === 2)!;
    expect(sip(s, 'cat-a', bowl.id)).toBe(true);

    s = release(s, 'cat-a');
    expect(s.bowls.find((b) => b.id === bowl.id)!.occupants).toEqual(['cat-b']);
    const c = claimNearest(s, 'cat-c', { x: bowl.x, z: bowl.z });
    expect(c.target!.id).toBe(bowl.id);
    healthy(c.state);
  });
});

describe('biting', () => {
  it('takes two bites to finish a snack, then removes it and frees the cat', () => {
    let s = startScene(12);
    const r = claimNearest(s, 'cat-a', { x: 0, z: 0 });
    s = r.state;
    const id = r.target!.id;

    const first = bite(s, 'cat-a', id);
    s = first.state;
    expect(first.accepted).toBe(true);
    expect(first.finished).toBe(false);
    expect(first.remaining).toBe(1);
    expect(snackById(s, id)).toBeDefined();

    const second = bite(s, 'cat-a', id);
    s = second.state;
    expect(second.finished).toBe(true);
    expect(snackById(s, id)).toBeUndefined();
    expect(claimOf(s, 'cat-a')).toBeNull();
    expect(s.eaten).toContain(id);
    healthy(s);
  });

  it('refuses a bite from a cat that did not claim the snack', () => {
    let s = startScene(13);
    const r = claimNearest(s, 'cat-a', { x: 0, z: 0 });
    s = r.state;
    const bad = bite(s, 'cat-b', r.target!.id);
    expect(bad.accepted).toBe(false);
    expect(bad.state).toBe(s);
    healthy(s);
  });

  it('refuses a bite on a missing snack or an inactive scene', () => {
    const s = startScene(14);
    expect(bite(s, 'cat-a', 'nope').accepted).toBe(false);
    expect(bite(createFeeding(), 'cat-a', 'nope').accepted).toBe(false);
  });

  it('reports a picked-clean floor once every snack is gone', () => {
    let s = startScene(15);
    expect(isPickedClean(s)).toBe(false);
    let guard = 0;
    while (s.snacks.length > 0 && guard++ < 50) {
      const r = claimNearest(s, 'cat-a', { x: 0, z: 0 });
      s = r.state;
      if (r.target?.kind !== 'snack') break;
      s = bite(s, 'cat-a', r.target.id).state;
      s = bite(s, 'cat-a', r.target.id).state;
    }
    expect(s.snacks).toHaveLength(0);
    expect(isPickedClean(s)).toBe(true);
    healthy(s);
  });

  it('survives a fuzz of interleaved claims, bites, releases and pickups', () => {
    const rng = makeRng(99);
    let s = startScene(21);
    const cats = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 3000; i++) {
      const cat = rng.pick(cats);
      const roll = rng();
      if (roll < 0.4) {
        s = claimNearest(s, cat, { x: rng.range(-4, 4), z: rng.range(-3, 3) }).state;
      } else if (roll < 0.75) {
        const held = claimOf(s, cat);
        if (held) s = bite(s, cat, held).state;
      } else if (roll < 0.95) {
        s = release(s, cat);
      } else {
        const { state } = end(s);
        s = state.active ? state : startScene(rng.int(1000));
      }
      expect(checkInvariants(s)).toEqual([]);
    }
  });
});
