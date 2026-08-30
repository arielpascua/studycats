/**
 * The game store — the one place persisted state changes.
 *
 * Built on `zustand/vanilla` (no React in this project, so no hooks): the UI subscribes, the
 * scene subscribes, and everything else goes through the event bus. Every mutation that matters
 * calls `persist()`, so "refresh mid-session and nothing is lost" is a property of the store
 * rather than a checklist item.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  createDefaultState,
  createDaily,
  createCat,
  type GameState,
  type CatSave,
} from './core/state';
import { loadGame, saveGame, exportSave, importSave, clearSave, type LoadResult } from './core/save';
import {
  applySettings as applyTimerSettings,
  createTimer,
  durationFor,
  isBreak,
  pause as pauseTimer,
  reset as resetTimer,
  restore as restoreTimer,
  skip as skipTimer,
  snapshot as timerSnapshot,
  start as startTimer,
  setTask as setTimerTask,
  tick as tickTimer,
  toggle as toggleTimer,
  type TimerSettings,
  type TimerState,
  type TransitionEvent,
} from './core/timer';
import {
  addBondXp,
  addCoins,
  breakReward,
  BOND_XP,
  bondLevel,
  canAfford,
  focusReward,
  registerStudyDay,
  spend,
} from './core/economy';
import { dayKey, season } from './core/time';
import { claimCompleted, countersFrom, questViews, rolloverQuests, type QuestView } from './core/quests';
import { evaluate as evaluateAchievements } from './core/achievements';
import { BREEDS, isAdoptable, type BreedId } from './data/breeds';
import { VENUES, type VenueId } from './data/venues';
import { ENVIRONMENTS, type EnvironmentId } from './data/environments';
import { FURNITURE, allowedIn, fitsSlot, type SlotId } from './data/furniture';
import { SNACKS } from './data/snacks';
import { VISITORS, VISITOR_CHANCE, pickVisitor } from './data/visitors';
import { RADIO_STATIONS } from './audio/engine';
import {
  addMember,
  bonfireProgress,
  bonfireReward,
  decodeCatCard,
  encodeCatCard,
  removeMember as removePartyMemberPure,
  renameMember as renamePartyMemberPure,
  type GuestCat,
  type PartyState,
} from './core/party';
import { COSMETICS, type CosmeticSlot } from './data/cosmetics';
import { bus } from './core/events';
import { trickForBond, TRICK_NAMES } from './scene/cats/catAnimator';

export interface RuntimeState {
  timer: TimerState;
  /** Cats petted since the app opened, for the "diminishing pets" rule. */
  petsThisSession: Record<string, number>;
  konamiUnlocked: boolean;
  photoMode: boolean;
  panel: string | null;
}

export interface Game {
  store: StoreApi<GameState>;
  runtime: RuntimeState;
  loadStatus: LoadResult['status'];

  getState(): GameState;
  subscribe(fn: (state: GameState, prev: GameState) => void): () => void;
  persist(): void;

  /* timer */
  timer(): TimerState;
  toggleTimer(now?: number): void;
  startTimer(now?: number): void;
  pauseTimer(now?: number): void;
  resetTimer(): void;
  skip(now?: number): void;
  tick(now?: number): TransitionEvent | null;
  setTask(task: string): void;
  updateTimerSettings(patch: Partial<TimerSettings>): void;

  /* cats */
  petCat(catId: string): { level: number; leveledUp: boolean } | null;
  adoptCat(breed: BreedId, name?: string): { ok: true; cat: CatSave } | { ok: false; reason: string };
  renameCat(catId: string, name: string): void;
  sendHome(catId: string): boolean;
  recordSnackEaten(catId: string, snackDefId: string): void;
  recordTrick(catId: string, trick: string): void;

  /* shop */
  buySnack(id: string): boolean;
  buyFurniture(id: string): boolean;
  placeFurniture(id: string | null, slot: SlotId): boolean;
  buyEnvironment(id: EnvironmentId): boolean;
  buyRadio(id: string): boolean;
  setEnvironment(id: EnvironmentId): boolean;

