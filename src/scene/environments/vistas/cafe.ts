/**
 * THE SHOPFRONT — what the rainy café looks out on.
 *
 * The café was a wood box with a tinted rectangle on the far wall labelled "city". This turns that
 * wall into a plate window: ink mullions and a transom, a striped awning outside, and beyond the
 * glass a wet street — dark asphalt, flat puddles that reflect the sky, a kerb, a lamppost that
 * comes on at dusk, a bicycle on the pavement, a planter — closed by an L-shaped painted backdrop
 * of muted shopfronts whose windows go butter after dark. Rain runs down the glass.
 *
 * The rule it obeys is the garden's (DESIGN.md §13): the opening is cut in the shell wall at zero
 * draw-call cost, and EVERYTHING you can see through it is built or painted — never sky. The
 * backdrop is an L for the same reason the cozy room's is: at azimuth 270 the eye looks through
 * the window almost along the wall, and a flat back plane alone leaks past its left edge.
 *
 * ENCLOSURE ARITHMETIC (eye anywhere in x ≤ 14, z ≤ 13.5, y 2..13; opening x 0.5..5.5, y 0.45..3.5):
 *   - Steepest ray, eye (14, ·, 0.2) through the left jamb (0.5, ·, -3.76): dx/dz = 3.4, crosses
 *     x = -0.6 at z ≈ -4.1 → the RETURN at x -0.6 must start at the wall. It starts at z -3.88 (mid-slab),
 *     inside the wall, and runs to z -7.0 where it meets the back plane.
 *   - Same eye through the right jamb (5.5): reaches x -0.6 at z -6.6 → still on the return.
 *   - Widest ray to the right: an azimuth-180 eye close in and low (x -0.5, z 3) through the
 *     right jamb reaches x 8.3 at z -7.0 → the back plane and slab run to x 9.0.
 *   - Highest ray: a low eye through the top-right corner (5.5, 3.5) reaches y 5.33 on the back
 *     plane → both planes are 6.0 tall, and the awning sits over the head anyway.
 *   - Lowest rays hit the asphalt slab, which is proud of the shadow patch at y 0..0.12 and
 *     spans the whole box x -0.6..9.0, z -7.1..-4.0; the planes reach down to y 0.
 *   Verified by sampling 5.3M rays from the rig's whole reach (azimuth 178..272, elevation
 *   9..45, any distance, both mood targets): zero misses with these extents.
 *
 * DRAW-CALL ARITHMETIC (café is 87 with five cats; budget 300 with eight):
 *   +1  ink: window frame, mullions, transom, lamppost, bicycle — one merged mesh, castShadow off
 *    0  wood / woodDark / paper: sill, bistro table, chairs, cups, planter box, awning paper
 *       stripes — pushed into the world's own batch, colours it already has
 *   +1  pinkDeep: awning stripes + valance + planter blossoms (one merged mesh)
 *   +1  pavement slab       +1 asphalt slab       +1 pale kerb lip + road dashes
 *   +1  puddles (one flat mesh on a cloned material, tinted per phase)
 *   +1  leafDark shrubs in the planter
 *   +1  lamp head + festoon bulbs (one mesh; material swapped toon→flat at dusk, no extra call)
 *   +1  the glass: one transparent quad carrying the tint and the scrolling rain streaks
 *   +2  backdrop: back plane + return
 *    0  the street lamp's PointLight (no shadow → no extra passes)
 *   = 11 new calls → ~98 with five cats, ~137 with eight.
 *
 * SHADOWS: the street is under a rain sky, so nothing out there gets a hard shadow — every mesh
 * this file creates has castShadow=false, and only the frame (which is inside the room) receives.
 * Batch boxes ride the world's existing shadow pass like the cozy room's maples do; the slabs
 * they stand on do not receive, so those shadows land on nothing.
 *
 * WHAT THE ORCHESTRATOR MUST DO IN buildCafe / buildEnvironment (this file cannot edit index.ts):
 *   1. Remove the old window prop: `createWindow('city')` placed at (2.4, 0, shell.minZ + 0.26).
 *      Return `windowProp: null` for the café; setView on the backdrops replaces it.
 *   2. Split the full-width wall bar (`batch.add({ w: maxX - minX, h: 0.3, d: 0.32, x: mid,
 *      y: 1.0, z: minZ + 0.18 }, C.wood)`) into two: x [minX, CAFE_WINDOW.from - 0.08] and
 *      x [CAFE_WINDOW.to + 0.08, maxX]. Otherwise it runs across the glass at y 0.85..1.15.
 *   3. Pass `result.openings` to buildShellWalls for id === 'cafe'.
 *   4. Merge `result.obstacles` into the café's obstacle list; add `result.backdrops` and
 *      `result.nightLights` to the env's arrays so setPhase / intensity / setView are driven;
 *      call `result.update` from the env's update.
 */

