/**
 * Procedural cat animation — no imported clips (spec §6.2).
 *
 * The whole system is a *pose target + damping* model. Each pose writes desired joint values
 * into a scratch struct; the animator damps the live values toward them and applies once per
 * frame. Transitions are therefore free: switching pose mid-stride just changes the target and
 * the cat eases into it, instead of popping.
 *
 * The tail is a nested chain (see catFactory), so a phase-shifted sine per joint compounds into
 * a travelling S-curve for almost nothing.
 */

import * as THREE from 'three';
import { setEmotion, type CatEmotion, type CatParts } from './catFactory';
import { damp, lerp, TAU } from '../voxel';

export type CatPose =
  | 'stand'
  | 'walk'
  | 'sit'
  | 'sleep'
  | 'lounge'
  | 'play'
  | 'eat'
  | 'pet'
  | 'stretch'
  | 'trick-spin'
  | 'trick-highfive'
  | 'trick-flop';

interface Joints {
  bodyY: number;
  bodyPitch: number;
  bodyRoll: number;
  squashX: number;
  squashY: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  legs: [number, number, number, number];
  tailLift: number;
  tailSwing: number;
  tailWave: number;
  earTilt: number;
}

function zeroJoints(): Joints {
  return {
    bodyY: 0,
    bodyPitch: 0,
    bodyRoll: 0,
    squashX: 1,
    squashY: 1,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    legs: [0, 0, 0, 0],
    tailLift: 0,
    tailSwing: 0.35,
    tailWave: 1,
    earTilt: 0,
  };
}

export interface AnimatorOptions {
  /** Per-cat phase offset so a room of cats never breathes in unison. */
  phase?: number;
  reducedMotion?: boolean;
}

export class CatAnimator {
  private parts: CatParts;
  private live = zeroJoints();
  private want = zeroJoints();
  private pose: CatPose = 'stand';
  private phase: number;
  private reduced: boolean;
  private poseTime = 0;
  /** Countdown to the next ear twitch (spec: every 6-14 s). */
  private nextTwitch: number;
  private twitchTimer = 0;
  private blinkTimer = 0;
  private nextBlink: number;
  private emotion: CatEmotion = 'neutral';
  private baseEmotion: CatEmotion = 'neutral';
  /** Speed 0..1, drives walk cycle rate. */
  private speed = 0;
  private trickTime = 0;

  constructor(parts: CatParts, opts: AnimatorOptions = {}) {
    this.parts = parts;
    this.phase = opts.phase ?? Math.random() * TAU;
    this.reduced = Boolean(opts.reducedMotion);
    this.nextTwitch = 6 + Math.random() * 8;
    this.nextBlink = 3 + Math.random() * 5;
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  getPose(): CatPose {
    return this.pose;
  }

  setPose(pose: CatPose): void {
    if (this.pose === pose) return;
    this.pose = pose;
    this.poseTime = 0;
    this.trickTime = 0;
    this.baseEmotion = defaultEmotionFor(pose);
    this.setEmotion(this.baseEmotion);
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0, Math.min(1.6, speed));
  }

  setEmotion(emotion: CatEmotion): void {
    if (this.emotion === emotion) return;
    this.emotion = emotion;
    setEmotion(this.parts, emotion);
  }

  /** A one-shot expression that decays back to the pose's default. */
  flashEmotion(emotion: CatEmotion, seconds = 1.6): void {
    this.setEmotion(emotion);
    this.flashLeft = seconds;
  }

  private flashLeft = 0;

  /** True while a trick animation is still playing — the brain waits on this. */
  get trickBusy(): boolean {
    return this.pose.startsWith('trick-') && this.trickTime < TRICK_DURATION;
  }

