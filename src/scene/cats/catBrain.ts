/**
 * Cat behaviour brain (spec §6.3, weights from the prototype parity notes).
 *
 * Deliberately free of Three.js: the brain owns a 2D position, a heading and a pose, and emits
 * *intents* ("claim something to eat", "take a bite"). The world layer moves meshes to match.
 * That separation is what lets the whole behaviour system be unit-tested without a GPU.
 *
 * Parity weights:
 *   focus → sleep .45 / sit .37 / walk .18
 *   break → seek snack .7, else lounge or walk
 *   idle  → wander / sit / sleep / play mix, tilted by breed temperament
 */

import type { Rng } from '../../core/rng';
import type { CatPose } from './catAnimator';
import type { BreedDef } from '../../data/breeds';

export type BrainMode = 'idle' | 'focus' | 'break';

export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export interface BrainContext {
  mode: BrainMode;
  /**
   * The walkable area. `radius` makes it a CIRCLE rather than the w x d rectangle — the arena
   * is an island, and a rectangular clamp let cats stroll out over the water at the corners.
   */
  /**
   * The walkable footprint. `cx`/`cz` let it sit OFF-CENTRE: the solo rooms' far walls are at
   * -x/-z and the rooms extend toward the viewer, so a rect centred on the origin can only be as
   * big as the distance to the nearest far wall — which is why the cats had a strip to pace in
   * while two-thirds of the floor went unused.
   */
  bounds: { w: number; d: number; cx?: number; cz?: number; radius?: number };
  obstacles: readonly Obstacle[];
  /** Present during a break; the brain asks for a target through the intents. */
  feedingActive: boolean;
  rng: Rng;
  reducedMotion: boolean;
  /** Multiplies how often a cat chooses to walk. The arena turns this up; a fireside circle
   *  should mill about rather than doze the way they do beside your desk. */
  wanderlust?: number;
}

export interface BrainIntent {
  /** Ask the world for something to eat; it answers with `setTarget`. */
  wantFood?: boolean;
  /** Take a bite of the currently-held snack. */
  bite?: boolean;
  /** Arrived at a bowl. */
  sip?: boolean;
  /** Give up whatever is held (target unreachable / lost interest). */
  releaseFood?: boolean;
}

export interface BrainSnapshot {
  x: number;
  z: number;
  facing: number;
  pose: CatPose;
  speed: number;
}

const WALK_SPEED = 0.85;
const ARRIVE_RADIUS = 0.34;
/** Cats keep this far from a prop's bounding circle. */
const AVOID_MARGIN = 0.28;

interface Weighted<T> {
  value: T;
  weight: number;
}

function pickWeighted<T>(rng: Rng, options: readonly Weighted<T>[]): T {
  const total = options.reduce((s, o) => s + o.weight, 0);
  let cursor = rng() * total;
  for (const o of options) {
    cursor -= o.weight;
    if (cursor < 0) return o.value;
  }
  return options[options.length - 1].value;
}

export class CatBrain {
  readonly id: string;
  x: number;
  z: number;
  facing: number;

  private pose: CatPose = 'sit';
  private speed = 0;
  private breed: BreedDef;
  /** Seconds until the next decision. */
  private timer = 0;
  private target: { x: number; z: number } | null = null;
  /** What the target represents, so arrival does the right thing. */
  private targetKind: 'wander' | 'food' | 'bowl' | 'none' = 'none';
  private biteTimer = 0;
  private lastMode: BrainMode = 'idle';
  /** Set by the world when the user is dragging this cat. */
  held = false;
  /**
   * A spot this cat gravitates back to — its cushion in the arena. Not a leash: it only biases
   * where the next wander point is chosen, so the cat roams and then drifts home rather than
   * being pinned in place.
   */
  home: { x: number; z: number } | null = null;
  /** How strongly `home` pulls, 0..1. */
  homePull = 0.45;
  /** Set by the world while a trick plays. */
  private frozenUntil = 0;
  private clock = 0;
  private stuckFor = 0;