import * as THREE from 'three';
import type { DayPhase } from '../../../core/time';
import type { EnvironmentDef } from '../../../data/environments';
import { C, hex, mixHex, PALETTE } from '../../../data/palette';
import type { Obstacle } from '../../cats/catBrain';
import { MAPLE, type Backdrop, type GardenView } from '../../props/garden';
import { BoxBatch, canvasTexture, flat, mat, mergedBoxes, redrawCanvasTexture, type BoxSpec } from '../../voxel';
import type { WallOpening } from '../index';

export interface VistaContext {
  batch: BoxBatch;
  group: THREE.Group;
  def: EnvironmentDef;
}

export interface VistaResult {
  backdrops: Backdrop[];
  nightLights: THREE.PointLight[];
  obstacles: Obstacle[];
  /** Holes for buildShellWalls to cut. The café's plate window lives here. */
  openings?: WallOpening[];
  update?(dt: number, elapsed: number, phase: DayPhase, reducedMotion: boolean): void;
}

/* ---------------------------------------------------------------- geometry */

/**
 * The plate window. Spans SLOT_ANCHORS.window (x 2.0) so a purchased window view still points at
 * the far distance it repaints, starts right of the wall-b print slot (x -0.66..0.26), and stops
 * short of the pendant lamp's cord. The sill is low — 0.45 — so the default pose (elevation 28°)
 * sees road, not just façades: a sill at bar height would have hidden every puddle.
 */
export const CAFE_WINDOW: WallOpening = { wall: 'z', from: 0.5, to: 5.5, y0: 0.45, y1: 3.5 };

/** Street colours. Violet-greys, so the wet street belongs to the same evening as the café. */
const ASPHALT = '#4A4560';
const PAVEMENT = '#6A6488';
const KERB = '#9A94B4';
const INK = PALETTE.ink;
const LAMP_GLASS = '#FFF4D6';

/* ---------------------------------------------------------------- palette */

interface StreetPalette {
  sky: [string, string, string, string];
  /** Five façade colours across the road; the return leg reuses them with a different seed. */
  facades: [string, string, string, string, string];
  /** Window glass when unlit. */
  glass: string;
  /** Lit window fill; `lit` is the fraction of windows that are on. */
  lamp: string;
  lit: number;
  /** The far pavement band at the foot of the façades. */
  kerb: string;
  /** Rain dashes over the whole painting. */
  rain: string;
  /** What the puddles reflect. */
  puddle: string;
  night: boolean;
}

const DAY_FACADES: [string, string, string, string, string] = ['#6B5D8C', '#4E6466', '#8C6B7A', '#5A6A8E', '#7A5E6A'];
const darken = (t: number): [string, string, string, string, string] =>
  DAY_FACADES.map((c) => mixHex(c, '#1E1A34', t)) as [string, string, string, string, string];

/**
 * One palette per phase. The café's rule is the garden's, inverted for weather: by day the street
 * is a cool grey wash and the room's wood is the warm thing; at dusk the shop windows across the
 * road come on one by one, and by night the street is the warm thing and the room is lamplit.
 */
const STREET: Record<DayPhase, StreetPalette> = {
  dawn: {
    sky: ['#8E93B4', '#9FA6BE', '#B3B4C8', '#C4BEC8'], facades: darken(0.12), glass: '#B9B5CC',
    lamp: '#F5E1A4', lit: 0.25, kerb: '#8A84A6', rain: '#D5D0E6', puddle: '#9EA2BE', night: false,
  },
  morning: {
    sky: ['#9AA2BE', '#A9B0C6', '#B8BDCF', '#C6C8D4'], facades: DAY_FACADES, glass: '#C7C3D8',
    lamp: '#F5E1A4', lit: 0.0, kerb: '#8A84A6', rain: '#DCD8EA', puddle: '#AEB2C8', night: false,
  },
  afternoon: {
    sky: ['#9FA6C2', '#AEB4CA', '#BCC1D2', '#C9CBD6'], facades: DAY_FACADES, glass: '#C7C3D8',
    lamp: '#F5E1A4', lit: 0.0, kerb: '#8A84A6', rain: '#DCD8EA', puddle: '#B2B6CA', night: false,
  },
  golden: {
    sky: ['#A98FA8', '#B9A9BE', '#CDB6BE', '#D8C1BE'], facades: darken(0.08), glass: '#C4B4C4',
    lamp: '#E8C9AE', lit: 0.3, kerb: '#8A84A6', rain: '#E4D6E0', puddle: '#C0AEBC', night: false,
  },
  dusk: {
    sky: ['#5E5680', '#8C87A8', '#A899B4', '#B8A3B0'], facades: darken(0.4), glass: '#6E6890',
    lamp: '#F5E1A4', lit: 0.7, kerb: '#6A6488', rain: '#B8B0CC', puddle: '#8A7E9E', night: false,
  },
  night: {
    sky: ['#1F1D36', '#2E2B48', '#363352', '#3E3A5C'], facades: darken(0.6), glass: '#3A3658',
    lamp: '#F5E1A4', lit: 0.6, kerb: '#4A4560', rain: '#8E86AA', puddle: '#5A5070', night: true,
  },
};

