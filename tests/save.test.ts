import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearSave,
  describeSave,
  deserialize,
  exportSave,
  importSave,
  loadGame,
  memoryStorage,
  migrate,
  normalize,
  saveGame,
  serialize,
  STORAGE_KEY,
} from '../src/core/save';
import { createDefaultState, SAVE_VERSION } from '../src/core/state';

const TODAY = '2026-08-29';

describe('AC-8 save round-trip', () => {
  it('load(save(state)) deep-equals state', () => {
    const storage = memoryStorage();
    const state = createDefaultState(TODAY);
    state.economy.coins = 340;
    state.economy.streak = { current: 6, best: 9, lastDay: TODAY, freezes: 1, lastFreezeGrantDay: TODAY, frozenDays: ['2026-08-20'] };
    state.stats.totalPomodoros = 42;
    state.stats.perDay[TODAY] = { p: 4, m: 100 };
    state.stats.sceneMinutes.cafe = 60;
    state.unlocks.environments = ['room', 'cafe'];
    state.unlocks.furniture = ['rug-clover', 'tower-basic'];
    state.unlocks.placements = { room: { 'floor-a': 'rug-clover', corner: 'tower-basic' } };
    state.settings.environment = 'cafe';
    state.settings.pixelScale = 4;
    state.timer = { mode: 'focus', running: true, remainingMs: 900_000, endsAt: 1_800_000_000_000, round: 2, task: 'thesis' };

    expect(saveGame(state, storage)).toBe(true);
    const result = loadGame(storage, TODAY);
    expect(result.status).toBe('loaded');
    expect(result.state).toEqual(state);
  });

  it('serialize/deserialize is lossless for the same state', () => {
    const state = createDefaultState(TODAY);
    const { state: back } = deserialize(serialize(state), TODAY);
    expect(back).toEqual(state);
  });

  it('returns a fresh default when nothing is stored', () => {
    const storage = memoryStorage();
    const r = loadGame(storage, TODAY);
    expect(r.status).toBe('fresh');
    expect(r.state.cats).toHaveLength(1);
    expect(r.state.version).toBe(SAVE_VERSION);
  });

  it('recovers from a corrupt blob instead of throwing', () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, '{"cats": [ this is not json');
    const r = loadGame(storage, TODAY);
    expect(r.status).toBe('recovered');
    expect(r.error).toBeTruthy();
    expect(r.state.cats.length).toBeGreaterThan(0);
  });

  it('survives a save that is valid JSON but structurally wrong', () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, '"just a string"');
    const r = loadGame(storage, TODAY);
    expect(r.state.version).toBe(SAVE_VERSION);
    expect(r.state.economy.coins).toBe(0);
  });

  it('clearSave wipes the slot', () => {
    const storage = memoryStorage();
    saveGame(createDefaultState(TODAY), storage);
    clearSave(storage);
    expect(loadGame(storage, TODAY).status).toBe('fresh');
  });

  it('reports failure rather than throwing when storage rejects the write', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(saveGame(createDefaultState(TODAY), hostile)).toBe(false);
  });
});

describe('AC-8 migrations', () => {
  const V1 = {
    version: 1,
    coins: 120,
    lifetimeCoins: 200,
    streak: { current: 3, best: 5, lastDay: '2026-08-20', freezes: 1 },
    cats: [
      { id: 'c1', breed: 'strawberry', name: 'Mochi', xp: 60, pets: 12 },
      { id: 'c2', breed: 'snow', name: 'Yuki', xp: 0, pets: 0 },
    ],
    unlocks: { breeds: ['strawberry', 'snow'], snacks: ['onigiri'], scenes: ['room', 'picnic'] },
    stats: { totalPomodoros: 30, totalFocusMin: 750, todayPomodoros: 3, todayMinutes: 75 },
    settings: { volume: { master: 0.5 }, timer: { focusMin: 50 } },
  };

  it('walks v1 all the way to the current version', () => {
    const { raw, migrated, fromVersion } = migrate({ ...V1 });
    expect(fromVersion).toBe(1);
    expect(migrated).toBe(true);
    expect(raw.version).toBe(SAVE_VERSION);
  });

  it('v1 renames survive normalization with the right values', () => {
    const state = normalize(migrate({ ...V1 }).raw, TODAY);
    expect(state.economy.coins).toBe(120);
    expect(state.economy.lifetimeCoins).toBe(200);
    expect(state.economy.streak.best).toBe(5);
    expect(state.cats[0].bondXp).toBe(60);
    expect(state.cats[0].petCount).toBe(12);
    expect(state.cats).toHaveLength(2);
    expect(state.unlocks.environments).toEqual(['room', 'picnic']);
    expect(state.settings.timer.focusMin).toBe(50);
    expect(state.settings.volume.master).toBe(0.5);
    // v2->v3 lifted the day counters out of stats
    expect(state.daily.day).toBe(TODAY);
  });

  it('loading a v1 blob reports "migrated"', () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(V1));
    const r = loadGame(storage, TODAY);
    expect(r.status).toBe('migrated');
    expect(r.fromVersion).toBe(1);
    expect(r.state.economy.coins).toBe(120);
  });

  it('preserves v2 daily counters when the stored day is still today', () => {
    const v2 = {
      version: 2,
      quests: { day: TODAY, quests: [] },
      stats: { todayPomodoros: 4, todayMinutes: 100, totalPomodoros: 4 },
      cats: [{ id: 'c1', breed: 'calico', name: 'Ume', bondXp: 5 }],
    };
    const state = normalize(migrate(v2).raw, TODAY);
    expect(state.daily.pomodoros).toBe(4);
    expect(state.daily.focusMinutes).toBe(100);
  });

  it('a migration never throws on a half-empty old save', () => {
    for (const partial of [{ version: 1 }, { version: 2 }, { version: 1, cats: 'nope' }, {}]) {
      expect(() => normalize(migrate(partial as never).raw, TODAY)).not.toThrow();
    }
  });

  it('passes a future version through untouched rather than corrupting it', () => {
    const { raw, migrated } = migrate({ version: 99, economy: { coins: 5 } });
    expect(migrated).toBe(false);
    expect(normalize(raw, TODAY).economy.coins).toBe(5);
  });
});