  update(dt: number, elapsed: number): void {
    const t = elapsed + this.phase;
    this.poseTime += dt;
    if (this.pose.startsWith('trick-')) this.trickTime += dt;

    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0) this.setEmotion(this.baseEmotion);
    }

    const w = this.want;
    resetInto(w);
    applyPose(this.pose, w, t, this.speed, this.poseTime, this.trickTime, this.reduced);

    // Idle life: ear twitches and blinks. Both are suppressed under reduced motion.
    if (!this.reduced) {
      this.twitchTimer += dt;
      if (this.twitchTimer >= this.nextTwitch) {
        this.twitchTimer = 0;
        this.nextTwitch = 6 + Math.random() * 8;
        this.twitchLeft = 0.28;
      }
      if (this.twitchLeft > 0) {
        this.twitchLeft -= dt;
        w.earTilt += Math.sin((0.28 - this.twitchLeft) / 0.28 * Math.PI * 3) * 0.5;
      }

      if (this.pose !== 'sleep' && this.emotion === this.baseEmotion && this.baseEmotion === 'neutral') {
        this.blinkTimer += dt;
        if (this.blinkTimer >= this.nextBlink) {
          this.blinkTimer = 0;
          this.nextBlink = 3 + Math.random() * 5;
          this.flashEmotion('blink', 0.14);
        }
      }
    }

    const lambda = this.reduced ? Infinity : 9;
    const L = this.live;
    if (this.reduced) {
      copyInto(L, w);
    } else {
      L.bodyY = damp(L.bodyY, w.bodyY, lambda, dt);
      L.bodyPitch = damp(L.bodyPitch, w.bodyPitch, lambda, dt);
      L.bodyRoll = damp(L.bodyRoll, w.bodyRoll, lambda, dt);
      L.squashX = damp(L.squashX, w.squashX, lambda, dt);
      L.squashY = damp(L.squashY, w.squashY, lambda, dt);
      L.headPitch = damp(L.headPitch, w.headPitch, lambda, dt);
      L.headYaw = damp(L.headYaw, w.headYaw, lambda, dt);
      L.headRoll = damp(L.headRoll, w.headRoll, lambda, dt);
      for (let i = 0; i < 4; i++) L.legs[i] = damp(L.legs[i], w.legs[i], lambda * 1.6, dt);
      L.tailLift = damp(L.tailLift, w.tailLift, lambda, dt);
      L.tailSwing = damp(L.tailSwing, w.tailSwing, lambda, dt);
      L.tailWave = damp(L.tailWave, w.tailWave, lambda, dt);
      L.earTilt = damp(L.earTilt, w.earTilt, lambda * 2, dt);
    }

    this.apply(t);
  }

  private twitchLeft = 0;

  private apply(t: number): void {
    const p = this.parts;
    const L = this.live;

    p.body.position.y = L.bodyY;
    p.body.rotation.x = L.bodyPitch;
    p.body.rotation.z = L.bodyRoll;
    p.body.scale.set(L.squashX, L.squashY, L.squashX);

    // Must match headPivot's rest height in catFactory. The head is the big shape now and
    // sits lower on a smaller body; a stale constant here floats it off the shoulders.
    p.headPivot.position.y = 0.46 + L.bodyY;
    p.headPivot.rotation.set(L.headPitch + L.bodyPitch * 0.5, L.headYaw, L.headRoll + L.bodyRoll * 0.6);

    p.earL.rotation.z = L.earTilt;
    p.earR.rotation.z = -L.earTilt * 0.8;

    for (let i = 0; i < 4; i++) {
      p.legs[i].rotation.x = L.legs[i];
      p.legs[i].position.y = 0.24 + L.bodyY;
    }

    // Tail: phase-shifted sine per joint = travelling wave.
    for (let i = 0; i < p.tail.length; i++) {
      const seg = p.tail[i];
      const shift = i * 0.55;
      const amp = L.tailSwing * (0.35 + i * 0.16);
      seg.rotation.y = this.reduced ? 0 : Math.sin(t * 1.7 * L.tailWave - shift) * amp;
      seg.rotation.x = i === 0 ? L.tailLift : L.tailLift * 0.25 + (this.reduced ? 0 : Math.sin(t * 1.1 - shift) * 0.06);
    }

    // Worn items: charms float and turn, cloth trails the body. Everything else is welded to
    // its joint and needs no per-frame work.
    for (const item of p.worn.values()) {
      if (!item.animated) continue;
      if (this.reduced) {
        item.group.position.y = 1.02;
        item.group.rotation.set(0, 0, 0);
        continue;
      }
      item.group.rotation.y = t * 0.7;
      item.group.position.y = 1.02 + Math.sin(t * 1.9) * 0.05;
      for (const child of item.group.children) {
        if (child.name.startsWith('spark')) {
          const i = Number(child.name.slice(5)) || 0;
          child.position.y = Math.sin(t * 2.6 + i * 1.6) * 0.09;
        }
      }
    }

    const cape = p.root.getObjectByName('capeCloth');
    if (cape) {
      cape.rotation.x = this.reduced ? 0 : -0.12 - L.legs[0] * 0.18 - Math.sin(t * 2.2) * 0.05;
    }
    const scarfTail = p.root.getObjectByName('scarfTail');
    if (scarfTail) {
      scarfTail.rotation.z = this.reduced ? 0 : Math.sin(t * 2.4) * 0.28;
    }

    // The patches mesh rides the body, if this breed has one.
    const patches = p.root.getObjectByName('patches');
    if (patches) {
      patches.position.y = 0.34 + L.bodyY;
      patches.rotation.x = L.bodyPitch;
      patches.scale.set(L.squashX, L.squashY, L.squashX);
    }
  }
}