  constructor(id: string, breed: BreedDef, start: { x: number; z: number }, facing = 0) {
    this.id = id;
    this.breed = breed;
    this.x = start.x;
    this.z = start.z;
    this.facing = facing;
  }

  snapshot(): BrainSnapshot {
    return { x: this.x, z: this.z, facing: this.facing, pose: this.pose, speed: this.speed };
  }

  getPose(): CatPose {
    return this.pose;
  }

  /** The world calls this after a successful claim. */
  setFoodTarget(target: { x: number; z: number } | null, kind: 'food' | 'bowl'): void {
    if (!target) {
      this.target = null;
      this.targetKind = 'none';
      return;
    }
    this.target = { x: target.x, z: target.z };
    this.targetKind = kind;
  }

  /** Force a pose for a fixed time (petting, tricks) — the brain resumes afterwards. */
  freeze(pose: CatPose, seconds: number): void {
    this.pose = pose;
    this.speed = 0;
    this.target = null;
    this.targetKind = 'none';
    this.frozenUntil = this.clock + seconds;
  }

  /**
   * Turn to look at a point. Used when the cat is touched: whoever poked it should be
   * acknowledged. The next walk overwrites this, which is correct — it is a glance, not a lock.
   */
  faceToward(x: number, z: number): void {
    const dx = x - this.x;
    const dz = z - this.z;
    if (Math.hypot(dx, dz) < 0.0001) return;
    this.facing = Math.atan2(dx, dz);
  }

  /** Teleport (drag & drop). Clears any stale plan so the cat re-decides where it is now. */
  placeAt(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.target = null;
    this.targetKind = 'none';
    this.timer = 0;
    this.stuckFor = 0;
  }

  update(dt: number, ctx: BrainContext): BrainIntent {
    this.clock += dt;
    const intent: BrainIntent = {};

    if (this.held) {
      this.pose = 'play';
      this.speed = 0;
      return intent;
    }

    if (this.clock < this.frozenUntil) {
      return intent;
    }

    // A mode change is a hard interrupt: cats visibly react to the timer.
    if (ctx.mode !== this.lastMode) {
      this.lastMode = ctx.mode;
      this.timer = 0;
      if (ctx.mode === 'break') {
        this.pose = 'stretch';
        this.target = null;
        this.targetKind = 'none';
        this.timer = 1.2; // finish the stretch before seeking food
        if (this.targetKind === 'none') intent.releaseFood = true;
        return intent;
      }
      if (ctx.mode === 'focus') {
        intent.releaseFood = true;
        this.target = null;
        this.targetKind = 'none';
      }
    }

    // Break-time seeking overrides the normal decision loop.
    if (ctx.mode === 'break' && ctx.feedingActive) {
      return this.updateBreak(dt, ctx);
    }

    if (this.targetKind === 'food' || this.targetKind === 'bowl') {
      // Feeding ended while we were walking to a snack.
      this.target = null;
      this.targetKind = 'none';
      intent.releaseFood = true;
    }

    this.timer -= dt;
    if (this.timer <= 0) this.decide(ctx);

    if (this.target) {
      const arrived = this.moveToward(this.target, dt, ctx);
      if (arrived) {
        this.target = null;
        this.targetKind = 'none';
        this.pose = 'sit';
        this.timer = 1 + ctx.rng() * 3;
      }
    } else {
      this.speed = 0;
    }

    return intent;
  }