/** The garden's hash, so the lit windows are the same ones every night. */
function noise(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/* ---------------------------------------------------------------- painting */

/**
 * A row of shopfronts, seen across a wet road. Stepped, flat-filled, no gradients.
 *
 * 'city' (the café's default) is the façades. 'garden' — the shop's other view — keeps the
 * façades and plants a row of maples along the far kerb, so the purchased view still changes
 * the picture. 'hills' swaps the buildings for a park railing and two hill ranges.
 */
export function paintStreet(ctx: CanvasRenderingContext2D, w: number, h: number, phase: DayPhase, seed: number, view: GardenView): void {
  const p = STREET[phase];

  // Sky: four flat bands down to the tallest roofline.
  const skyBottom = Math.round(h * 0.5);
  const bandH = skyBottom / 4;
  p.sky.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, Math.round(i * bandH), w, Math.ceil(bandH) + 1);
  });
  // The sky continues behind the buildings: fill the lower half with the horizon band.
  ctx.fillStyle = p.sky[3];
  ctx.fillRect(0, skyBottom, w, h - skyBottom);

  const kerbTop = Math.round(h * 0.93);

  if (view === 'hills') {
    paintPark(ctx, w, h, p, seed, kerbTop);
  } else {
    paintFacades(ctx, w, h, p, seed, kerbTop);
    if (view === 'garden') paintMaples(ctx, w, h, seed, kerbTop);
  }

  // The far pavement, at the foot of everything.
  ctx.fillStyle = p.kerb;
  ctx.fillRect(0, kerbTop, w, h - kerbTop);
  ctx.fillStyle = mixHex(p.kerb, '#FFFFFF', 0.18);
  ctx.fillRect(0, kerbTop, w, 2);

  // Rain, in every phase: it is the rainy café. Short pale dashes on a fixed grid, jittered by the
  // hash so they never line up into a texture. Alpha rather than a paler colour, so the same
  // dashes read over sky, brick and glass.
  ctx.fillStyle = p.rain;
  ctx.globalAlpha = 0.28;
  const cellW = Math.max(6, Math.round(w / 40));
  const cellH = Math.max(8, Math.round(h / 20));
  for (let gy = 0; gy < h; gy += cellH) {
    for (let gx = 0; gx < w; gx += cellW) {
      const r = noise(gx, gy, seed + 7);
      if (r < 0.55) continue;
      const x = gx + Math.floor(noise(gx, gy, seed + 8) * cellW);
      const y = gy + Math.floor(noise(gx, gy, seed + 9) * cellH);
      ctx.fillRect(x, y, 1, 3);
    }
  }
  ctx.globalAlpha = 1;
}

function paintFacades(ctx: CanvasRenderingContext2D, w: number, h: number, p: StreetPalette, seed: number, kerbTop: number): void {
  // Building widths from the hash, walked left to right until the canvas is full.
  let x = 0;
  let i = 0;
  while (x < w) {
    const bw = Math.round(w * (0.14 + noise(i, 40, seed) * 0.12));
    const top = Math.round(h * (0.16 + noise(i, 41, seed) * 0.22));
    const colour = p.facades[(i + seed) % p.facades.length];
    ctx.fillStyle = colour;
    ctx.fillRect(x, top, bw, kerbTop - top);
    // Parapet and a darker party-wall line, so adjoining buildings separate.
    ctx.fillStyle = mixHex(colour, '#FFFFFF', 0.15);
    ctx.fillRect(x, top, bw, 2);
    ctx.fillStyle = mixHex(colour, '#1E1A34', 0.35);
    ctx.fillRect(x + bw - 1, top, 1, kerbTop - top);

    // Upper floors: a grid of windows, each lit or not by the hash against the phase's fraction.
    const cell = Math.max(4, Math.round(w / 64));
    const winW = cell * 2;
    const winH = cell * 3;
    const shopTop = kerbTop - Math.round(h * 0.2);
    for (let wy = top + cell * 2; wy + winH < shopTop - cell; wy += winH + cell * 2) {
      for (let wx = x + cell; wx + winW < x + bw - cell; wx += winW + cell) {
        const lit = noise(wx, wy, seed) < p.lit;
        ctx.fillStyle = lit ? (noise(wx, wy, seed + 1) > 0.5 ? p.lamp : PALETTE.peach) : p.glass;
        ctx.fillRect(wx, wy, winW, winH);
        // A dark mullion cross, so a lit window is a window and not a butter square.
        ctx.fillStyle = mixHex(colour, '#1E1A34', 0.4);
        ctx.fillRect(wx + Math.floor(winW / 2), wy, 1, winH);
        ctx.fillRect(wx, wy + Math.floor(winH / 2), winW, 1);
      }
    }

    // Ground floor: a signboard band, then a wide shop window, then a door.
    const sign = [PALETTE.pinkDeep, PALETTE.mint, PALETTE.peach, PALETTE.lavDusk, PALETTE.danger][(i + seed * 3) % 5];
    ctx.fillStyle = p.night ? mixHex(sign, '#1E1A34', 0.45) : sign;
    ctx.fillRect(x + 1, shopTop, bw - 2, cell);
    const glassTop = shopTop + cell + 2;
    const glassH = kerbTop - glassTop - cell;
    const doorW = cell * 2;
    const shopLit = noise(i, 42, seed) < Math.max(p.lit, p.night ? 0.8 : 0);
    ctx.fillStyle = shopLit ? p.lamp : p.glass;
    ctx.fillRect(x + cell, glassTop, bw - cell * 2 - doorW - 2, glassH);
    ctx.fillStyle = mixHex(colour, '#1E1A34', 0.5);
    ctx.fillRect(x + bw - cell - doorW, glassTop, doorW, glassH + cell);
    // A stripe of awning over every other shop.
    if (noise(i, 43, seed) > 0.5) {
      const stripes = [PALETTE.paper, sign];
      for (let sx = x + 1, k = 0; sx < x + bw - 1; sx += cell, k++) {
        ctx.fillStyle = p.night ? mixHex(stripes[k % 2], '#1E1A34', 0.5) : stripes[k % 2];
        ctx.fillRect(sx, shopTop - 2, Math.min(cell, x + bw - 1 - sx), 3);
      }
    }
    // One neon sign on the street, only at night, in a pink pale enough to bloom (luma ≈ 0.85).
    if (p.night && i === 1) {
      ctx.fillStyle = '#FFC4D6';
      ctx.font = `bold ${cell * 2}px monospace`;
      ctx.textBaseline = 'top';
      ctx.fillText('OPEN', x + cell, glassTop + 2);
    }

    x += bw;
    i++;
  }
}