  /* multiplayer */
  setMode(mode: 'solo' | 'party'): void;
  /** Where the party meets. Buying is a separate step, so a locked venue never silently costs. */
  setVenue(id: VenueId): boolean;
  buyVenue(id: VenueId): boolean;
  addPlayer(playerName: string, source: { catId?: string; guest?: GuestCat }): { ok: boolean; error?: string };
  removePlayer(id: string): void;
  renamePlayer(id: string, playerName: string): void;
  /** Import a friend's cat card and seat them. */
  bringGuest(playerName: string, code: string): { ok: boolean; error?: string };
  /** Share one of your cats as a card. */
  catCardFor(catId: string): string | null;
  sendCheer(memberId: string): void;
  party(): PartyState;

  /* wardrobe */
  buyCosmetic(id: string): boolean;
  equipCosmetic(catId: string, slot: CosmeticSlot, cosmeticId: string | null): void;

  /* misc */
  setSetting<K extends keyof GameState['settings']>(key: K, value: GameState['settings'][K]): void;
  quests(): QuestView[];
  claimQuests(): number;
  logVisitor(id: string): number;
  dismissVisitor(): void;
  recordPhoto(): void;
  unlockKonami(): void;
  checkAchievements(now?: Date): void;
  exportSave(): string;
  importSave(text: string): { ok: boolean; error?: string };
  resetEverything(): void;
}

const MAX_CATS = 12;

/**
 * Which world is actually on screen.
 *
 * `settings.environment` is where you study ALONE; it keeps its value while you are in the
 * clearing so that leaving the party puts you back where you were. The mode is what decides
 * which of the two is live, and every place that swaps scenes has to ask this rather than
 * reading `settings.environment` directly — that mismatch is why importing a party save first
 * dropped you into the room with an invisible roster.
 */
export function activeEnvironment(state: GameState): EnvironmentId {
  return state.settings.mode === 'party' ? 'arena' : state.settings.environment;
}