  private updateBreak(dt: number, ctx: BrainContext): BrainIntent {
    const intent: BrainIntent = {};
    this.timer -= dt;

    if (this.pose === 'stretch' && this.timer > 0) {
      this.speed = 0;
      return intent;
    }

    if (!this.target) {
      // 0.7 seek snack, else lounge or walk (parity note).
      if (this.targetKind === 'none' && ctx.rng() < 0.7) {
        intent.wantFood = true;
        this.targetKind = 'none';
        // The world answers via setFoodTarget; until then, idle politely.
        if (this.pose !== 'lounge' && this.pose !== 'walk') this.pose = 'sit';
        this.timer = 0.35;
        return intent;
      }
      if (this.timer <= 0) {
        const choice = pickWeighted(ctx.rng, [
          { value: 'lounge' as CatPose, weight: 0.6 },
          { value: 'walk' as CatPose, weight: 0.4 },
        ]);
        if (choice === 'walk') {
          this.target = this.pickWanderPoint(ctx);
          this.targetKind = 'wander';
          this.pose = 'walk';
        } else {
          this.pose = 'lounge';
          this.speed = 0;
        }
        this.timer = 3 + ctx.rng() * 4;
      }
      return intent;
    }

    const arrived = this.moveToward(this.target, dt, ctx);
    if (!arrived) return intent;

    if (this.targetKind === 'food') {
      this.pose = 'eat';
      this.speed = 0;
      this.biteTimer -= dt;
      if (this.biteTimer <= 0) {
        this.biteTimer = 0.85;
        intent.bite = true;
      }
    } else if (this.targetKind === 'bowl') {
      this.pose = 'eat';
      this.speed = 0;
      this.biteTimer -= dt;
      if (this.biteTimer <= 0) {
        this.biteTimer = 1.4;
        intent.sip = true;
      }
    } else {
      this.target = null;
      this.targetKind = 'none';
      this.pose = 'sit';
      this.timer = 0.5;
    }

    return intent;
  }

  private decide(ctx: BrainContext): void {
    const temp = this.breed.temperament;

    if (ctx.mode === 'focus') {
      // They study with you, calmly.
      const pose = pickWeighted(ctx.rng, [
        { value: 'sleep' as CatPose, weight: 0.45 + temp.sleepy * 0.15 },
        { value: 'sit' as CatPose, weight: 0.37 },
        { value: 'walk' as CatPose, weight: 0.18 * (0.5 + temp.energy) },
      ]);
      this.enter(pose, ctx);
      this.timer = 8 + ctx.rng() * 14;
      return;
    }

    const wanderlust = ctx.wanderlust ?? 1;
    const pose = pickWeighted(ctx.rng, [
      { value: 'walk' as CatPose, weight: 0.3 * (0.5 + temp.energy) * wanderlust },
      { value: 'sit' as CatPose, weight: 0.26 },
      { value: 'sleep' as CatPose, weight: 0.24 * (0.5 + temp.sleepy) },
      { value: 'play' as CatPose, weight: 0.14 * (0.4 + temp.energy) },
      { value: 'lounge' as CatPose, weight: 0.12 },
    ]);
    this.enter(pose, ctx);
    this.timer = 4 + ctx.rng() * 9;
  }

  private enter(pose: CatPose, ctx: BrainContext): void {
    this.pose = pose;
    if (pose === 'walk') {
      const point = this.pickWanderPoint(ctx);
      // pickWanderPoint can fall back to `home`, which may be where we already are. Re-deciding
      // shortly is better than standing in place holding a walk pose.
      if (Math.hypot(point.x - this.x, point.z - this.z) < ARRIVE_RADIUS * 1.5) {
        this.pose = 'sit';
        this.target = null;
        this.targetKind = 'none';
        this.timer = 1.5 + ctx.rng() * 2;
        return;
      }
      this.target = point;
      this.targetKind = 'wander';
    } else {
      this.target = null;
      this.targetKind = 'none';
      this.speed = 0;
    }
  }

