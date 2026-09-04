/**
 * THE GARDEN — what you look through the room at.
 *
 * The reference these scenes are measured against is a lofi thumbnail: a muted room whose back
 * wall opens onto fiery autumn maples, and everything in the foreground is arranged so you look
 * PAST it into that. Our rooms had no far thing — the wall was the last plane, and the window
 * was a tinted rectangle. This module is the far thing.
 *
 * It is a kit, not a scene: the environment decides where the opening is and calls these to fill
 * the space behind it. Three layers, back to front:
 *
 *   1. A painted backdrop — one canvasTexture on a quad, repainted only when the day phase
 *      changes (six times a day, never per frame). It carries the sky, the hills, a fence and a
 *      dithered wall of distant canopy. This is what makes the opening read as OUTSIDE and it is
 *      also what keeps the enclosure rule: a ray through the opening always hits paint.
 *   2. Voxel maples, a stone lantern and moss, in front of the paint, so the pixel pass outlines
 *      real depth and the trees parallax when the room turns.
 *   3. A warm light in the lantern, so at 11pm the garden is still somewhere you want to look.
 *
 * Nothing here is smooth: trees are stacks of boxes, the lantern is boxes, the paint is
 * hard-edged pixel bands. It is the same voxel world the room is built from.
 */

import * as THREE from 'three';
import type { DayPhase } from '../../core/time';
import { hex } from '../../data/palette';
import { BoxBatch, boxGeo, canvasTexture, flat, redrawCanvasTexture } from '../voxel';

/* --------------------------------------------------------------- palettes */

/** Autumn maple canopy, three tones so a tree is never one flat block. */
export const MAPLE = { red: '#D9503F', orange: '#F28C3B', gold: '#F5C04A', trunk: '#6B4A3A' } as const;
export const MOSS = '#7FA36B';
export const STONE = '#B7ADBE';

interface SkyPalette {
  /** Top-to-horizon sky bands. */
  sky: [string, string, string, string];
  hillFar: string;
  hillNear: string;
  fence: string;
  /** Distant canopy, lighter than the voxel maples so the painted layer reads as distance. */
  canopy: [string, string, string];
  /** Sun or moon, and whether it is a moon (stars come out). */
  orb: string;
  night: boolean;
}

/**
 * One palette per day phase. Day: the garden is the saturated thing and the room is muted.
 * Night: that inverts — the garden goes cool and dim, and the room's lamps become the warm
 * thing. This is the single rule that keeps 11pm as pretty as noon.
 */
export const SKY: Record<DayPhase, SkyPalette> = {
  dawn: {
    sky: ['#B9C6E8', '#D9C9E0', '#F2CBB8', '#F8DDC4'],
    hillFar: '#A9A2C4', hillNear: '#8E9AA8', fence: '#6B5645',
    canopy: ['#E27A55', '#EFA35A', '#F2C46A'], orb: '#FBE3B4', night: false,
  },
  morning: {
    sky: ['#8FC6EE', '#A9D2F0', '#C4DEF2', '#D8E6F2'],
    hillFar: '#B9C7A8', hillNear: '#9DB48E', fence: '#6B5645',
    canopy: ['#EE7E48', '#F5B45A', '#F5C96A'], orb: '#FFF4D6', night: false,
  },
  afternoon: {
    sky: ['#8FC6EE', '#A9CFEA', '#C4DAEC', '#D8E4EE'],
    hillFar: '#B9C7A8', hillNear: '#9DB48E', fence: '#6B5645',
    canopy: ['#EE7E48', '#F5B45A', '#D0604A'], orb: '#FFF7E0', night: false,
  },
  golden: {
    sky: ['#E8A66E', '#F3CBA8', '#F6D9B8', '#F8E3C6'],
    hillFar: '#C49C88', hillNear: '#A8846E', fence: '#5E4A3C',
    canopy: ['#F05A2A', '#F79A3C', '#F7C24A'], orb: '#FFE1A8', night: false,
  },
  dusk: {
    sky: ['#4E3F7A', '#8A5F8E', '#D07A88', '#E9A48C'],
    hillFar: '#5E5080', hillNear: '#4A4068', fence: '#3E3040',
    canopy: ['#8E4A5C', '#B36A58', '#C98A5A'], orb: '#F7D7A8', night: false,
  },
  night: {
    sky: ['#1B1A3A', '#22204A', '#2A2555', '#3A3468'],
    hillFar: '#3A3158', hillNear: '#2F2848', fence: '#2A2238',
    canopy: ['#3E3160', '#4C3E70', '#574A80'], orb: '#F6F1E2', night: true,
  },
};