export function createGame(): Game {
  const today = dayKey();
  const loaded = loadGame(undefined, today);
  const store = createStore<GameState>(() => loaded.state);

  const runtime: RuntimeState = {
    timer: restoreTimer(loaded.state.timer, loaded.state.settings.timer, Date.now()),
    petsThisSession: {},
    konamiUnlocked: false,
    photoMode: false,
    panel: null,
  };

  // Quests roll over on load, so a returning player never sees yesterday's board.
  store.setState((s) => ({
    quests: rolloverQuests(s.quests, today, s.unlocks.environments),
    daily: s.daily.day === today ? s.daily : createDaily(today),
  }));

  let saveScheduled = false;

  function persist(): void {
    if (saveScheduled) return;
    saveScheduled = true;
    // Coalesce a burst of mutations into one write.
    queueMicrotask(() => {
      saveScheduled = false;
      const state = { ...store.getState(), timer: timerSnapshot(runtime.timer) };
      store.setState({ timer: state.timer });
      saveGame(state);
      bus.emit('save:written');
    });
  }

  function toast(title: string, body?: string, icon?: string, tone: 'default' | 'reward' | 'gentle' = 'default'): void {
    bus.emit('toast', { title, body, icon, tone });
  }

  function grantCoins(amount: number, reason: string): void {
    if (amount <= 0) return;
    store.setState((s) => ({ economy: addCoins(s.economy, amount) }));
    bus.emit('economy:coins', { total: store.getState().economy.coins, delta: amount, reason });
  }

  function ensureToday(): string {
    const key = dayKey();
    const s = store.getState();
    if (s.daily.day !== key) {
      store.setState({ daily: createDaily(key), quests: rolloverQuests({ day: key, quests: [] }, key, s.unlocks.environments) });
    } else if (s.quests.day !== key || s.quests.quests.length === 0) {
      store.setState({ quests: rolloverQuests(s.quests, key, s.unlocks.environments) });
    }
    return key;
  }

  /** Everything that happens when a focus session finishes for real. */
  function completeFocus(event: TransitionEvent): void {
    const key = ensureToday();
    const before = store.getState();
    const minutes = Math.max(0, event.elapsedMin);
    const env = before.settings.environment;

    const streakResult = registerStudyDay(before.economy.streak, key);
    const reward = focusReward(streakResult.streak.current);

    store.setState((s) => {
      const perDay = { ...s.stats.perDay };
      const entry = perDay[key] ?? { p: 0, m: 0 };
      perDay[key] = { p: entry.p + 1, m: entry.m + minutes };

      const sceneMinutes = { ...s.stats.sceneMinutes };
      sceneMinutes[env] = (sceneMinutes[env] ?? 0) + minutes;

      const dailyScene = { ...s.daily.sceneMinutes };
      dailyScene[env] = (dailyScene[env] ?? 0) + minutes;

      return {
        economy: { ...addCoins(s.economy, reward), streak: streakResult.streak },
        stats: {
          ...s.stats,
          totalPomodoros: s.stats.totalPomodoros + 1,
          totalFocusMin: s.stats.totalFocusMin + minutes,
          perDay,
          sceneMinutes,
        },
        daily: {
          ...s.daily,
          pomodoros: s.daily.pomodoros + 1,
          focusMinutes: s.daily.focusMinutes + minutes,
          sceneMinutes: dailyScene,
        },
        cats: s.cats.map((c) => ({ ...c, bondXp: addBondXp(c.bondXp, BOND_XP.focusCompleted).xp })),
      };
    });

    bus.emit('economy:coins', { total: store.getState().economy.coins, delta: reward, reason: 'focus' });
    bus.emit('economy:streak', { current: streakResult.streak.current, frozen: streakResult.frozen });

    // In party mode the session also feeds the shared bonfire. This is the mechanic that makes
    // studying together different from studying near each other: one object, everyone's minutes.
    if (before.settings.mode === 'party' && before.party.members.length > 0) {
      const wasMaxed = bonfireProgress(before.party.sharedMinutes, before.party.members.length).maxed;
      store.setState((s) => ({
        party: { ...s.party, sharedMinutes: s.party.sharedMinutes + minutes },
      }));
      const after = store.getState().party;
      const progress = bonfireProgress(after.sharedMinutes, after.members.length);
      if (progress.maxed && !wasMaxed) {
        const prize = bonfireReward(after.members.length);
        grantCoins(prize, 'bonfire');
        toast('THE FIRE IS ROARING', `everyone earned ${prize} 🐟 together`, '🔥', 'reward');
      } else {
        bus.emit('toast', {
          title: 'INTO THE FIRE',
          body: `+${minutes}m — stage ${progress.stage} of 5`,
          icon: '🔥',
          tone: 'gentle',
        });
      }
    }

    if (streakResult.frozen) {
      toast('STREAK FROZEN', 'a snowflake covered the day you missed', '❄', 'gentle');
    }
    if (streakResult.granted) {
      toast('FREEZE EARNED', 'one missed day is on the house', '❄', 'reward');
    }

    rollVisitor();
    checkAchievements();
    persist();
  }

  function completeBreak(event: TransitionEvent): void {
    ensureToday();
    const minutes = Math.max(0, event.elapsedMin);
    grantCoins(breakReward(), 'break');
    store.setState((s) => ({
      stats: { ...s.stats, totalBreakMin: s.stats.totalBreakMin + minutes },
      daily: {
        ...s.daily,
        breakMinutes: s.daily.breakMinutes + minutes,
        breaksCompleted: s.daily.breaksCompleted + 1,
      },
      cats: s.cats.map((c) => ({ ...c, bondXp: addBondXp(c.bondXp, BOND_XP.breakTogether).xp })),
    }));
    checkAchievements();
    persist();
  }

  function rollVisitor(): void {
    const s = store.getState();
    if (s.pendingVisitor) return;
    if (Math.random() >= VISITOR_CHANCE) return;
    const visitor = pickVisitor(s.settings.environment, season(), Math.random());
    if (!visitor) return;
    store.setState({ pendingVisitor: visitor.id });
    bus.emit('visitor:appeared', { id: visitor.id });
    toast('SOMEONE IS HERE', 'something is watching from the edge', visitor.icon, 'gentle');
  }

  function checkAchievements(now: Date = new Date()): void {
    const state = store.getState();
    const newly = evaluateAchievements({
      state,
      hour: now.getHours(),
      today: dayKey(now),
      konami: runtime.konamiUnlocked,
    });
    if (newly.length === 0) return;
    store.setState((s) => ({
      unlocks: { ...s.unlocks, achievements: [...s.unlocks.achievements, ...newly.map((a) => a.id)] },
    }));
    for (const a of newly) {
      bus.emit('achievement:unlocked', { id: a.id, title: a.title, description: a.description });
    }
    persist();
  }

  const game: Game = {
    store,
    runtime,
    loadStatus: loaded.status,

    getState: () => store.getState(),
    subscribe: (fn) => store.subscribe(fn),
    persist,

    timer: () => runtime.timer,

    startTimer(now = Date.now()) {
      runtime.timer = startTimer(runtime.timer, now);
      bus.emit('timer:start', { mode: runtime.timer.mode });
      persist();
    },

    pauseTimer(now = Date.now()) {
      runtime.timer = pauseTimer(runtime.timer, now);
      bus.emit('timer:pause', { mode: runtime.timer.mode });
      persist();
    },

    toggleTimer(now = Date.now()) {
      const wasRunning = runtime.timer.running;
      runtime.timer = toggleTimer(runtime.timer, now);
      bus.emit(wasRunning ? 'timer:pause' : 'timer:start', { mode: runtime.timer.mode });
      persist();
    },

    resetTimer() {
      runtime.timer = resetTimer(runtime.timer);
      bus.emit('timer:reset');
      persist();
    },

    skip(now = Date.now()) {
      const from = runtime.timer.mode;
      const { state, transition } = skipTimer(runtime.timer, now);
      runtime.timer = state;
      if (from === 'focus') {
        store.setState((s) => ({ stats: { ...s.stats, sessionsSkipped: s.stats.sessionsSkipped + 1 } }));
      }
      bus.emit('timer:transition', { from: transition.from, to: transition.to, natural: false, round: transition.round });
      persist();
    },

    tick(now = Date.now()) {
      const result = tickTimer(runtime.timer, now);
      runtime.timer = result.state;
      const t = result.transition;
      if (!t) return null;

      if (t.from === 'focus') completeFocus(t);
      else if (isBreak(t.from)) completeBreak(t);

      bus.emit('timer:transition', { from: t.from, to: t.to, natural: true, round: t.round });
      return t;
    },

    setTask(task) {
      runtime.timer = setTimerTask(runtime.timer, task);
      persist();
    },

    updateTimerSettings(patch) {
      runtime.timer = applyTimerSettings(runtime.timer, patch, Date.now());
      store.setState((s) => ({ settings: { ...s.settings, timer: runtime.timer.settings } }));
      bus.emit('settings:changed');
      persist();
    },

    /* ---------------------------------------------------------------- cats */

    petCat(catId) {
      const s = store.getState();
      const cat = s.cats.find((c) => c.id === catId);
      if (!cat) return null;

      const petsSoFar = runtime.petsThisSession[catId] ?? 0;
      runtime.petsThisSession[catId] = petsSoFar + 1;
      // Diminishing returns — affection, not a clicker.
      const xp = petsSoFar < 3 ? BOND_XP.pet : BOND_XP.petRepeat;
      const result = addBondXp(cat.bondXp, xp);

      ensureToday();

      store.setState((state) => ({
        cats: state.cats.map((c) => (c.id === catId ? { ...c, bondXp: result.xp, petCount: c.petCount + 1 } : c)),
        stats: { ...state.stats, petCounts: { ...state.stats.petCounts, [catId]: (state.stats.petCounts[catId] ?? 0) + 1 } },
        daily: {
          ...state.daily,
          pettedCats: state.daily.pettedCats.includes(catId) ? state.daily.pettedCats : [...state.daily.pettedCats, catId],
        },
      }));

      bus.emit('cat:pet', { catId });
      bus.emit('cat:bond', { catId, level: result.level, leveledUp: result.leveledUp });

      if (result.leveledUp) {
        const trick = trickForBond(result.level);
        if (trick) {
          const name = TRICK_NAMES[trick] ?? trick;
          store.setState((state) => ({
            cats: state.cats.map((c) =>
              c.id === catId && !c.tricks.includes(trick) ? { ...c, tricks: [...c.tricks, trick] } : c,
            ),
          }));
          toast(`${cat.name.toUpperCase()} LEARNED A TRICK`, `double-click for a ${name}`, '✨', 'reward');
        } else {
          toast(`BOND ${result.level}`, `${cat.name} settles a little closer`, '💞', 'reward');
        }
      }

      checkAchievements();
      persist();
      return { level: result.level, leveledUp: result.leveledUp };
    },

    adoptCat(breed, name) {
      const s = store.getState();
      const def = BREEDS[breed];
      if (!def) return { ok: false, reason: 'unknown breed' };
      if (s.cats.length >= MAX_CATS) return { ok: false, reason: 'the room is full — send one home first' };
      if (!isAdoptable(def) && !s.unlocks.breeds.includes(breed)) {
        return { ok: false, reason: def.unlockHint ?? 'not available yet' };
      }
      const price = s.unlocks.breeds.includes(breed) && def.price > 0 ? def.price : def.price;
      if (!canAfford(s.economy, price)) return { ok: false, reason: `you need ${price - s.economy.coins} more 🐟` };

      const economy = spend(s.economy, price);
      if (!economy) return { ok: false, reason: 'not enough fish coins' };

      const cat = createCat(breed, name || def.name, undefined, dayKey());
      store.setState((state) => ({
        economy,
        cats: [...state.cats, cat],
        unlocks: {
          ...state.unlocks,
          breeds: state.unlocks.breeds.includes(breed) ? state.unlocks.breeds : [...state.unlocks.breeds, breed],
        },
      }));
      bus.emit('cat:adopted', { catId: cat.id, breedId: breed });
      toast('WELCOME HOME', `${cat.name} is having a look around`, '🐈', 'reward');
      checkAchievements();
      persist();
      return { ok: true, cat };
    },

    renameCat(catId, name) {
      const clean = name.trim().slice(0, 16) || 'Cat';
      store.setState((s) => ({ cats: s.cats.map((c) => (c.id === catId ? { ...c, name: clean } : c)) }));
      persist();
    },

    sendHome(catId) {
      const s = store.getState();
      if (s.cats.length <= 1) return false;
      store.setState((state) => ({ cats: state.cats.filter((c) => c.id !== catId) }));
      persist();
      return true;
    },

    recordSnackEaten(catId, snackDefId) {
      store.setState((s) => ({
        cats: s.cats.map((c) => (c.id === catId ? { ...c, snacksEaten: c.snacksEaten + 1, bondXp: addBondXp(c.bondXp, BOND_XP.snackEaten).xp } : c)),
        daily: { ...s.daily, snacksEaten: s.daily.snacksEaten + 1 },
        unlocks: {
          ...s.unlocks,
          snacksTasted: s.unlocks.snacksTasted.includes(snackDefId)
            ? s.unlocks.snacksTasted
            : [...s.unlocks.snacksTasted, snackDefId],
        },
      }));
      bus.emit('snack:eaten', { snackId: snackDefId, catId });
      checkAchievements();
      persist();
    },

    recordTrick(catId, trick) {
      store.setState((s) => ({
        unlocks: {
          ...s.unlocks,
          tricksSeen: s.unlocks.tricksSeen.includes(trick) ? s.unlocks.tricksSeen : [...s.unlocks.tricksSeen, trick],
        },
      }));
      bus.emit('cat:trick', { catId, trick });
      checkAchievements();
      persist();
    },

    /* ---------------------------------------------------------------- shop */

    buySnack(id) {
      const s = store.getState();
      const def = SNACKS[id];
      if (!def || s.unlocks.snacks.includes(id)) return false;
      const economy = spend(s.economy, def.price);
      if (!economy) return false;
      store.setState((state) => ({ economy, unlocks: { ...state.unlocks, snacks: [...state.unlocks.snacks, id] } }));
      toast('ADDED TO THE MENU', def.name, def.icon, 'reward');
      persist();
      return true;
    },

    buyFurniture(id) {
      const s = store.getState();
      const def = FURNITURE[id];
      if (!def || s.unlocks.furniture.includes(id)) return false;
      const economy = spend(s.economy, def.price);
      if (!economy) return false;
      store.setState((state) => ({ economy, unlocks: { ...state.unlocks, furniture: [...state.unlocks.furniture, id] } }));
      toast('DELIVERED', `${def.name} — drop it on a spot`, '📦', 'reward');
      persist();
      return true;
    },

    placeFurniture(id, slot) {
      const s = store.getState();
      const env = s.settings.environment;
      if (id !== null) {
        if (!s.unlocks.furniture.includes(id)) return false;
        if (!fitsSlot(id, slot) || !allowedIn(id, env)) return false;
      }
      store.setState((state) => {
        const placements = { ...state.unlocks.placements };
        const bySlot = { ...(placements[env] ?? {}) };
        // One item per slot, and an item can only be in one slot at a time.
        if (id !== null) {
          for (const key of Object.keys(bySlot) as SlotId[]) {
            if (bySlot[key] === id) delete bySlot[key];
          }
          bySlot[slot] = id;
        } else {
          delete bySlot[slot];
        }
        placements[env] = bySlot;
        return { unlocks: { ...state.unlocks, placements } };
      });
      bus.emit('env:changed', { environment: env });
      persist();
      return true;
    },

    buyEnvironment(id) {
      const s = store.getState();
      const def = ENVIRONMENTS[id];
      if (!def || s.unlocks.environments.includes(id)) return false;
      const economy = spend(s.economy, def.price);
      if (!economy) return false;
      store.setState((state) => ({
        economy,
        unlocks: { ...state.unlocks, environments: [...state.unlocks.environments, id] },
      }));
      toast('A NEW PLACE TO STUDY', def.label, def.icon, 'reward');
      persist();
      return true;
    },

    buyRadio(id) {
      const s = store.getState();
      const station = RADIO_STATIONS.find((r) => r.id === id);
      if (!station || s.unlocks.radio.includes(id)) return false;
      const economy = spend(s.economy, station.price);
      if (!economy) return false;
      store.setState((state) => ({ economy, unlocks: { ...state.unlocks, radio: [...state.unlocks.radio, id] } }));
      toast('NEW STATION', station.name, '📻', 'reward');
      persist();
      return true;
    },

    setEnvironment(id) {
      const s = store.getState();
      if (!s.unlocks.environments.includes(id)) return false;
      if (s.settings.environment === id) return true;
      store.setState((state) => ({ settings: { ...state.settings, environment: id } }));
      bus.emit('env:changed', { environment: id });
      persist();
      return true;
    },

    /* ---------------------------------------------------------------- misc */

    /* ------------------------------------------------------- multiplayer */

    buyVenue(id) {
      const s = store.getState();
      const def = VENUES[id];
      if (!def || s.unlocks.venues.includes(id)) return false;
      const economy = spend(s.economy, def.price);
      if (!economy) return false;
      store.setState((state) => ({
        economy,
        unlocks: { ...state.unlocks, venues: [...state.unlocks.venues, id] },
      }));
      toast('THE PARTY MOVES', def.label, def.icon, 'reward');
      persist();
      return true;
    },

    setVenue(id) {
      const s = store.getState();
      if (!s.unlocks.venues.includes(id)) return false;
      if (s.settings.venue === id) return true;
      store.setState((state) => ({ settings: { ...state.settings, venue: id } }));
      // Party mode is standing in the arena right now, so the venue swap is a scene rebuild.
      // In solo mode this only takes effect the next time you open the party.
      bus.emit('env:changed', { environment: s.settings.mode === 'party' ? 'arena' : s.settings.environment });
      persist();
      return true;
    },

    setMode(nextMode) {
      const s = store.getState();
      if (s.settings.mode === nextMode) return;
      store.setState((state) => ({ settings: { ...state.settings, mode: nextMode } }));
      // The arena is not one of the solo worlds, so the scene swap is driven by mode rather
      // than by `settings.environment`, which keeps its place for when you come back.
      bus.emit('env:changed', { environment: nextMode === 'party' ? 'arena' : s.settings.environment });
      persist();
    },

    addPlayer(playerName, source) {
      const s = store.getState();
      const result = addMember(s.party, {
        playerName,
        catId: source.catId ?? null,
        guest: source.guest ?? null,
      });
      if (!result.ok) return { ok: false, error: result.reason };
      store.setState({ party: result.party });
      const seated = result.party.members[result.party.members.length - 1];
      toast('PULLED UP A CUSHION', `${seated.playerName} joined the circle`, '🔥', 'reward');
      persist();
      return { ok: true };
    },

    removePlayer(id) {
      const s = store.getState();
      const leaving = s.party.members.find((m) => m.id === id);
      store.setState({ party: removePartyMemberPure(s.party, id) });
      if (leaving) toast('HEADED HOME', `${leaving.playerName} left the circle`, '👋', 'gentle');
      persist();
    },

    renamePlayer(id, playerName) {
      store.setState((s) => ({ party: renamePartyMemberPure(s.party, id, playerName) }));
      persist();
    },

    bringGuest(playerName, code) {
      const card = decodeCatCard(code);
      if (!card.ok) return { ok: false, error: card.error };
      return game.addPlayer(playerName, { guest: card.cat });
    },

    catCardFor(catId) {
      const cat = store.getState().cats.find((c) => c.id === catId);
      if (!cat) return null;
      return encodeCatCard({
        name: cat.name,
        breed: cat.breed,
        outfit: cat.outfit,
        bond: bondLevel(cat.bondXp),
      });
    },

    sendCheer(memberId) {
      const s = store.getState();
      if (!s.party.members.some((m) => m.id === memberId)) return;
      store.setState((state) => ({ party: { ...state.party, cheers: state.party.cheers + 1 } }));
      persist();
    },

    party: () => store.getState().party,

    /* ---------------------------------------------------------- wardrobe */

    buyCosmetic(id) {
      const s = store.getState();
      const def = COSMETICS[id];
      if (!def || s.unlocks.cosmetics.includes(id)) return false;
      const economy = spend(s.economy, def.price);
      if (!economy) return false;
      store.setState((state) => ({
        economy,
        unlocks: { ...state.unlocks, cosmetics: [...state.unlocks.cosmetics, id] },
      }));
      toast('NEW IN THE WARDROBE', def.name, '🎀', 'reward');
      persist();
      return true;
    },

    equipCosmetic(catId, slot, cosmeticId) {
      const s = store.getState();
      // Only something you own, and only in the slot it belongs to.
      if (cosmeticId !== null) {
        const def = COSMETICS[cosmeticId];
        if (!def || def.slot !== slot || !s.unlocks.cosmetics.includes(cosmeticId)) return;
      }
      store.setState((state) => ({
        cats: state.cats.map((c) => {
          if (c.id !== catId) return c;
          const outfit = { ...c.outfit };
          if (cosmeticId === null) delete outfit[slot];
          else outfit[slot] = cosmeticId;
          return { ...c, outfit };
        }),
      }));
      persist();
    },

    setSetting(key, value) {
      store.setState((s) => ({ settings: { ...s.settings, [key]: value } }));
      bus.emit('settings:changed');
      persist();
    },

    quests() {
      const s = store.getState();
      return questViews(s.quests, countersFrom(s.daily, s.cats.length));
    },

    claimQuests() {
      const s = store.getState();
      const counters = countersFrom(s.daily, s.cats.length);
      const { save, reward, claimedIds } = claimCompleted(s.quests, counters);
      if (claimedIds.length === 0) return 0;
      store.setState({ quests: save });
      grantCoins(reward, 'quest');
      for (const id of claimedIds) bus.emit('quest:complete', { questId: id, reward });
      toast('QUEST DONE', `+${reward} 🐟`, '✅', 'reward');
      persist();
      return reward;
    },

    logVisitor(id) {
      const s = store.getState();
      const def = VISITORS[id];
      if (!def) return 0;
      const first = !s.unlocks.visitors.includes(id);
      const bounty = first ? def.bounty : Math.max(5, Math.floor(def.bounty / 3));
      store.setState((state) => ({
        pendingVisitor: null,
        unlocks: { ...state.unlocks, visitors: first ? [...state.unlocks.visitors, id] : state.unlocks.visitors },
        daily: { ...state.daily, visitorsSeen: state.daily.visitorsSeen + 1 },
      }));
      grantCoins(bounty, 'visitor');
      bus.emit('visitor:logged', { id });
      toast(first ? 'NEW IN THE CAT-ALOGUE' : 'LOGGED AGAIN', `${def.name} · +${bounty} 🐟`, def.icon, 'reward');
      checkAchievements();
      persist();
      return bounty;
    },

    dismissVisitor() {
      if (!store.getState().pendingVisitor) return;
      store.setState({ pendingVisitor: null });
      persist();
    },

    recordPhoto() {
      store.setState((s) => ({ stats: { ...s.stats, photosTaken: s.stats.photosTaken + 1 } }));
      checkAchievements();
      persist();
    },

    unlockKonami() {
      if (runtime.konamiUnlocked) return;
      runtime.konamiUnlocked = true;
      const s = store.getState();
      if (!s.unlocks.breeds.includes('robo')) {
        store.setState((state) => ({ unlocks: { ...state.unlocks, breeds: [...state.unlocks.breeds, 'robo'] } }));
        toast('???', 'something small and metal is at the door', '🤖', 'reward');
      }
      checkAchievements();
      persist();
    },

    checkAchievements,

    exportSave() {
      return exportSave({ ...store.getState(), timer: timerSnapshot(runtime.timer) });
    },

    importSave(text) {
      const result = importSave(text, dayKey());
      if (!result.ok) return { ok: false, error: result.error };
      store.setState(() => result.state);
      runtime.timer = restoreTimer(result.state.timer, result.state.settings.timer, Date.now());
      runtime.petsThisSession = {};
      saveGame(store.getState());
      bus.emit('env:changed', { environment: activeEnvironment(result.state) });
      bus.emit('settings:changed');
      toast('SAVE LOADED', 'your cats are back', '💾', 'reward');
      return { ok: true };
    },

    resetEverything() {
      clearSave();
      const fresh = createDefaultState(dayKey());
      store.setState(() => fresh);
      runtime.timer = createTimer(fresh.settings.timer);
      runtime.petsThisSession = {};
      runtime.konamiUnlocked = false;
      saveGame(fresh);
      bus.emit('env:changed', { environment: activeEnvironment(fresh) });
      bus.emit('settings:changed');
    },
  };

  return game;
}

/** Resolve the effective reduced-motion preference: explicit setting wins over the OS. */
export function resolveReducedMotion(motion: GameState['settings']['motion']): boolean {
  if (motion === 'reduced') return true;
  if (motion === 'full') return false;
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/** Bond level → the tint used for a cat's name tag. */
export function bondTint(xp: number): string {
  const level = bondLevel(xp);
  if (level >= 10) return '#F2B441';
  if (level >= 7) return '#F0B7C9';
  if (level >= 4) return '#A9D6C0';
  return '#C7BFEA';
}

export { durationFor };
