/**
 * Calendar and clock helpers. Everything is *local* time on purpose: a study streak should
 * follow the user's day, not UTC's. All functions take an explicit `Date`/epoch so they are
 * deterministic under test.
 */

export type DayPhase = 'dawn' | 'morning' | 'afternoon' | 'golden' | 'dusk' | 'night';
export type Season = 'sakura' | 'summer' | 'rain' | 'winter' | 'plain';

const MS_PER_DAY = 86_400_000;

/** Local calendar key, `YYYY-MM-DD`. Stable across timezones for a given wall clock. */
export function dayKey(at: Date | number = Date.now()): string {
  const d = typeof at === 'number' ? new Date(at) : at;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Whole local days between two `YYYY-MM-DD` keys (`b - a`). Negative if b precedes a. */
export function daysBetween(a: string, b: string): number {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  if (pa === null || pb === null) return NaN;
  return Math.round((pb - pa) / MS_PER_DAY);
}

export function parseDayKey(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Midday avoids DST boundaries shifting the day when we subtract.
  return new Date(y, mo - 1, d, 12, 0, 0, 0).getTime();
}

/** Shift a day key by n days. */
export function addDays(key: string, n: number): string {
  const t = parseDayKey(key);
  if (t === null) return key;
  return dayKey(new Date(t + n * MS_PER_DAY));
}

/**
 * Where we are in the day, used to drive sky color, window light and lamp states.
 * Boundaries chosen so "studying at 11pm feels like 11pm" (spec §4.7).
 */
export function dayPhase(at: Date | number = Date.now()): DayPhase {
  const d = typeof at === 'number' ? new Date(at) : at;
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 6) return 'night';
  if (h < 8) return 'dawn';
  if (h < 12) return 'morning';
  if (h < 16.5) return 'afternoon';
  if (h < 18.5) return 'golden';
  if (h < 20.5) return 'dusk';
  return 'night';
}

/**
 * Continuous 0..1 position through the phase, for smooth interpolation between two palettes
 * instead of a hard cut at the boundary.
 */
export function dayPhaseBlend(at: Date | number = Date.now()): { phase: DayPhase; next: DayPhase; t: number } {
  const d = typeof at === 'number' ? new Date(at) : at;
  const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const stops: Array<[number, DayPhase]> = [
    [0, 'night'],
    [6, 'dawn'],
    [8, 'morning'],
    [12, 'afternoon'],
    [16.5, 'golden'],
    [18.5, 'dusk'],
    [20.5, 'night'],
    [24, 'night'],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [h0, p0] = stops[i];
    const [h1, p1] = stops[i + 1];
    if (h >= h0 && h < h1) {
      const span = h1 - h0;
      return { phase: p0, next: p1, t: span > 0 ? (h - h0) / span : 0 };
    }
  }
  return { phase: 'night', next: 'night', t: 0 };
}

/** Seasonal flavour by real date (spec §8.4). */
export function season(at: Date | number = Date.now()): Season {
  const d = typeof at === 'number' ? new Date(at) : at;
  const m = d.getMonth() + 1;
  if (m === 3 || m === 4) return 'sakura';
  if (m === 6 || m === 7) return 'rain';
  if (m === 8 || m === 9) return 'summer';
  if (m === 12 || m === 1) return 'winter';
  return 'plain';
}

/** `MM:SS`, or `H:MM:SS` past an hour. Never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "2h 15m" / "45m" / "0m" — for the stats page. */
export function formatDuration(minutes: number): string {
  const mins = Math.max(0, Math.round(minutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