const TRICK_DURATION = 1.5;

function defaultEmotionFor(pose: CatPose): CatEmotion {
  switch (pose) {
    case 'sleep':
      return 'sleep';
    case 'eat':
      return 'eat';
    case 'pet':
      return 'love';
    case 'play':
    case 'trick-spin':
    case 'trick-highfive':
    case 'trick-flop':
      return 'happy';
    case 'lounge':
      return 'blink';
    default:
      return 'neutral';
  }
}

function resetInto(j: Joints): void {
  j.bodyY = 0;
  j.bodyPitch = 0;
  j.bodyRoll = 0;
  j.squashX = 1;
  j.squashY = 1;
  j.headPitch = 0;
  j.headYaw = 0;
  j.headRoll = 0;
  j.legs[0] = 0;
  j.legs[1] = 0;
  j.legs[2] = 0;
  j.legs[3] = 0;
  j.tailLift = 0;
  j.tailSwing = 0.35;
  j.tailWave = 1;
  j.earTilt = 0;
}

function copyInto(dst: Joints, src: Joints): void {
  dst.bodyY = src.bodyY;
  dst.bodyPitch = src.bodyPitch;
  dst.bodyRoll = src.bodyRoll;
  dst.squashX = src.squashX;
  dst.squashY = src.squashY;
  dst.headPitch = src.headPitch;
  dst.headYaw = src.headYaw;
  dst.headRoll = src.headRoll;
  for (let i = 0; i < 4; i++) dst.legs[i] = src.legs[i];
  dst.tailLift = src.tailLift;
  dst.tailSwing = src.tailSwing;
  dst.tailWave = src.tailWave;
  dst.earTilt = src.earTilt;
}