/** Painted maples along the far kerb, in the garden's own three canopy tones. */
function paintMaples(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, kerbTop: number): void {
  const cell = Math.max(3, Math.round(w / 80));
  const count = Math.max(2, Math.round(w / 90));
  for (let i = 0; i < count; i++) {
    const cx = Math.round(((i + 0.5) / count) * w + (noise(i, 50, seed) - 0.5) * cell * 6);
    const trunkH = Math.round(h * 0.16);
    ctx.fillStyle = MAPLE.trunk;
    ctx.fillRect(cx - 1, kerbTop - trunkH, 3, trunkH);
    const r = cell * 4;
    const top = kerbTop - trunkH - r;
    for (let y = top - r; y < top + r; y += cell) {
      for (let x = cx - r; x < cx + r; x += cell) {
        const d = Math.hypot(x - cx, y - top) / r;
        const n = noise(x, y, seed + i);
        if (d > 1 || (d > 0.7 && n < 0.45)) continue;
        ctx.fillStyle = [MAPLE.red, MAPLE.orange, MAPLE.gold][n < 0.4 ? 0 : n < 0.75 ? 1 : 2];
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
}

/** A park across the road: two stepped hill ranges behind an iron railing. */
function paintPark(ctx: CanvasRenderingContext2D, w: number, h: number, p: StreetPalette, seed: number, kerbTop: number): void {
  const hill = (colour: string, base: number, amp: number, step: number, shift: number) => {
    ctx.fillStyle = colour;
    for (let x = 0; x < w; x += step) {
      const t = (x / w) * Math.PI * 2 + shift;
      const top = Math.round(base - amp * (0.6 + 0.4 * Math.sin(t * 1.7 + seed) * Math.cos(t * 0.6)));
      ctx.fillRect(x, top, step, kerbTop - top);
    }
  };
  const far = p.night ? '#3A3158' : mixHex(PALETTE.leafDark, p.sky[3], 0.45);
  const near = p.night ? '#2F2848' : mixHex(PALETTE.leaf, p.sky[3], 0.2);
  hill(far, h * 0.52, h * 0.12, Math.max(2, Math.round(w / 48)), 0.4);
  hill(near, h * 0.64, h * 0.08, Math.max(2, Math.round(w / 32)), 2.1);
  // Railing: a rail and evenly spaced uprights, in ink.
  const railTop = kerbTop - Math.round(h * 0.12);
  ctx.fillStyle = INK;
  ctx.fillRect(0, railTop, w, 2);
  const gap = Math.max(4, Math.round(w / 56));
  for (let x = 2; x < w; x += gap) ctx.fillRect(x, railTop, 1, kerbTop - railTop);
}

/* ---------------------------------------------------------------- backdrop */

/**
 * A painted street on a quad, repainted on phase change only. Same contract as the garden's
 * createBackdrop, so the orchestrator drives it identically; only the painter differs.
 */
export function createStreetBackdrop(w: number, h: number, seed = 0): Backdrop {
  const pw = Math.round(w * 40);
  const ph = Math.round(h * 40);
  let current: DayPhase = 'afternoon';
  // The café's old window prop was 'city', and that is what a street is.
  let view: GardenView = 'city';
  const tex = canvasTexture(pw, ph, (ctx) => paintStreet(ctx, pw, ph, current, seed, view));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
  mesh.name = 'street-backdrop';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    setPhase(phase) {
      if (phase === current) return;
      current = phase;
      redrawCanvasTexture(tex, (ctx) => paintStreet(ctx, pw, ph, current, seed, view));
    },
    setView(next) {
      if (next === view) return;
      view = next;
      redrawCanvasTexture(tex, (ctx) => paintStreet(ctx, pw, ph, current, seed, view));
    },
    dispose() {
      tex.dispose();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
  };
}

/* ---------------------------------------------------------------- the glass */

/**
 * Rain on the window. A 64×256 canvas of drips — a faint glass tint everywhere, pale streaks with
 * a bead at the foot — on one transparent quad, scrolled by texture offset. No repaint, ever: the
 * whole sheet slides and the eye reads it as water running. depthWrite is off so the outline pass
 * sees the street behind the glass rather than a flat rectangle.
 */
function createRainGlass(w: number, h: number): { mesh: THREE.Mesh; tex: THREE.CanvasTexture } {
  const cw = 64;
  const ch = 256;
  const tex = canvasTexture(cw, ch, (ctx) => {
    ctx.fillStyle = 'rgba(199, 215, 234, 0.10)';
    ctx.fillRect(0, 0, cw, ch);
    for (let i = 0; i < 14; i++) {
      const x = Math.floor(noise(i, 60, 3) * cw);
      const y = Math.floor(noise(i, 61, 3) * ch);
      const len = 14 + Math.floor(noise(i, 62, 3) * 60);
      const wide = noise(i, 63, 3) > 0.7 ? 2 : 1;
      ctx.fillStyle = 'rgba(230, 238, 248, 0.42)';
      // Drawn twice, offset by the canvas height, so a drip that runs off the bottom wraps.
      ctx.fillRect(x, y, wide, len);
      ctx.fillRect(x, y - ch, wide, len);
      ctx.fillStyle = 'rgba(240, 246, 255, 0.7)';
      ctx.fillRect(x - (wide === 2 ? 0 : 1), y + len - 2, wide + 1, 2);
      ctx.fillRect(x - (wide === 2 ? 0 : 1), y + len - 2 - ch, wide + 1, 2);
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.name = 'cafe-glass';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, tex };
}

/* ---------------------------------------------------------------- the vista */

export function addCafeVista(ctx: VistaContext): VistaResult {
  const { batch, group, def } = ctx;
  const shell = def.shell;
  const face = shell.minZ + 0.24; // the far wall's inner face
  const outer = shell.minZ; // its outer face
  const { from: X0, to: X1, y0: Y0, y1: Y1 } = CAFE_WINDOW;
  const midX = (X0 + X1) / 2;

  /* ------------------------------------------------------- the window */
  // A wooden sill, deeper than the wall so it makes a ledge on both sides. Wood is in the batch.
  batch.add({ w: X1 - X0 + 0.3, h: 0.12, d: 0.5, x: midX, y: Y0, z: outer + 0.14 }, C.wood);
  // A cup and a potted herb left on the ledge, the way a window ledge in a café collects things.
  batch.add({ w: 0.18, h: 0.2, d: 0.18, x: X1 - 0.5, y: Y0 + 0.16, z: face - 0.02 }, hex(PALETTE.paper));
  batch.add({ w: 0.22, h: 0.18, d: 0.22, x: X0 + 0.45, y: Y0 + 0.15, z: face - 0.02 }, C.woodDark);

  // Ink frame, mullions and a transom: a shopfront's steel, not the room's paper. One merged
  // mesh with the street's ink pieces below; castShadow off — slivers of mullion shadow across
  // the tiles would only add noise, and the frame is thin enough that nothing is lost.
  const glassZ = outer + 0.12; // mid-wall
  const ink: BoxSpec[] = [
    { w: 0.12, h: Y1 - Y0, d: 0.16, x: X0 + 0.06, y: (Y0 + Y1) / 2, z: glassZ },
    { w: 0.12, h: Y1 - Y0, d: 0.16, x: X1 - 0.06, y: (Y0 + Y1) / 2, z: glassZ },
    { w: X1 - X0, h: 0.12, d: 0.16, x: midX, y: Y1 - 0.06, z: glassZ },
    { w: X1 - X0, h: 0.1, d: 0.16, x: midX, y: Y0 + 0.11, z: glassZ },
    // Two mullions, so the centre pane is the wide one the desk looks past.
    { w: 0.1, h: Y1 - Y0, d: 0.16, x: 1.9, y: (Y0 + Y1) / 2, z: glassZ },
    { w: 0.1, h: Y1 - Y0, d: 0.16, x: 4.1, y: (Y0 + Y1) / 2, z: glassZ },
    // Transom.
    { w: X1 - X0, h: 0.1, d: 0.16, x: midX, y: 2.7, z: glassZ },
  ];

  // The glass, exactly in the plane of the mullions so their boxes hide the quad's edges.
  const glass = createRainGlass(X1 - X0, Y1 - Y0);
  glass.mesh.position.set(midX, (Y0 + Y1) / 2, glassZ);
  group.add(glass.mesh);

  /* ------------------------------------------------------- the awning */
  // Outside, over the head: a striped canopy sloping down away from the wall, and a short
  // valance along its front edge. Paper stripes go into the batch (0 calls); pinkDeep is new,
  // so those stripes merge into one castShadow=false mesh with the planter's blossoms below.
  const pinkSpecs: BoxSpec[] = [];
  const paperSpecs: BoxSpec[] = [];
  const awningY = Y1 + 0.28;
  const awningDepth = 1.1;
  const tilt = -0.28; // negative rx drops the far (−z) end: 0.32 over 1.1
  for (let i = 0; i < 11; i++) {
    const sx = X0 - 0.2 + 0.25 + i * 0.5;
    const canopy: BoxSpec = { w: 0.5, h: 0.06, d: awningDepth, x: sx, y: awningY, z: outer - awningDepth / 2 - 0.02, rx: tilt };
    const valance: BoxSpec = { w: 0.5, h: 0.26, d: 0.05, x: sx, y: awningY - 0.16 - 0.1, z: outer - awningDepth - 0.04 };
    (i % 2 === 0 ? pinkSpecs : paperSpecs).push(canopy, valance);
  }
  batch.addMany(paperSpecs, hex(PALETTE.paper));
  // The rail the awning hangs from.
  ink.push({ w: X1 - X0 + 0.4, h: 0.06, d: 0.06, x: midX, y: awningY + 0.02, z: outer - 0.05 });

  /* ------------------------------------------------------- the street */
  // Box the street sits in: x -0.6..9.0, z -7.1..-4.0. Everything is proud of the shadow patch
  // at y ≤ 0.003 so no café floorboard ever shows through the window.
  const sx0 = -0.6;
  const sx1 = 9.0;
  const streetW = sx1 - sx0;
  const streetMid = (sx0 + sx1) / 2;
  const kerbZ = outer - 1.2; // pavement is 1.2 deep, then the kerb, then the road
  const backZ = outer - 3.0; // the back plane
  const pavement = mergedBoxes([{ w: streetW, h: 0.16, d: outer - kerbZ, x: streetMid, y: 0.08, z: (outer + kerbZ) / 2 }], hex(PAVEMENT));
  const asphalt = mergedBoxes([{ w: streetW, h: 0.12, d: kerbZ - (backZ - 0.1), x: streetMid, y: 0.06, z: (kerbZ + backZ - 0.1) / 2 }], hex(ASPHALT));
  // The kerb lip and a dashed centre line share the one pale colour.
  const paleSpecs: BoxSpec[] = [{ w: streetW, h: 0.06, d: 0.14, x: streetMid, y: 0.17, z: kerbZ + 0.07 }];
  for (let x = sx0 + 0.5; x < sx1 - 0.4; x += 1.2) paleSpecs.push({ w: 0.6, h: 0.015, d: 0.1, x, y: 0.125, z: backZ + 0.9 });
  const pale = mergedBoxes(paleSpecs, hex(KERB));
  for (const m of [pavement, asphalt, pale]) {
    if (!m) continue;
    // Under a rain sky nothing gets a hard shadow — and the slabs run to the edge of the shadow
    // camera's box, where the sampler's clamp band would paint across them if they received.
    m.castShadow = false;
    m.receiveShadow = false;
    group.add(m);
  }

  // Puddles: flat quads on a cloned unlit material, so they can be the colour of the sky they
  // reflect — grey by day, warm at night when the shop windows are what is in them. Mostly on
  // the road: from the default pose the near pavement hides below the sill.
  const puddleMat = new THREE.MeshBasicMaterial({ color: hex(STREET.afternoon.puddle) });
  const puddles = mergedBoxes(
    [
      // Road puddles ride 0.14, just above the centre-line dashes (top 0.1325), so nothing fights.
      { w: 1.5, h: 0.012, d: 0.6, x: 1.6, y: 0.14, z: backZ + 1.3, ry: 0.2 },
      { w: 1.0, h: 0.012, d: 0.45, x: 4.2, y: 0.14, z: backZ + 0.6, ry: -0.3 },
      { w: 0.8, h: 0.012, d: 0.5, x: -0.1, y: 0.14, z: backZ + 0.5, ry: 0.4 },
      { w: 1.9, h: 0.012, d: 0.5, x: 6.2, y: 0.14, z: backZ + 1.1, ry: 0.1 },
      { w: 0.7, h: 0.012, d: 0.34, x: 2.9, y: 0.166, z: outer - 0.7, ry: -0.2 },
    ],
    hex(STREET.afternoon.puddle),
  )!;
  puddles.material = puddleMat;
  puddles.castShadow = false;
  puddles.receiveShadow = false;
  puddles.name = 'puddles';
  group.add(puddles);

  // A lamppost on the pavement edge, where the default pose sees it through the top pane. Post
  // and arm in ink (merged with the frame), a pale glass head that is a toon box by day and an
  // unlit one from dusk — the same mesh, its material swapped — with the night light inside.
  const lampX = 4.3;
  const lampZ = kerbZ + 0.35;
  const headY = 3.05;
  ink.push(
    { w: 0.14, h: headY - 0.2, d: 0.14, x: lampX, y: (headY - 0.2) / 2 + 0.16, z: lampZ },
    { w: 0.4, h: 0.1, d: 0.4, x: lampX, y: 0.21, z: lampZ },
    { w: 0.08, h: 0.08, d: 0.5, x: lampX, y: headY - 0.14, z: lampZ - 0.2 },
    { w: 0.4, h: 0.05, d: 0.4, x: lampX, y: headY + 0.18, z: lampZ - 0.4 },
  );
  const headAt = { x: lampX, y: headY, z: lampZ - 0.4 };
  // Festoon bulbs under the awning's valance share the head's colour and mesh — one call.
  const glowSpecs: BoxSpec[] = [{ w: 0.28, h: 0.3, d: 0.28, x: headAt.x, y: headAt.y, z: headAt.z }];
  for (let i = 0; i < 5; i++) glowSpecs.push({ w: 0.12, h: 0.12, d: 0.12, x: X0 + 0.5 + i * 1.0, y: awningY - 0.5, z: outer - awningDepth - 0.02 });
  const glow = mergedBoxes(glowSpecs, hex(LAMP_GLASS))!;
  glow.castShadow = false;
  glow.receiveShadow = false;
  glow.name = 'street-glow';
  group.add(glow);
  const lampLight = new THREE.PointLight(hex('#FFC98A'), 0, 7, 2);
  lampLight.position.set(headAt.x, headAt.y - 0.1, headAt.z);
  // Never a shadow caster: a point-light shadow is six extra renders, for a street lamp.
  lampLight.castShadow = false;
  group.add(lampLight);

  // A planter by the right jamb: a woodDark box (batch), leafDark shrubs, a few pink blossoms.
  const planterX = 5.6;
  const planterZ = outer - 0.55;
  batch.add({ w: 0.8, h: 0.5, d: 0.5, x: planterX, y: 0.41, z: planterZ }, C.woodDark);
  const shrubs = mergedBoxes(
    [
      { w: 0.5, h: 0.4, d: 0.4, x: planterX - 0.15, y: 0.85, z: planterZ },
      { w: 0.4, h: 0.32, d: 0.34, x: planterX + 0.2, y: 0.8, z: planterZ + 0.04 },
      { w: 0.28, h: 0.26, d: 0.26, x: planterX, y: 1.1, z: planterZ - 0.06 },
    ],
    hex(PALETTE.leafDark),
  )!;
  shrubs.castShadow = false;
  shrubs.receiveShadow = false;
  group.add(shrubs);
  pinkSpecs.push(
    { w: 0.1, h: 0.1, d: 0.1, x: planterX - 0.28, y: 1.06, z: planterZ + 0.1 },
    { w: 0.1, h: 0.1, d: 0.1, x: planterX + 0.3, y: 0.98, z: planterZ - 0.1 },
    { w: 0.1, h: 0.1, d: 0.1, x: planterX + 0.02, y: 1.26, z: planterZ },
  );
  const pink = mergedBoxes(pinkSpecs, hex(PALETTE.pinkDeep))!;
  pink.castShadow = false;
  pink.receiveShadow = false;
  group.add(pink);

  // A bicycle propped on the pavement, seen through the left pane. Two square wheels of four
  // bars each, a diagonal frame, a saddle in the batch's woodDark. At this pixel size a square
  // wheel reads as a wheel.
  const bikeX = 1.5;
  const bikeZ = outer - 0.6;
  const wheelR = 0.3;
  for (const wx of [bikeX - 0.55, bikeX + 0.55]) {
    ink.push(
      { w: wheelR * 2, h: 0.06, d: 0.06, x: wx, y: 0.16 + wheelR * 2 - 0.03, z: bikeZ },
      { w: wheelR * 2, h: 0.06, d: 0.06, x: wx, y: 0.16 + 0.03, z: bikeZ },
      { w: 0.06, h: wheelR * 2, d: 0.06, x: wx - wheelR + 0.03, y: 0.16 + wheelR, z: bikeZ },
      { w: 0.06, h: wheelR * 2, d: 0.06, x: wx + wheelR - 0.03, y: 0.16 + wheelR, z: bikeZ },
    );
  }
  ink.push(
    { w: 0.9, h: 0.06, d: 0.06, x: bikeX, y: 0.16 + wheelR + 0.32, z: bikeZ }, // top tube
    { w: 0.06, h: 0.7, d: 0.06, x: bikeX - 0.35, y: 0.16 + wheelR + 0.2, z: bikeZ, rz: 0.25 }, // seat tube
    { w: 0.06, h: 0.7, d: 0.06, x: bikeX + 0.4, y: 0.16 + wheelR + 0.3, z: bikeZ, rz: -0.35 }, // head tube
    { w: 0.06, h: 0.6, d: 0.06, x: bikeX, y: 0.16 + wheelR + 0.05, z: bikeZ, rz: -0.9 }, // down tube
    { w: 0.06, h: 0.06, d: 0.44, x: bikeX + 0.5, y: 0.16 + wheelR + 0.66, z: bikeZ }, // handlebar
  );
  batch.add({ w: 0.26, h: 0.08, d: 0.14, x: bikeX - 0.4, y: 0.16 + wheelR + 0.6, z: bikeZ }, C.woodDark);

  const inkMesh = mergedBoxes(ink, hex(INK))!;
  inkMesh.castShadow = false;
  inkMesh.receiveShadow = true;
  inkMesh.name = 'cafe-shopfront-ink';
  group.add(inkMesh);

  /* ------------------------------------------------------- the backdrop */
  // The L. Back plane x -0.6..9.0 at z -7.0; return at x -0.6 from inside the wall to the back
  // plane, facing +x. Both 6.0 tall from the ground, so the lowest rays meet asphalt and the
  // highest meet paint. See the enclosure arithmetic in the file header.
  const back = createStreetBackdrop(streetW, 6.0, 0);
  back.mesh.position.set(streetMid, 3.0, backZ);
  group.add(back.mesh);
  // The return ends in the MIDDLE of the wall slab (buildShellWalls makes it 0.24 thick, from
  // minZ inward), not past its inner face: an end that pokes into the room shows as a bright
  // edge-on sliver above the desk, which is how this was first noticed.
  const retEnd = outer + 0.12;
  const retLen = retEnd - backZ;
  const ret = createStreetBackdrop(retLen, 6.0, 1);
  ret.mesh.position.set(sx0, 3.0, (retEnd + backZ) / 2);
  ret.mesh.rotation.y = Math.PI / 2;
  group.add(ret.mesh);

  /* ------------------------------------------------------- inside: a window table */
  // A bistro table for two under the window, so the window is somewhere the café sits, not a
  // gap in the wall. Clear of the desk (x ≤ 1.9), the floor-c slot (z ≥ -0.8) and the pendant.
  const tableX = 4.4;
  const tableZ = -2.55;
  batch.add({ w: 0.12, h: 0.7, d: 0.12, x: tableX, y: 0.35, z: tableZ }, C.woodDark);
  batch.add({ w: 0.5, h: 0.06, d: 0.5, x: tableX, y: 0.03, z: tableZ }, C.woodDark);
  batch.add({ w: 0.9, h: 0.06, d: 0.9, x: tableX, y: 0.73, z: tableZ }, C.wood);
  batch.add({ w: 0.16, h: 0.16, d: 0.16, x: tableX + 0.18, y: 0.84, z: tableZ - 0.1 }, hex(PALETTE.paper));
  batch.add({ w: 0.32, h: 0.03, d: 0.32, x: tableX - 0.16, y: 0.775, z: tableZ + 0.12 }, hex(PALETTE.paper));
  for (const [cx, ry] of [[tableX - 0.8, 0.3], [tableX + 0.8, -0.3]] as Array<[number, number]>) {
    batch.add({ w: 0.44, h: 0.06, d: 0.44, x: cx, y: 0.46, z: tableZ, ry }, C.wood);
    batch.add({ w: 0.44, h: 0.5, d: 0.06, x: cx, y: 0.74, z: tableZ - 0.2, ry }, C.woodDark);
    batch.addMany(
      [
        { w: 0.05, h: 0.46, d: 0.05, x: cx - 0.18, y: 0.23, z: tableZ - 0.18, ry },
        { w: 0.05, h: 0.46, d: 0.05, x: cx + 0.18, y: 0.23, z: tableZ - 0.18, ry },
        { w: 0.05, h: 0.46, d: 0.05, x: cx - 0.18, y: 0.23, z: tableZ + 0.18, ry },
        { w: 0.05, h: 0.46, d: 0.05, x: cx + 0.18, y: 0.23, z: tableZ + 0.18, ry },
      ],
      C.woodDark,
    );
  }

  /* ------------------------------------------------------- per-frame */
  let lastPhase: DayPhase | null = null;
  const glowToon = mat(hex(LAMP_GLASS));
  const glowFlat = flat(hex(LAMP_GLASS));

  return {
    backdrops: [back, ret],
    nightLights: [lampLight],
    openings: [CAFE_WINDOW],
    obstacles: [{ x: tableX, z: tableZ, r: 1.0 }],
    update(dt, _elapsed, phase, reducedMotion) {
      // Rain runs down the glass: the whole sheet scrolls, which reads as water. Frozen under
      // reduced motion, where a sheet of still streaks is simply a wet window.
      if (!reducedMotion) {
        glass.tex.offset.y = (glass.tex.offset.y - dt * 0.22) % 1;
      }
      if (phase !== lastPhase) {
        lastPhase = phase;
        puddleMat.color.set(hex(STREET[phase].puddle));
        // The lamp head and the festoon go from a pale glass box to the thing that glows.
        const on = phase === 'dusk' || phase === 'night';
        glow.material = on ? glowFlat : glowToon;
      }
    },
  };
}
