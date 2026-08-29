import { describe, it, expect } from 'vitest';
import {
  applySettings,
  clampDuration,
  createTimer,
  DEFAULT_TIMER_SETTINGS,
  durationFor,
  isBreak,
  modeLabel,
  nextMode,
  pause,
  progressAt,
  remainingAt,
  reset,
  resetCycle,
  restore,
  sanitizeSettings,
  setTask,
  skip,
  snapshot,
  start,
  tick,
  toggle,
  type TimerState,
} from '../src/core/timer';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function runTo(state: TimerState, now: number) {
  return tick(state, now);
}

describe('AC-1 drift-free clock', () => {
  it('derives remaining from an absolute end time, so a hidden tab loses nothing', () => {
    let s = createTimer({ focusMin: 25 });
    s = start(s, T0);
    // Tab goes to sleep for 90s of wall clock with zero ticks delivered.
    expect(remainingAt(s, T0 + 90_000)).toBe(25 * MIN - 90_000);
    // ...and again after a long suspend.
    expect(remainingAt(s, T0 + 10 * MIN)).toBe(15 * MIN);
  });

  it('accumulates no error across 10 000 irregular ticks', () => {
    let s = start(createTimer({ focusMin: 30 }), T0);
    let now = T0;
    for (let i = 0; i < 10_000; i++) {
      now += 1 + (i % 7); // jittery frame times
      const r = runTo(s, now);
      s = r.state;
      if (r.transition) break;
    }
    expect(remainingAt(s, now)).toBe(30 * MIN - (now - T0));
  });

  it('pausing banks the exact remaining and resuming re-bases the end time', () => {
    let s = start(createTimer({ focusMin: 10 }), T0);
    s = pause(s, T0 + 4 * MIN);
    expect(s.remainingMs).toBe(6 * MIN);
    expect(s.endsAt).toBeNull();
    // 3 real hours pass while paused: nothing is consumed.
    s = start(s, T0 + 3 * 3600_000);
    expect(remainingAt(s, T0 + 3 * 3600_000)).toBe(6 * MIN);
  });

  it('never reports a negative remaining', () => {
    const s = start(createTimer({ focusMin: 1 }), T0);
    expect(remainingAt(s, T0 + 999 * MIN)).toBe(0);
    expect(progressAt(s, T0 + 999 * MIN)).toBe(1);
  });
});

describe('AC-2 the cycle', () => {
  it('runs focus -> shortBreak -> focus x4 -> longBreak and clears the dots', () => {
    const settings = { ...DEFAULT_TIMER_SETTINGS, roundsPerLongBreak: 4, autoStart: true };
    let s = start(createTimer(settings), T0);
    let now = T0;
    const seen: string[] = [];

    for (let i = 0; i < 8; i++) {
      now += durationFor(s.mode, s.settings);
      const r = tick(s, now);
      expect(r.transition).toBeDefined();
      s = r.state;
      seen.push(r.transition!.to);
    }

    expect(seen).toEqual([
      'shortBreak', 'focus',
      'shortBreak', 'focus',
      'shortBreak', 'focus',
      'longBreak', 'focus',
    ]);
    expect(s.round).toBe(0); // the long break closed the cycle
  });

  it('nextMode is pure and matches the round arithmetic', () => {
    const st = sanitizeSettings({ roundsPerLongBreak: 3 });
    expect(nextMode('idle', 0, st)).toEqual({ mode: 'focus', round: 0 });
    expect(nextMode('focus', 0, st)).toEqual({ mode: 'shortBreak', round: 1 });
    expect(nextMode('focus', 1, st)).toEqual({ mode: 'shortBreak', round: 2 });
    expect(nextMode('focus', 2, st)).toEqual({ mode: 'longBreak', round: 3 });
    expect(nextMode('longBreak', 3, st)).toEqual({ mode: 'focus', round: 0 });
    expect(nextMode('shortBreak', 2, st)).toEqual({ mode: 'focus', round: 2 });
  });

  it('does not burn multiple sessions when the tab was closed for hours', () => {
    let s = start(createTimer({ focusMin: 25, autoStart: true }), T0);
    const r = tick(s, T0 + 5 * 3600_000);
    s = r.state;
    expect(r.transition?.to).toBe('shortBreak');
    // The surplus does NOT immediately complete the break as well.
    const r2 = tick(s, T0 + 5 * 3600_000);
    expect(r2.transition).toBeUndefined();
  });
});