function applyPose(
  pose: CatPose,
  j: Joints,
  t: number,
  speed: number,
  poseTime: number,
  trickTime: number,
  reduced: boolean,
): void {
  const still = reduced;

  switch (pose) {
    case 'walk': {
      const rate = 5.2 + speed * 3.4;
      const swing = 0.55 * Math.min(1, 0.4 + speed);
      // Diagonal pairs, the way a cat actually moves.
      j.legs[0] = Math.sin(t * rate) * swing;
      j.legs[3] = Math.sin(t * rate) * swing;
      j.legs[1] = Math.sin(t * rate + Math.PI) * swing;
      j.legs[2] = Math.sin(t * rate + Math.PI) * swing;
      j.bodyY = still ? 0 : Math.abs(Math.sin(t * rate)) * 0.045;
      j.bodyRoll = still ? 0 : Math.sin(t * rate) * 0.035;
      j.headPitch = -0.06;
      j.tailLift = -0.35;
      j.tailSwing = 0.5;
      j.tailWave = 1.5;
      break;
    }

    case 'sit': {
      j.bodyY = -0.06;
      j.bodyPitch = -0.16;
      j.legs[2] = -1.15;
      j.legs[3] = -1.15;
      j.legs[0] = 0.05;
      j.legs[1] = 0.05;
      j.tailLift = 0.1;
      j.tailSwing = 0.22;
      j.tailWave = 0.5;
      j.headYaw = still ? 0 : Math.sin(t * 0.5) * 0.16;
      break;
    }

    case 'sleep': {
      // Loaf: everything tucked, breathing on a slow scale pulse.
      const breath = still ? 0 : Math.sin(t * 1.15) * 0.028;
      j.bodyY = -0.19;
      j.squashY = 0.84 + breath;
      j.squashX = 1.08 - breath * 0.5;
      j.legs[0] = -1.5;
      j.legs[1] = -1.5;
      j.legs[2] = -1.5;
      j.legs[3] = -1.5;
      j.headPitch = 0.34;
      j.headRoll = 0.12;
      j.tailLift = 0.55;
      j.tailSwing = 0.1;
      j.tailWave = 0.35;
      break;
    }

    case 'lounge': {
      // On one side, tail flicking.
      j.bodyY = -0.16;
      j.bodyRoll = 1.05;
      j.headRoll = 0.9;
      j.headPitch = 0.1;
      j.legs[0] = 0.5;
      j.legs[1] = 0.3;
      j.legs[2] = -0.4;
      j.legs[3] = -0.6;
      j.tailLift = 0.2;
      j.tailSwing = still ? 0.1 : 0.65;
      j.tailWave = 0.75;
      break;
    }

    case 'play': {
      // Play-bow: front down, back up, batting.
      const bat = still ? 0 : Math.sin(t * 7.5);
      j.bodyPitch = 0.4;
      j.bodyY = -0.05;
      j.legs[0] = -0.5 + bat * 0.75;
      j.legs[1] = -0.35 - bat * 0.4;
      j.legs[2] = 0.3;
      j.legs[3] = 0.3;
      j.headPitch = -0.28;
      j.tailLift = -0.9;
      j.tailSwing = 0.85;
      j.tailWave = 2.1;
      break;
    }

    case 'eat': {
      const nom = still ? 0 : Math.sin(t * 9) * 0.09;
      j.bodyY = -0.1;
      j.bodyPitch = 0.14;
      j.headPitch = 0.62 + nom;
      j.legs[2] = -0.85;
      j.legs[3] = -0.85;
      j.tailLift = -0.1;
      j.tailSwing = 0.3;
      j.tailWave = 1.2;
      break;
    }

    case 'pet': {
      // Squash + lean into the hand.
      const purr = still ? 0 : Math.sin(t * 14) * 0.012;
      j.squashY = 0.82 + purr;
      j.squashX = 1.12 - purr;
      j.bodyY = -0.14;
      j.headPitch = 0.18;
      j.headRoll = 0.22;
      j.legs[0] = -1.2;
      j.legs[1] = -1.2;
      j.legs[2] = -1.3;
      j.legs[3] = -1.3;
      j.tailLift = 0.35;
      j.tailSwing = 0.55;
      j.tailWave = 1.8;
      break;
    }

    case 'stretch': {
      // A 1.2 s arc: reach forward, arch, settle.
      const k = Math.min(1, poseTime / 1.2);
      const arc = Math.sin(k * Math.PI);
      j.bodyPitch = 0.5 * arc;
      j.bodyY = -0.08 * arc;
      j.squashX = 1 + 0.1 * arc;
      j.squashY = 1 - 0.08 * arc;
      j.legs[0] = -0.9 * arc;
      j.legs[1] = -0.9 * arc;
      j.legs[2] = 0.5 * arc;
      j.legs[3] = 0.5 * arc;
      j.headPitch = -0.4 * arc;
      j.tailLift = -1.1 * arc;
      j.tailSwing = 0.5;
      break;
    }

    case 'trick-spin': {
      j.tailLift = -0.5;
      j.tailSwing = 0.9;
      j.tailWave = 2.4;
      j.bodyY = Math.sin(Math.min(1, trickTime / TRICK_DURATION) * Math.PI) * 0.12;
      break;
    }

    case 'trick-highfive': {
      const k = Math.min(1, trickTime / TRICK_DURATION);
      const raise = Math.sin(k * Math.PI);
      j.legs[2] = -1.15;
      j.legs[3] = -1.15;
      j.legs[0] = -1.6 * raise;
      j.bodyPitch = -0.2 - 0.12 * raise;
      j.bodyY = -0.04;
      j.headPitch = -0.15 * raise;
      j.tailLift = 0.2;
      break;
    }

    case 'trick-flop': {
      const k = Math.min(1, trickTime / TRICK_DURATION);
      const roll = Math.sin(k * Math.PI) * 1.4;
      j.bodyRoll = roll;
      j.headRoll = roll * 0.8;
      j.bodyY = -0.16 * Math.sin(k * Math.PI);
      j.legs[0] = 0.6 * roll;
      j.legs[1] = 0.4 * roll;
      j.tailSwing = 0.7;
      break;
    }

    case 'stand':
    default: {
      j.bodyY = still ? 0 : Math.sin(t * 1.3) * 0.012;
      j.headYaw = still ? 0 : Math.sin(t * 0.42) * 0.2;
      j.tailLift = -0.15;
      j.tailSwing = 0.38;
      j.tailWave = 0.85;
      break;
    }
  }
}

/** Bond level → trick unlocked (spec §8.2). */
export function trickForBond(level: number): CatPose | null {
  if (level >= 8) return 'trick-flop';
  if (level >= 5) return 'trick-highfive';
  if (level >= 3) return 'trick-spin';
  return null;
}

export const TRICK_NAMES: Record<string, string> = {
  'trick-spin': 'spin',
  'trick-highfive': 'high-five',
  'trick-flop': 'flop',
};

/** Utility used by the drag interaction: ease a cat back down onto a surface. */
export function settleOnto(object: THREE.Object3D, y: number, dt: number, reduced: boolean): boolean {
  if (reduced) {
    object.position.y = y;
    return true;
  }
  object.position.y = damp(object.position.y, y, 12, dt);
  if (Math.abs(object.position.y - y) < 0.005) {
    object.position.y = y;
    return true;
  }
  return false;
}

export { lerp };
