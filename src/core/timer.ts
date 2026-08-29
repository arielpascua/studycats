/**
 * Pomodoro state machine — pure. No DOM, no timers, no globals.
 *
 * Drift-freedom is structural, not best-effort: while running we store an absolute
 * `endsAt` epoch and *derive* the remaining time from `now`. Nothing accumulates, so a
 * throttled tab, a suspended laptop, or a page reload all resolve to the same number.
 * `performance.now()` is for animation only; the timer's truth is `Date.now()`.
 */

export type TimerMode = 'idle' | 'focus' | 'shortBreak' | 'longBreak';

export interface TimerSettings {
  /** minutes, 1..120 */
  focusMin: number;
  /** minutes, 1..60 */
  shortBreakMin: number;
  /** minutes, 1..60 */
  longBreakMin: number;
  /** focus sessions before a long break, 2..8 */
  roundsPerLongBreak: number;
  /** advance into the next mode automatically */
  autoStart: boolean;
}

export interface TimerState {
  mode: TimerMode;
  running: boolean;
  /** Authoritative only while paused. While running, derive from `endsAt`. */
  remainingMs: number;
  /** Absolute epoch ms when the current session ends; null while paused/idle. */
  endsAt: number | null;
  /** Completed focus sessions since the last long break (0..roundsPerLongBreak). */
  round: number;
  task: string;
  settings: TimerSettings;
}

export interface TransitionEvent {
  from: TimerMode;
  to: TimerMode;
  /** false when the user pressed skip — the economy must not pay for skipped work. */
  natural: boolean;
  /** Round counter *after* the transition. */
  round: number;
  /** Whole minutes actually spent in `from`, for stats. Never negative. */
  elapsedMin: number;
}

export const DURATION_LIMITS = {
  focusMin: [1, 120],
  shortBreakMin: [1, 60],
  longBreakMin: [1, 60],
  roundsPerLongBreak: [2, 8],
} as const;

export const DEFAULT_TIMER_SETTINGS: TimerSettings = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  roundsPerLongBreak: 4,
  autoStart: false,
};

const MIN = 60_000;

/** Clamp one duration field, tolerating NaN / strings / nonsense without ever producing NaN. */
export function clampDuration(key: keyof typeof DURATION_LIMITS, value: unknown): number {
  const [lo, hi] = DURATION_LIMITS[key];
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TIMER_SETTINGS[key];
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export function sanitizeSettings(input: Partial<TimerSettings> | undefined | null): TimerSettings {
  const s = input ?? {};
  return {
    focusMin: clampDuration('focusMin', s.focusMin ?? DEFAULT_TIMER_SETTINGS.focusMin),
    shortBreakMin: clampDuration('shortBreakMin', s.shortBreakMin ?? DEFAULT_TIMER_SETTINGS.shortBreakMin),
    longBreakMin: clampDuration('longBreakMin', s.longBreakMin ?? DEFAULT_TIMER_SETTINGS.longBreakMin),
    roundsPerLongBreak: clampDuration('roundsPerLongBreak', s.roundsPerLongBreak ?? DEFAULT_TIMER_SETTINGS.roundsPerLongBreak),
    autoStart: Boolean(s.autoStart),
  };
}

/** Full duration of a mode in ms. `idle` reports the focus duration (what pressing start gives). */
export function durationFor(mode: TimerMode, settings: TimerSettings): number {
  switch (mode) {
    case 'shortBreak':
      return settings.shortBreakMin * MIN;
    case 'longBreak':
      return settings.longBreakMin * MIN;
    case 'focus':
    case 'idle':
    default:
      return settings.focusMin * MIN;
  }
}

export function createTimer(settings?: Partial<TimerSettings>): TimerState {
  const s = sanitizeSettings(settings);
  return {
    mode: 'idle',
    running: false,
    remainingMs: durationFor('focus', s),
    endsAt: null,
    round: 0,
    task: '',
    settings: s,
  };
}

/** Remaining ms at `now`. The single source of truth for display and completion. */
export function remainingAt(state: TimerState, now: number): number {
  if (state.running && state.endsAt !== null) {
    return Math.max(0, state.endsAt - now);
  }
  return Math.max(0, state.remainingMs);
}

/** 0..1 progress through the current session. */
export function progressAt(state: TimerState, now: number): number {
  const total = durationFor(state.mode === 'idle' ? 'focus' : state.mode, state.settings);
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingAt(state, now) / total));
}