  private pickWanderPoint(ctx: BrainContext): { x: number; z: number } {
    const radius = ctx.bounds.radius;
    const halfW = Math.max(0.5, ctx.bounds.w / 2 - 1);
    const halfD = Math.max(0.5, ctx.bounds.d / 2 - 1);
    const cx = ctx.bounds.cx ?? 0;
    const cz = ctx.bounds.cz ?? 0;

    // Ten tries to find a spot outside every obstacle.
    for (let i = 0; i < 10; i++) {
      let x: number;
      let z: number;

      if (this.home && ctx.rng() < this.homePull) {
        // Drift back toward the cushion — a loose orbit around it, not a return to the exact
        // spot, so the ring still reads as "these are their places" without looking staged.
        const angle = ctx.rng.range(0, Math.PI * 2);
        // Comfortably beyond ARRIVE_RADIUS: a target closer than that counts as already
        // reached, so the cat "arrives" without taking a step and stands still forever.
        const near = ctx.rng.range(1.0, 2.6);
        x = this.home.x + Math.sin(angle) * near;
        z = this.home.z + Math.cos(angle) * near;
      } else if (radius) {
        // Uniform over a disc: sqrt keeps them from bunching in the middle.
        const angle = ctx.rng.range(0, Math.PI * 2);
        const r = Math.sqrt(ctx.rng()) * radius;
        x = Math.sin(angle) * r;
        z = Math.cos(angle) * r;
      } else {
        x = cx + ctx.rng.range(-halfW, halfW);
        z = cz + ctx.rng.range(-halfD, halfD);
      }

      if (radius && Math.hypot(x, z) > radius) continue;
      // A destination inside the arrival radius is not a destination.
      if (Math.hypot(x - this.x, z - this.z) < ARRIVE_RADIUS * 2) continue;
      if (!this.blocked(x, z, ctx.obstacles)) return { x, z };
    }
    return this.home ?? { x: 0, z: 0 };
  }

  private blocked(x: number, z: number, obstacles: readonly Obstacle[]): boolean {
    for (const o of obstacles) {
      const dx = x - o.x;
      const dz = z - o.z;
      if (dx * dx + dz * dz < (o.r + AVOID_MARGIN) ** 2) return true;
    }
    return false;
  }

  /**
   * Steer toward `to`, sliding around obstacles rather than pathfinding. At diorama scale a
   * repulsion vector reads as deliberate feline detouring and costs nothing.
   */
  private moveToward(to: { x: number; z: number }, dt: number, ctx: BrainContext): boolean {
    let dx = to.x - this.x;
    let dz = to.z - this.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= ARRIVE_RADIUS) {
      this.speed = 0;
      this.stuckFor = 0;
      return true;
    }

    dx /= dist;
    dz /= dist;

    // Repulsion from anything we're about to clip.
    for (const o of ctx.obstacles) {
      const ox = this.x - o.x;
      const oz = this.z - o.z;
      const od = Math.hypot(ox, oz);
      const reach = o.r + AVOID_MARGIN;
      if (od < reach && od > 0.0001) {
        const push = (reach - od) / reach;
        dx += (ox / od) * push * 2.2;
        dz += (oz / od) * push * 2.2;
      }
    }

    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    const step = WALK_SPEED * dt;
    const nx = this.x + dx * step;
    const nz = this.z + dz * step;

    if (ctx.bounds.radius) {
      // Circular island: clamp onto the disc, or a cat walks off the edge onto open water.
      const limit = ctx.bounds.radius;
      const dist = Math.hypot(nx, nz);
      if (dist > limit && dist > 0.0001) {
        this.x = (nx / dist) * limit;
        this.z = (nz / dist) * limit;
      } else {
        this.x = nx;
        this.z = nz;
      }
    } else {
      const halfW = ctx.bounds.w / 2 - 0.4;
      const halfD = ctx.bounds.d / 2 - 0.4;
      const cx = ctx.bounds.cx ?? 0;
      const cz = ctx.bounds.cz ?? 0;
      this.x = Math.min(cx + halfW, Math.max(cx - halfW, nx));
      this.z = Math.min(cz + halfD, Math.max(cz - halfD, nz));
    }

    this.pose = 'walk';
    this.speed = 1;

    // Face the direction of travel, shortest way round.
    const wanted = Math.atan2(dx, dz);
    let delta = wanted - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.facing += delta * Math.min(1, dt * (ctx.reducedMotion ? 60 : 7));

    // Wedged against a prop for too long? Abandon the plan rather than vibrating forever.
    if (Math.hypot(nx - this.x, nz - this.z) > step * 0.4) {
      this.stuckFor += dt;
    } else {
      this.stuckFor = Math.max(0, this.stuckFor - dt * 0.5);
    }
    if (this.stuckFor > 2.5) {
      this.stuckFor = 0;
      return true;
    }

    return false;
  }
}
