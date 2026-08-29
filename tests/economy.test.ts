import { describe, it, expect } from 'vitest';
import {
  addBondXp,
  addCoins,
  BOND_THRESHOLDS,
  bondLevel,
  bondProgress,
  breakReward,
  canAfford,
  createEconomy,
  focusReward,
  FREEZE_MAX,
  MAX_BOND_LEVEL,
  registerStudyDay,
  spend,
  streakMultiplier,
  streakStatus,
  type StreakState,
} from '../src/core/economy';

function freshStreak(patch: Partial<StreakState> = {}): StreakState {
  return { current: 0, best: 0, lastDay: null, freezes: 0, lastFreezeGrantDay: null, frozenDays: [], ...patch };
}

describe('AC-5 coin rewards', () => {
  it('pays 10 coins at streak 1 and scales 1.1x per day, capped at 2x', () => {
    expect(focusReward(0)).toBe(10);
    expect(focusReward(1)).toBe(10);
    expect(focusReward(2)).toBe(11);
    expect(focusReward(3)).toBe(12);
    expect(focusReward(6)).toBe(15);
    expect(focusReward(11)).toBe(20);
    expect(focusReward(50)).toBe(20); // capped
    expect(streakMultiplier(11)).toBe(2);
    expect(streakMultiplier(999)).toBe(2);
  });

  it('always pays a whole number of coins', () => {
    for (let s = 1; s <= 40; s++) {
      expect(Number.isInteger(focusReward(s))).toBe(true);
    }
  });

  it('pays 2 for a break that ran all the way', () => {
    expect(breakReward()).toBe(2);
  });

  it('tracks lifetime coins separately from the balance', () => {
    let e = createEconomy();
    e = addCoins(e, 100);
    const afterSpend = spend(e, 40);
    expect(afterSpend).not.toBeNull();
    expect(afterSpend!.coins).toBe(60);
    expect(afterSpend!.lifetimeCoins).toBe(100);
    expect(afterSpend!.spent).toBe(40);
  });

  it('refuses to overspend rather than going negative', () => {
    const e = addCoins(createEconomy(), 10);
    expect(canAfford(e, 11)).toBe(false);
    expect(spend(e, 11)).toBeNull();
    expect(spend(e, 10)!.coins).toBe(0);
  });

  it('ignores negative and fractional coin grants', () => {
    let e = createEconomy();
    e = addCoins(e, -50);
    expect(e.coins).toBe(0);
    e = addCoins(e, 7.9);
    expect(e.coins).toBe(7);
  });
});

describe('AC-6 streaks are kind', () => {
  it('counts a day once no matter how many pomodoros', () => {
    let r = registerStudyDay(freshStreak(), '2026-03-01');
    expect(r.streak.current).toBe(1);
    expect(r.counted).toBe(true);
    r = registerStudyDay(r.streak, '2026-03-01');
    expect(r.streak.current).toBe(1);
    expect(r.counted).toBe(false);
  });

  it('grows on consecutive days and records a best', () => {
    let s = freshStreak();
    for (let d = 1; d <= 5; d++) {
      s = registerStudyDay(s, `2026-03-0${d}`).streak;
    }
    expect(s.current).toBe(5);
    expect(s.best).toBe(5);
  });

  it('spends a freeze to bridge a missed day instead of resetting', () => {
    let s = freshStreak({ current: 4, best: 4, lastDay: '2026-03-01', freezes: 1, lastFreezeGrantDay: '2026-03-01' });
    const r = registerStudyDay(s, '2026-03-03'); // skipped the 2nd
    s = r.streak;
    expect(r.frozen).toBe(true);
    expect(s.current).toBe(5);
    expect(s.freezes).toBe(0);
    expect(s.frozenDays).toContain('2026-03-03');
  });

  it('resets to 1 — never 0 — when there is no freeze to spend', () => {
    const s = freshStreak({ current: 9, best: 9, lastDay: '2026-03-01', freezes: 0, lastFreezeGrantDay: '2026-03-01' });
    const r = registerStudyDay(s, '2026-03-05');
    expect(r.frozen).toBe(false);
    expect(r.streak.current).toBe(1);
    expect(r.streak.best).toBe(9); // best is never lost
  });

  it('grants at most one freeze per 7 days and stockpiles no more than the cap', () => {
    let s = registerStudyDay(freshStreak(), '2026-03-01').streak;
    expect(s.freezes).toBe(1); // first day grants one

    // Days 2..7 grant nothing.
    for (const d of ['02', '03', '04', '05', '06', '07']) {
      s = registerStudyDay(s, `2026-03-${d}`).streak;
    }
    expect(s.freezes).toBe(1);

    const day8 = registerStudyDay(s, '2026-03-08');
    expect(day8.granted).toBe(true);
    s = day8.streak;
    expect(s.freezes).toBe(2);

    // At the cap, another week grants nothing.
    for (let d = 9; d <= 20; d++) {
      s = registerStudyDay(s, `2026-03-${String(d).padStart(2, '0')}`).streak;
    }
    expect(s.freezes).toBeLessThanOrEqual(FREEZE_MAX);
  });

  it('tolerates a clock that moved backwards without punishing anyone', () => {
    const s = freshStreak({ current: 3, best: 3, lastDay: '2026-03-10' });
    const r = registerStudyDay(s, '2026-03-08');
    expect(r.streak.current).toBeGreaterThanOrEqual(1);
    expect(r.streak.best).toBe(3);
  });

  it('reports status without mutating anything', () => {
    const s = freshStreak({ current: 3, lastDay: '2026-03-10', freezes: 1 });
    expect(streakStatus(s, '2026-03-10')).toBe('active');
    expect(streakStatus(s, '2026-03-11')).toBe('at-risk');
    expect(streakStatus(s, '2026-03-12')).toBe('frozen');
    expect(streakStatus(s, '2026-03-20')).toBe('idle');
    expect(streakStatus(freshStreak(), '2026-03-10')).toBe('idle');
    expect(s.current).toBe(3); // untouched
  });
});

describe('AC-7 bond levels only rise', () => {
  it('maps XP onto 1..10 along the published curve', () => {
    expect(bondLevel(0)).toBe(1);
    expect(bondLevel(19)).toBe(1);
    expect(bondLevel(20)).toBe(2);
    expect(bondLevel(BOND_THRESHOLDS[9])).toBe(10);
    expect(bondLevel(999_999)).toBe(MAX_BOND_LEVEL);
    expect(bondLevel(-100)).toBe(1);
    expect(bondLevel(NaN)).toBe(1);
  });

  it('is monotonic across the whole range', () => {
    let prev = 0;
    for (let xp = 0; xp < 2000; xp += 7) {
      const level = bondLevel(xp);
      expect(level).toBeGreaterThanOrEqual(prev);
      prev = level;
    }
  });

  it('never loses XP or levels when adding', () => {
    const a = addBondXp(15, 10);
    expect(a.xp).toBe(25);
    expect(a.level).toBe(2);
    expect(a.leveledUp).toBe(true);
    const b = addBondXp(25, -100);
    expect(b.xp).toBe(25);
    expect(b.leveledUp).toBe(false);
  });

  it('reports progress within the level, and maxes out cleanly', () => {
    const p = bondProgress(30);
    expect(p.level).toBe(2);
    expect(p.into).toBe(10);
    expect(p.needed).toBe(35);
    expect(p.maxed).toBe(false);
    expect(bondProgress(99_999).maxed).toBe(true);
  });
});