/** Which mode a completed `mode` hands off to, given the round count *before* the handoff. */
export function nextMode(mode: TimerMode, round: number, settings: TimerSettings): { mode: TimerMode; round: number } {
  if (mode === 'focus') {
    const nextRound = round + 1;
    if (nextRound >= settings.roundsPerLongBreak) {
      return { mode: 'longBreak', round: nextRound };
    }
    return { mode: 'shortBreak', round: nextRound };
  }
  if (mode === 'longBreak') {
    // The cycle closes: dots clear.
    return { mode: 'focus', round: 0 };
  }
  if (mode === 'shortBreak') {
    return { mode: 'focus', round };
  }
  // idle -> focus
  return { mode: 'focus', round };
}

/** Start (or resume). From `idle` this enters a fresh focus session. */
export function start(state: TimerState, now: number): TimerState {
  if (state.running) return state;
  const mode = state.mode === 'idle' ? 'focus' : state.mode;
  const remaining = state.mode === 'idle' ? durationFor('focus', state.settings) : Math.max(0, state.remainingMs);
  if (remaining <= 0) return state;
  return { ...state, mode, running: true, remainingMs: remaining, endsAt: now + remaining };
}

export function pause(state: TimerState, now: number): TimerState {
  if (!state.running) return state;
  return { ...state, running: false, remainingMs: remainingAt(state, now), endsAt: null };
}

export function toggle(state: TimerState, now: number): TimerState {
  return state.running ? pause(state, now) : start(state, now);
}

/**
 * Back to idle with a full focus session queued. The session dots (`round`) survive —
 * resetting the clock is not the same as abandoning the cycle.
 */
export function reset(state: TimerState): TimerState {
  return {
    ...state,
    mode: 'idle',
    running: false,
    remainingMs: durationFor('focus', state.settings),
    endsAt: null,
  };
}

/** Full cycle reset, including the dots. Used by "new day" and by the settings panel. */
export function resetCycle(state: TimerState): TimerState {
  return { ...reset(state), round: 0 };
}

function advance(state: TimerState, now: number, natural: boolean): { state: TimerState; event: TransitionEvent } {
  const from = state.mode;
  const total = durationFor(from === 'idle' ? 'focus' : from, state.settings);
  const spent = from === 'idle' ? 0 : Math.max(0, total - remainingAt(state, now));
  const { mode: to, round } = nextMode(from, state.round, state.settings);
  const duration = durationFor(to, state.settings);
  const shouldRun = from !== 'idle' && state.settings.autoStart;
  const next: TimerState = {
    ...state,
    mode: to,
    round,
    running: shouldRun,
    remainingMs: duration,
    endsAt: shouldRun ? now + duration : null,
  };
  return {
    state: next,
    event: { from, to, natural, round, elapsedMin: Math.round(spent / MIN) },
  };
}

/**
 * Advance the clock. Returns the next state plus a transition event when a session ended.
 * Calling this after a long gap (throttled tab, sleep, reload) is safe: it completes at most
 * one session and hands the surplus back as a fresh full session, which is the kind thing to
 * do — nobody wants to wake the laptop and find four sessions silently "completed".
 */
export function tick(state: TimerState, now: number): { state: TimerState; transition?: TransitionEvent } {
  if (!state.running || state.endsAt === null) return { state };
  if (remainingAt(state, now) > 0) return { state };
  const { state: next, event } = advance(state, now, true);
  return { state: next, transition: event };
}