/**
 * What the backdrop shows. 'garden' is the maples; 'city' and 'hills' exist so the shop's two
 * purchasable window views still mean something once the window is a doorway — they repaint
 * the far distance instead of hanging a plane in the opening.
 */
export type GardenView = 'garden' | 'city' | 'hills';

/* --------------------------------------------------------------- backdrop */

export interface Backdrop {
  mesh: THREE.Mesh;
  /** Repaint for a phase. Cheap enough to call on every phase change, not cheap enough for every frame. */
  setPhase(phase: DayPhase): void;
  /** Swap what the far distance shows. Repaints immediately. */
  setView(view: GardenView): void;
  dispose(): void;
}

/**
 * The painted far distance, as a quad.
 *
 * `w`/`h` are world units; the canvas is 64 texels per unit so a band is a band and not a blur.
 * `seed` shifts the canopy dither and the star field, so two backdrops that meet at a corner do
 * not repeat.
 */
export function createBackdrop(w: number, h: number, seed = 0): Backdrop {
  const pw = Math.round(w * 40);
  const ph = Math.round(h * 40);
  let current: DayPhase = 'afternoon';
  let view: GardenView = 'garden';
  const tex = canvasTexture(pw, ph, (ctx) => paintGarden(ctx, pw, ph, current, seed, view));
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  mesh.name = 'garden-backdrop';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    setPhase(phase) {
      if (phase === current) return;
      current = phase;
      redrawCanvasTexture(tex, (ctx) => paintGarden(ctx, pw, ph, current, seed, view));
    },
    setView(next) {
      if (next === view) return;
      view = next;
      redrawCanvasTexture(tex, (ctx) => paintGarden(ctx, pw, ph, current, seed, view));
    },
    dispose() {
      tex.dispose();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
  };
}