describe('AC-3 duration clamping', () => {
  it('clamps each field to its documented range', () => {
    expect(clampDuration('focusMin', 0)).toBe(1);
    expect(clampDuration('focusMin', 999)).toBe(120);
    expect(clampDuration('shortBreakMin', -5)).toBe(1);
    expect(clampDuration('shortBreakMin', 61)).toBe(60);
    expect(clampDuration('longBreakMin', 60.4)).toBe(60);
    expect(clampDuration('roundsPerLongBreak', 1)).toBe(2);
    expect(clampDuration('roundsPerLongBreak', 99)).toBe(8);
  });

  it('never yields NaN from garbage input', () => {
    for (const bad of [NaN, Infinity, -Infinity, 'abc', null, undefined, {}, []]) {
      const s = sanitizeSettings({ focusMin: bad as never, shortBreakMin: bad as never });
      expect(Number.isFinite(s.focusMin)).toBe(true);
      expect(Number.isFinite(s.shortBreakMin)).toBe(true);
      expect(s.focusMin).toBeGreaterThanOrEqual(1);
    }
    const t = createTimer({ focusMin: 'nonsense' as never });
    expect(remainingAt(t, T0)).toBe(25 * MIN);
  });

  it('editing durations while paused preserves elapsed time instead of erasing it', () => {
    let s = start(createTimer({ focusMin: 25 }), T0);
    s = pause(s, T0 + 5 * MIN); // 5 minutes done, 20 left
    s = applySettings(s, { focusMin: 30 }, T0 + 5 * MIN);
    expect(s.remainingMs).toBe(25 * MIN); // 30 total - 5 elapsed
  });

  it('editing durations while running does not yank time away mid-session', () => {
    const s = start(createTimer({ focusMin: 25 }), T0);
    const next = applySettings(s, { focusMin: 5 }, T0 + MIN);
    expect(next.endsAt).toBe(s.endsAt);
    expect(remainingAt(next, T0 + MIN)).toBe(24 * MIN);
  });
});

describe('AC-4 skip and reset are total', () => {
  const modes = ['idle', 'focus', 'shortBreak', 'longBreak'] as const;

  it('skip lands on a legal next mode from every mode, flagged non-natural', () => {
    for (const mode of modes) {
      let s = createTimer({ autoStart: false });
      s = { ...s, mode, remainingMs: durationFor(mode, s.settings) };
      const { state, transition } = skip(s, T0);
      expect(transition.natural).toBe(false);
      expect(modes).toContain(state.mode);
      expect(state.mode).not.toBe('idle');
      expect(state.remainingMs).toBe(durationFor(state.mode, state.settings));
    }
  });

  it('reset returns to idle with a full focus session, keeping the dots', () => {
    let s = start(createTimer({ focusMin: 25 }), T0);
    s = { ...s, round: 2 };
    const r = reset(s);
    expect(r.mode).toBe('idle');
    expect(r.running).toBe(false);
    expect(r.endsAt).toBeNull();
    expect(r.remainingMs).toBe(25 * MIN);
    expect(r.round).toBe(2);
    expect(resetCycle(s).round).toBe(0);
  });

  it('toggle is start/pause and start is idempotent', () => {
    let s = createTimer();
    s = toggle(s, T0);
    expect(s.running).toBe(true);
    const again = start(s, T0 + 1000);
    expect(again).toBe(s); // no-op, same reference
    s = toggle(s, T0 + MIN);
    expect(s.running).toBe(false);
  });

  it('reports elapsed minutes on the transition for the stats page', () => {
    const s = start(createTimer({ focusMin: 25 }), T0);
    const { transition } = skip(s, T0 + 12 * MIN + 20_000);
    expect(transition.elapsedMin).toBe(12);
    expect(transition.from).toBe('focus');
  });
});

describe('task + labels', () => {
  it('caps the task to 80 chars and coerces non-strings', () => {
    expect(setTask(createTimer(), 'x'.repeat(200)).task).toHaveLength(80);
    expect(setTask(createTimer(), null as never).task).toBe('');
  });

  it('labels every mode', () => {
    expect(modeLabel('idle')).toBe('READY');
    expect(modeLabel('focus')).toBe('FOCUS');
    expect(modeLabel('shortBreak')).toBe('SHORT BREAK');
    expect(modeLabel('longBreak')).toBe('LONG BREAK');
    expect(isBreak('shortBreak')).toBe(true);
    expect(isBreak('longBreak')).toBe(true);
    expect(isBreak('focus')).toBe(false);
  });
});

describe('AC-13 restore across a reload', () => {
  it('restores a still-running session with the correct remaining', () => {
    const s = start(setTask(createTimer({ focusMin: 25 }), 'thesis'), T0);
    const snap = snapshot(s);
    const restored = restore(snap, s.settings, T0 + 10 * MIN);
    expect(restored.running).toBe(true);
    expect(restored.mode).toBe('focus');
    expect(restored.task).toBe('thesis');
    expect(remainingAt(restored, T0 + 10 * MIN)).toBe(15 * MIN);
  });

  it('hands off to the next mode, paused, when the session expired while away', () => {
    const s = start(createTimer({ focusMin: 25 }), T0);
    const restored = restore(snapshot(s), s.settings, T0 + 40 * MIN);
    expect(restored.mode).toBe('shortBreak');
    expect(restored.running).toBe(false);
    expect(restored.remainingMs).toBe(5 * MIN);
  });

  it('survives a garbage snapshot', () => {
    for (const bad of [null, undefined, 'nope', 42, { mode: 'wat', round: 'x', endsAt: 'y' }]) {
      const restored = restore(bad as never, DEFAULT_TIMER_SETTINGS, T0);
      expect(restored.mode).toBe('idle');
      expect(Number.isFinite(restored.remainingMs)).toBe(true);
    }
  });
});