/** User pressed skip. Advances exactly like a completion, but flagged `natural: false`. */
export function skip(state: TimerState, now: number): { state: TimerState; transition: TransitionEvent } {
  const { state: next, event } = advance(state, now, false);
  return { state: next, transition: event };
}

export function setTask(state: TimerState, task: string): TimerState {
  return { ...state, task: String(task ?? '').slice(0, 80) };
}

/**
 * Apply new durations. A *running* session keeps its current end time (yanking time away
 * mid-focus is hostile); a paused/idle one is re-based to the new duration.
 */
export function applySettings(state: TimerState, patch: Partial<TimerSettings>, now: number): TimerState {
  const settings = sanitizeSettings({ ...state.settings, ...patch });
  if (state.running) {
    return { ...state, settings };
  }
  const mode = state.mode === 'idle' ? 'focus' : state.mode;
  const total = durationFor(mode, settings);
  const previousTotal = durationFor(mode, state.settings);
  // Preserve elapsed time when possible so an edit mid-pause doesn't erase progress.
  const elapsed = Math.max(0, previousTotal - Math.max(0, state.remainingMs));
  const remaining = state.mode === 'idle' ? total : Math.max(0, Math.min(total, total - elapsed));
  void now;
  return { ...state, settings, remainingMs: remaining, endsAt: null };
}

/** Human label for chrome and announcements. */
export function modeLabel(mode: TimerMode): string {
  switch (mode) {
    case 'focus':
      return 'FOCUS';
    case 'shortBreak':
      return 'SHORT BREAK';
    case 'longBreak':
      return 'LONG BREAK';
    default:
      return 'READY';
  }
}

export function isBreak(mode: TimerMode): boolean {
  return mode === 'shortBreak' || mode === 'longBreak';
}

/**
 * Serializable slice — `settings` lives in the save file separately, and `running`/`endsAt`
 * survive a reload precisely because `endsAt` is an absolute epoch.
 */
export interface TimerSnapshot {
  mode: TimerMode;
  running: boolean;
  remainingMs: number;
  endsAt: number | null;
  round: number;
  task: string;
}

export function snapshot(state: TimerState): TimerSnapshot {
  return {
    mode: state.mode,
    running: state.running,
    remainingMs: state.remainingMs,
    endsAt: state.endsAt,
    round: state.round,
    task: state.task,
  };
}

/**
 * Rehydrate after a reload. If the stored session already expired while the tab was closed we
 * do NOT silently burn through sessions — we land on the next mode, paused, ready to start.
 */
export function restore(snap: Partial<TimerSnapshot> | undefined | null, settings: TimerSettings, now: number): TimerState {
  const base = createTimer(settings);
  if (!snap || typeof snap !== 'object') return base;
  const mode: TimerMode =
    snap.mode === 'focus' || snap.mode === 'shortBreak' || snap.mode === 'longBreak' ? snap.mode : 'idle';
  const round = Number.isFinite(snap.round) ? Math.max(0, Math.min(settings.roundsPerLongBreak, Number(snap.round))) : 0;
  const task = typeof snap.task === 'string' ? snap.task.slice(0, 80) : '';
  const total = durationFor(mode, settings);

  let state: TimerState = { ...base, mode, round, task, remainingMs: total, endsAt: null, running: false };

  if (snap.running && typeof snap.endsAt === 'number' && Number.isFinite(snap.endsAt)) {
    const left = snap.endsAt - now;
    if (left > 0) {
      state = { ...state, running: true, remainingMs: left, endsAt: snap.endsAt };
    } else {
      // Expired while away: hand off, paused, so the user chooses to continue.
      const { mode: to, round: nextRound } = nextMode(mode, round, settings);
      state = { ...state, mode: to, round: nextRound, remainingMs: durationFor(to, settings), running: false, endsAt: null };
    }
  } else if (Number.isFinite(snap.remainingMs)) {
    state = { ...state, remainingMs: Math.max(0, Math.min(total, Number(snap.remainingMs))) };
  }

  return state;
}
