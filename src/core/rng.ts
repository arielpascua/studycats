/**
 * Seedable RNG (mulberry32). Used everywhere a "random" decision must be reproducible in a
 * test — snack drops, cat brains, visitor rolls, daily quest selection.
 */

export interface Rng {
  (): number;
  int(maxExclusive: number): number;
  range(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates, returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.int = (maxExclusive: number) => Math.floor(next() * Math.max(0, maxExclusive));
  rng.range = (min: number, max: number) => min + next() * (max - min);
  rng.pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  rng.shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  rng.chance = (p: number) => next() < p;
  return rng;
}

/** Stable 32-bit hash of a string — turns a day key into a seed. */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** The ambient, non-deterministic RNG for pure decoration (particles, idle jitter). */
export const rand: Rng = (() => {
  const fn = (() => Math.random()) as Rng;
  fn.int = (m: number) => Math.floor(Math.random() * Math.max(0, m));
  fn.range = (min: number, max: number) => min + Math.random() * (max - min);
  fn.pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
  fn.shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  fn.chance = (p: number) => Math.random() < p;
  return fn;
})();