/** A tiny deterministic hash, so the dither and the stars are the same every time you walk in. */
function noise(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function paintGarden(ctx: CanvasRenderingContext2D, w: number, h: number, phase: DayPhase, seed = 0, view: GardenView = 'garden'): void {
  const p = SKY[phase];
  const horizon = Math.round(h * 0.56);

  // Sky in four flat bands. Flat, because a gradient would be the only smooth thing in the game.
  const bandH = horizon / 4;
  p.sky.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, Math.round(i * bandH), w, Math.ceil(bandH) + 1);
  });

  // Sun or moon, high and off-centre. Stars only at night.
  const orbR = Math.round(h * 0.045);
  const orbX = Math.round(w * 0.72);
  const orbY = Math.round(h * 0.16);
  ctx.fillStyle = p.orb;
  for (let y = -orbR; y <= orbR; y++) {
    const span = Math.round(Math.sqrt(Math.max(0, orbR * orbR - y * y)));
    ctx.fillRect(orbX - span, orbY + y, span * 2, 1);
  }
  if (p.night) {
    ctx.fillStyle = '#FBF2F4';
    for (let i = 0; i < 46; i++) {
      const sx = Math.floor(noise(i, 1, seed) * w);
      const sy = Math.floor(noise(i, 2, seed) * horizon * 0.85);
      ctx.fillRect(sx, sy, noise(i, 3, seed) > 0.7 ? 2 : 1, 1);
    }
  }

  // Two ranges of hills, the far one paler. Stepped, not curved.
  const hill = (colour: string, base: number, amp: number, step: number, phaseShift: number) => {
    ctx.fillStyle = colour;
    for (let x = 0; x < w; x += step) {
      const t = (x / w) * Math.PI * 2 + phaseShift;
      const top = Math.round(base - amp * (0.6 + 0.4 * Math.sin(t * 1.7) * Math.cos(t * 0.6)));
      ctx.fillRect(x, top, step, h - top);
    }
  };
  hill(p.hillFar, horizon - h * 0.02, h * 0.1, Math.max(2, Math.round(w / 48)), 0.4);
  hill(p.hillNear, horizon + h * 0.03, h * 0.07, Math.max(2, Math.round(w / 32)), 2.1);

  const canopyTop = Math.round(h * 0.42);
  const canopyBottom = Math.round(h * 0.82);
  const cell = Math.max(2, Math.round(w / 96));
  if (view === 'city') {
    // A skyline instead of trees: stepped towers with lit windows, in the hill colours so it
    // sits in the same distance as the hills it replaces.
    const towerW = Math.max(4, Math.round(w / 22));
    for (let x = 0; x < w; x += towerW + cell) {
      const th = Math.round((canopyBottom - canopyTop) * (0.45 + noise(x, 7, seed) * 0.55));
      const top = canopyBottom - th;
      ctx.fillStyle = p.hillNear;
      ctx.fillRect(x, top, towerW, th);
      ctx.fillStyle = p.night ? '#F5E1A4' : '#E8EDF2';
      for (let wy = top + cell; wy < canopyBottom - cell; wy += cell * 2) {
        for (let wx = x + cell; wx < x + towerW - cell; wx += cell * 2) {
          if (noise(wx, wy, seed) > (p.night ? 0.45 : 0.75)) ctx.fillRect(wx, wy, cell, cell);
        }
      }
    }
  } else if (view === 'garden') {
    // A wall of distant canopy across the whole width — the reference's maples filling the
    // opening edge to edge. Dithered in three tones so it reads as foliage rather than a stripe.
    for (let y = canopyTop; y < canopyBottom; y += cell) {
      for (let x = 0; x < w; x += cell) {
        // A soft top edge: fewer cells fill near the top, so the silhouette lumps like a treeline.
        const edge = (y - canopyTop) / (canopyBottom - canopyTop);
        const r = noise(x, y, seed);
        if (edge < 0.18 && r > edge * 4 + 0.15) continue;
        const tone = r < 0.34 ? 0 : r < 0.7 ? 1 : 2;
        ctx.fillStyle = p.canopy[tone];
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
  // 'hills' leaves the two hill ranges as the whole view.

  // Fence along the bottom, with paler lattice ticks.
  const fenceTop = Math.round(h * 0.82);
  ctx.fillStyle = p.fence;
  ctx.fillRect(0, fenceTop, w, h - fenceTop);
  ctx.fillStyle = p.night ? '#3A3050' : '#8A7460';
  const tick = Math.max(2, Math.round(w / 64));
  for (let x = tick; x < w; x += tick * 2) ctx.fillRect(x, fenceTop + 2, 1, h - fenceTop - 4);
}

/* ------------------------------------------------------------------ voxels */

/** A maple: a trunk and a stepped canopy in three colours. Colours merge across every maple. */
export function addMaple(batch: BoxBatch, x: number, z: number, scale = 1): void {
  const s = scale;
  batch.add({ w: 0.3 * s, h: 1.6 * s, d: 0.3 * s, x, y: 0.8 * s, z }, hex(MAPLE.trunk));
  batch.add({ w: 0.9 * s, h: 0.22 * s, d: 0.22 * s, x: x + 0.4 * s, y: 1.5 * s, z, ry: 0.4, rz: 0.5 }, hex(MAPLE.trunk));
  // A canopy is a CLOUD of blocks, not a slab. Eleven of them in three colours, stepped in and
  // up, with the reds low and the golds catching the top — the first version was four flat
  // boxes and read as a painted sign.
  const cloud: Array<[number, number, number, number, number, number, string]> = [
    // w, h, d, dx, dy, dz, colour
    [1.3, 0.7, 1.1, -0.55, 1.95, 0.1, MAPLE.red],
    [1.2, 0.7, 1.0, 0.6, 2.0, -0.2, MAPLE.orange],
    [1.0, 0.6, 1.0, 0.1, 1.75, 0.55, MAPLE.red],
    [1.5, 0.75, 1.2, 0.0, 2.55, 0.0, MAPLE.orange],
    [1.0, 0.6, 0.9, -0.75, 2.6, -0.35, MAPLE.gold],
    [0.95, 0.6, 0.85, 0.8, 2.7, 0.35, MAPLE.gold],
    [1.1, 0.65, 0.9, 0.05, 3.15, 0.15, MAPLE.orange],
    [0.8, 0.5, 0.7, -0.45, 3.25, 0.3, MAPLE.gold],
    [0.7, 0.5, 0.6, 0.5, 3.4, -0.3, MAPLE.gold],
    [0.55, 0.45, 0.5, -0.05, 3.7, -0.05, MAPLE.gold],
    [0.6, 0.4, 0.5, 0.9, 1.55, 0.7, MAPLE.red],
  ];
  for (const [w, h, d, dx, dy, dz, colour] of cloud) {
    batch.add({ w: w * s, h: h * s, d: d * s, x: x + dx * s, y: dy * s, z: z + dz * s }, hex(colour));
  }
}

/** A stone lantern. Returns where its flame sits, for the caller's flat cube and light. */
export function addLantern(batch: BoxBatch, x: number, z: number): { x: number; y: number; z: number } {
  batch.add({ w: 0.7, h: 0.16, d: 0.7, x, y: 0.08, z }, hex(STONE));
  batch.add({ w: 0.26, h: 0.7, d: 0.26, x, y: 0.51, z }, hex(STONE));
  batch.add({ w: 0.56, h: 0.12, d: 0.56, x, y: 0.92, z }, hex(STONE));
  // The hollow the flame sits in: four posts, so the glow shows through the gaps.
  for (const [ox, oz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
    batch.add({ w: 0.08, h: 0.4, d: 0.08, x: x + ox, y: 1.18, z: z + oz }, hex(STONE));
  }
  batch.add({ w: 0.7, h: 0.14, d: 0.7, x, y: 1.45, z }, hex(STONE));
  batch.add({ w: 0.36, h: 0.16, d: 0.36, x, y: 1.6, z }, hex(STONE));
  return { x, y: 1.18, z };
}

/** The flame and its light. Unlit so it reads as the thing that glows. */
export function createLanternGlow(at: { x: number; y: number; z: number }): { flame: THREE.Mesh; light: THREE.PointLight } {
  const flame = new THREE.Mesh(boxGeo(0.2, 0.22, 0.2), flat(hex('#FFC98A')));
  flame.position.set(at.x, at.y, at.z);
  flame.castShadow = false;
  const light = new THREE.PointLight(hex('#FFB870'), 0, 5, 2);
  light.position.set(at.x, at.y + 0.1, at.z);
  // Never a shadow caster: a point-light shadow is six extra renders, for a lantern.
  light.castShadow = false;
  return { flame, light };
}

/** Stepping stones from the threshold out into the garden. */
export function addSteppingStones(batch: BoxBatch, from: { x: number; z: number }, to: { x: number; z: number }, count = 4): void {
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const x = from.x + (to.x - from.x) * t + (i % 2 === 0 ? 0.12 : -0.12);
    const z = from.z + (to.z - from.z) * t;
    batch.add({ w: 0.44, h: 0.06, d: 0.36, x, y: 0.03, z, ry: (i % 3) * 0.3 - 0.3 }, hex(STONE));
  }
}