describe('AC-8 normalization hardening', () => {
  it('drops unknown breeds, snacks, furniture and environments', () => {
    const state = normalize(
      {
        cats: [{ id: 'x', breed: 'dragon', name: 'Nope' }, { id: 'y', breed: 'calico', name: 'Ume' }],
        unlocks: {
          breeds: ['calico', 'not-a-breed'],
          snacks: ['onigiri', 'pizza'],
          furniture: ['rug-clover', 'ferrari'],
          environments: ['cafe', 'moon'],
          placements: {
            room: { 'floor-a': 'rug-clover', hatch: 'rug-clover', corner: 'ferrari' },
            mars: { 'floor-a': 'rug-clover' },
          },
        },
      },
      TODAY,
    );
    expect(state.cats.map((c) => c.breed)).toEqual(['calico']);
    expect(state.unlocks.snacks).not.toContain('pizza');
    expect(state.unlocks.furniture).toEqual(['rug-clover']);
    expect(state.unlocks.environments).toEqual(['room', 'cafe']);
    expect(state.unlocks.placements.room).toEqual({ 'floor-a': 'rug-clover' });
    expect((state.unlocks.placements as Record<string, unknown>).mars).toBeUndefined();
  });

  it('clamps settings into range and defaults nonsense', () => {
    const state = normalize(
      { settings: { pixelScale: 99, bloom: -3, volume: { master: 5 }, motion: 'sideways', environment: 'cafe' } },
      TODAY,
    );
    expect(state.settings.pixelScale).toBe(6);
    expect(state.settings.bloom).toBe(0);
    expect(state.settings.volume.master).toBe(1);
    expect(state.settings.motion).toBe('auto');
    // cafe was never unlocked, so it falls back to the room instead of showing a locked world
    expect(state.settings.environment).toBe('room');
  });

  it('resets the daily slice when the stored day is stale', () => {
    const state = normalize({ daily: { day: '2020-01-01', pomodoros: 99, pettedCats: ['a'] } }, TODAY);
    expect(state.daily.day).toBe(TODAY);
    expect(state.daily.pomodoros).toBe(0);
    expect(state.daily.pettedCats).toEqual([]);
  });

  it('always leaves at least one cat', () => {
    expect(normalize({ cats: [] }, TODAY).cats.length).toBeGreaterThan(0);
    expect(normalize({ cats: [{ breed: 'nope' }] }, TODAY).cats.length).toBeGreaterThan(0);
  });

  it('rejects malformed perDay keys', () => {
    const state = normalize({ stats: { perDay: { '2026-08-29': { p: 2, m: 50 }, yesterday: { p: 9, m: 9 } } } }, TODAY);
    expect(Object.keys(state.stats.perDay)).toEqual(['2026-08-29']);
  });
});

describe('AC-8 export / import', () => {
  let state = createDefaultState(TODAY);
  beforeEach(() => {
    state = createDefaultState(TODAY);
    state.economy.coins = 99;
  });

  it('round-trips through the pasteable text form', () => {
    const text = exportSave(state);
    const result = importSave(text, TODAY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.economy.coins).toBe(99);
  });

  it('names both the problem and the fix for every failure mode', () => {
    const empty = importSave('   ', TODAY);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/paste/i);

    const noBrace = importSave('cats: 4', TODAY);
    expect(noBrace.ok).toBe(false);
    if (!noBrace.ok) expect(noBrace.error).toMatch(/\{/);

    const cut = importSave('{"cats": [', TODAY);
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.error).toMatch(/cut off|typo/i);

    const wrongShape = importSave('{"hello":"world"}', TODAY);
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) expect(wrongShape.error).toMatch(/not a save/i);
  });

  it('migrates an imported v1 save', () => {
    const result = importSave(JSON.stringify({ version: 1, coins: 7, cats: [{ breed: 'snow', name: 'Yuki', xp: 3 }] }), TODAY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migrated).toBe(true);
      expect(result.state.economy.coins).toBe(7);
      expect(result.state.cats[0].bondXp).toBe(3);
    }
  });

  it('describes a save for the confirm step', () => {
    expect(describeSave(state)).toMatch(/1 cat · 99 🐟/);
  });
});
