import { describe, it, expect } from 'vitest';
import { ParticleSim, RECIPES } from '../src/scene/fx/particles';

describe('AC-16 particle pooling', () => {
  it('recycles slots so the pool size is a hard bound', () => {
    const sim = new ParticleSim(64);
    expect(sim.available).toBe(64);
    for (let i = 0; i < 500; i++) {
      sim.spawn({ x: 0, y: 0, z: 0, life: 1, size: 0.1, color: 0xffffff });
    }
    expect(sim.count).toBeLessThanOrEqual(64);
    expect(sim.capacity).toBe(64);
  });

  it('returns every slot to the free list once particles expire', () => {
    const sim = new ParticleSim(32);
    for (let i = 0; i < 32; i++) sim.spawn({ x: 0, y: 0, z: 0, life: 0.5, size: 0.1, color: 0x00ff00 });
    expect(sim.available).toBe(0);
    expect(sim.count).toBe(32);
    sim.step(0.6, 0);
    expect(sim.count).toBe(0);
    expect(sim.available).toBe(32);
  });

  it('allocates nothing after construction across 10 000 spawn/expire cycles', () => {
    const sim = new ParticleSim(128);
    const arrays = [sim.px, sim.py, sim.pz, sim.vx, sim.vy, sim.vz, sim.life, sim.size, sim.alpha];
    const buffers = arrays.map((a) => a.buffer);
    const byteLengths = arrays.map((a) => a.byteLength);

    for (let cycle = 0; cycle < 10_000; cycle++) {
      sim.spawn({ x: cycle % 5, y: 1, z: 0, life: 0.05, size: 0.1, color: 0xff00ff, gravity: 1 });
      sim.step(0.016, cycle * 0.016);
    }

    // Identity of every backing buffer is unchanged: no reallocation happened.
    arrays.forEach((a, i) => {
      expect(a.buffer).toBe(buffers[i]);
      expect(a.byteLength).toBe(byteLengths[i]);
    });
    expect(sim.count).toBeLessThanOrEqual(sim.capacity);
    expect(sim.available + sim.count).toBeLessThanOrEqual(sim.capacity);
  });

  it('never lets the free list exceed capacity even under repeated expiry passes', () => {
    const sim = new ParticleSim(16);
    sim.spawn({ x: 0, y: 0, z: 0, life: 0.1, size: 1, color: 0 });
    for (let i = 0; i < 20; i++) sim.step(1, i);
    expect(sim.available).toBe(16);
    expect(sim.count).toBe(0);
  });

  it('integrates gravity, velocity and drift', () => {
    const sim = new ParticleSim(4);
    const i = sim.spawn({ x: 0, y: 10, z: 0, vy: 0, life: 5, size: 1, color: 0, gravity: 10 });
    sim.step(0.1, 0);
    expect(sim.vy[i]).toBeCloseTo(-1, 5);
    expect(sim.py[i]).toBeCloseTo(9.9, 5);
  });

  it('fades alpha toward the end of life and holds when asked', () => {
    const sim = new ParticleSim(4);
    const fade = sim.spawn({ x: 0, y: 0, z: 0, life: 1, size: 1, color: 0 });
    const hold = sim.spawn({ x: 0, y: 0, z: 0, life: 1, size: 1, color: 0, hold: 1 });
    sim.step(0.5, 0);
    expect(sim.alpha[fade]).toBeGreaterThan(0.9); // still bright at the halfway point
    expect(sim.alpha[hold]).toBe(1);
    sim.step(0.4, 0);
    expect(sim.alpha[fade]).toBeLessThan(0.35);
  });

  it('clear() empties the field and restores the whole free list', () => {
    const sim = new ParticleSim(20);
    for (let i = 0; i < 20; i++) sim.spawn({ x: 0, y: 0, z: 0, life: 9, size: 1, color: 0 });
    sim.clear();
    expect(sim.count).toBe(0);
    expect(sim.available).toBe(20);
  });

  it('handles a zero-capacity pool without throwing', () => {
    const sim = new ParticleSim(0);
    expect(sim.spawn({ x: 0, y: 0, z: 0, life: 1, size: 1, color: 0 })).toBe(-1);
    expect(() => sim.step(0.016, 0)).not.toThrow();
  });

  it('every recipe produces a finite, in-range particle', () => {
    const specs = [
      RECIPES.heart(1, 2, 3, 0),
      RECIPES.fish(0, 0, 0),
      RECIPES.spark(0, 1, 0),
      RECIPES.rain(10, 8),
      RECIPES.firefly(10, 8),
      RECIPES.mote(10, 8),
      RECIPES.petal(10, 8),
      RECIPES.snow(10, 8),
      RECIPES.nom(0, 1, 0, 0xffffff),
    ];
    for (const s of specs) {
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.y)).toBe(true);
      expect(Number.isFinite(s.z)).toBe(true);
      expect(s.life).toBeGreaterThan(0);
      expect(s.size).toBeGreaterThan(0);
      expect(s.color).toBeGreaterThanOrEqual(0);
      expect(s.color).toBeLessThanOrEqual(0xffffff);
    }
  });
});
