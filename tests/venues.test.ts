/**
 * Venues: the party can meet in five different places, and every one of them has to obey the
 * same two promises the clearing made — it seats the whole party, and it never costs you a
 * venue you already paid for.
 */

import { describe, expect, it } from 'vitest';
import { arenaDefFor, DEFAULT_VENUE, isVenueId, VENUES, VENUE_ORDER, venueDef } from '../src/data/venues';
import { ENVIRONMENTS } from '../src/data/environments';
import { SNACKS } from '../src/data/snacks';
import { createDefaultState, SAVE_VERSION } from '../src/core/state';
import { migrate, normalize } from '../src/core/save';

describe('venue catalogue', () => {
  it('lists every venue exactly once, in order', () => {
    expect([...VENUE_ORDER].sort()).toEqual(Object.keys(VENUES).sort());
    expect(new Set(VENUE_ORDER).size).toBe(VENUE_ORDER.length);
  });

  it('keeps one venue free, so party mode always has somewhere to go', () => {
    expect(VENUES[DEFAULT_VENUE].price).toBe(0);
    const free = VENUE_ORDER.filter((id) => VENUES[id].price === 0);
    expect(free).toEqual([DEFAULT_VENUE]);
  });

  it('only offers snacks that exist', () => {
    for (const id of VENUE_ORDER) {
      for (const snack of VENUES[id].snacks) {
        expect(SNACKS[snack], `${id} offers unknown snack ${snack}`).toBeDefined();
      }
    }
  });

  it('gives every venue five hearth tiers, one per bonfire stage', () => {
    for (const id of VENUE_ORDER) {
      expect(VENUES[id].theme.hearth.tiers, id).toHaveLength(5);
    }
  });

  it('puts the surround outside the biggest party the arena can seat', () => {
    // MAX_PARTY of 8 gives a ring radius under 9 units; a surround inside that would be
    // standing on the cushions.
    for (const id of VENUE_ORDER) {
      expect(VENUES[id].theme.surround.radius, id).toBeGreaterThan(12);
    }
  });

  it('falls back to the free venue for anything unrecognised', () => {
    expect(venueDef('not-a-venue').id).toBe(DEFAULT_VENUE);
    expect(isVenueId('library')).toBe(true);
    expect(isVenueId('not-a-venue')).toBe(false);
  });
});

describe('arenaDefFor', () => {
  it('themes the label and light but keeps the arena shell and floor plan', () => {
    const base = ENVIRONMENTS.arena;
    for (const id of VENUE_ORDER) {
      const def = arenaDefFor(id);
      expect(def.id).toBe('arena');
      expect(def.floor).toEqual(base.floor);
      // The footprint never varies by venue — only the lid does, and only because an interior
      // has one. Everything the cats and the camera are clamped to stays the arena's.
      const { ceiling: _lid, ...footprint } = def.shell;
      const { ceiling: _baseLid, ...baseFootprint } = base.shell;
      expect(footprint).toEqual(baseFootprint);
      expect(def.label).toBe(VENUES[id].label);
      expect(def.sky.night).toBe(VENUES[id].sky);
      expect(def.key.night.color).toBe(VENUES[id].theme.key.color);
    }
  });

  it('keeps the eye under any lid the venue actually draws', () => {
    // `shell.ceiling` is the camera rig's vertical limit. When a venue draws a real ceiling and
    // this is left at the open-sky value, the rig climbs above the lid while framing a break and
    // renders the room from the roof — the whole scene goes black.
    for (const id of VENUE_ORDER) {
      const lid = VENUES[id].theme.ceiling;
      if (!lid) continue;
      expect(arenaDefFor(id).shell.ceiling, `${id} lets the eye reach its ceiling`).toBeLessThan(lid.y);
    }
  });

  it('builds walls tall enough to meet their own ceiling', () => {
    for (const id of VENUE_ORDER) {
      const { ceiling, surround } = VENUES[id].theme;
      if (!ceiling) continue;
      expect(surround.minHeight, `${id} has a gap between wall and ceiling`).toBeGreaterThanOrEqual(ceiling.y);
    }
  });

  it('leaves open-air venues their sky', () => {
    for (const id of VENUE_ORDER) {
      if (VENUES[id].theme.ceiling) continue;
      expect(arenaDefFor(id).shell.ceiling).toBe(ENVIRONMENTS.arena.shell.ceiling);
    }
  });

  it('is phase-independent — you went somewhere, not to a time of day', () => {
    const def = arenaDefFor('library');
    const phases = Object.values(def.sky);
    expect(new Set(phases).size).toBe(1);
  });
});

describe('save v4 -> v5', () => {
  it('gives an existing party the free venue and nothing else', () => {
    const legacy = {
      version: 4,
      cats: [],
      economy: { coins: 10 },
      unlocks: { environments: ['room'], cosmetics: [] },
      settings: { mode: 'party', environment: 'room' },
      party: {},
    };
    const { raw, migrated, fromVersion } = migrate(legacy as never);
    expect(migrated).toBe(true);
    expect(fromVersion).toBe(4);
    expect(raw.version).toBe(SAVE_VERSION);

    const state = normalize(raw);
    expect(state.unlocks.venues).toEqual([DEFAULT_VENUE]);
    expect(state.settings.venue).toBe(DEFAULT_VENUE);
  });

  it('refuses to stand the party in a venue it does not own', () => {
    const state = normalize({
      version: SAVE_VERSION,
      unlocks: { venues: ['library'] },
      settings: { venue: 'museum' },
    } as never);
    expect(state.unlocks.venues).toContain('library');
    expect(state.settings.venue).toBe(DEFAULT_VENUE);
  });

  it('keeps a venue the save legitimately owns', () => {
    const state = normalize({
      version: SAVE_VERSION,
      unlocks: { venues: ['library', 'museum'] },
      settings: { venue: 'museum' },
    } as never);
    expect(state.settings.venue).toBe('museum');
  });

  it('drops junk venue ids without losing the real ones', () => {
    const state = normalize({
      version: SAVE_VERSION,
      unlocks: { venues: ['library', 'atlantis', 42, null] },
    } as never);
    expect(state.unlocks.venues).toEqual([DEFAULT_VENUE, 'library']);
  });

  it('a fresh save already owns the free venue', () => {
    expect(createDefaultState('2026-01-01').unlocks.venues).toEqual([DEFAULT_VENUE]);
  });
});
