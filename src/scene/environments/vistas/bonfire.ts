/**
 * BONFIRE NIGHT — the lake below the camp.
 *
 * The bonfire's sky is dusky at every phase by design, so its vista cannot be a painted sky the
 * way the cozy room's garden is: there is no daylight to invert against. What it has instead is
 * a fire, and a fire wants dark water. The camp now sits on a round headland; behind it, across
 * the whole far half of the world, is a black lake, a far shore of stepped pine silhouettes, a
 * ridge of mountains beyond the horizon rim, and a low moon whose glitter path runs across the
 * water straight at the fire. That path is the default-pose hero — the one bright line in the
 * dark half of the frame — and a peach tent by the reeds glows warm from dusk so the near side
 * has a second lit thing besides the fire.
 *
 * Where things sit is arithmetic, not taste — measured with a headless raycast of the real
 * camera rig, because the first draft's arithmetic put the moon a hair above the frame. At the
 * default pose (azimuth 225, elevation 28, zoom 1, 16:9) the eye is at (8.9, 7.7, 8.2) looking
 * 28° down with a 23° vertical half-fov, so the TOP edge of the frame is a ray 5° below
 * horizontal: it meets the far shore (radius 24) at y≈4.6 and the rim (radius 28.5) at y≈4.2.
 * The rim's top (5.0..8.6) is never in frame at that pose; the pines are cut by the frame edge;
 * and a moon "hanging low" at y 4.6 is a moon sitting exactly on the edge of the picture. So the
 * moon sits ON the far shore instead: disc from y 0.5 to 3.2 at radius 24.6, against the rim's
 * face, in a ±11° notch in the tree line, its top ~1.4 units under the frame edge and dead
 * centre horizontally (NDC x≈0, y 0.74..0.91).
 *
 * At elevation 14 (the minimum) the top edge is 9° ABOVE horizontal in 16:9, and from the
 * farthest eye (zoom 1.2, azimuth 270: (12.6, 4.3, -0.3)) that ray crosses radius 37.5 at
 * y≈12.2 — well over the rim. That is what the mountains are for: a continuous stepped ridge
 * 14..15 tall at radius 37.5, spanning azimuth 120..330 so a 32:9 frame is covered, with peaks
 * to 19 that only a portrait phone (58° fov) ever sees the skyline of. Portrait at elevation
 * 14 would need a 19-tall wall and keeps a little sky at the very top, which outdoors is
 * legitimate; landscape reads 0% edge sky at every pose in the legal arc.
 *
 * Rules this file obeys:
 *  - Every mesh here is castShadow = false, and every mesh here is receiveShadow = false too.
 *    The shadow camera is a ±8 box in LIGHT space (world.ts), not in world x/z: the tent at
 *    (4.6, -5.4) looks inside the box on a plan but its front corner projects to light-space
 *    x 8.8, and the clamp band paints across anything out there that samples the map. That is
 *    also why shore stones and the canoe are their OWN meshes in the world's existing colours
 *    rather than boxes pushed into the batch: the batch's merged meshes receive.
 *  - Nothing is removed. The horizon rim still closes the top edge; the lake is laid over the
 *    ground at y 0.02..0.07, and the far bank at 0..0.35, so no frame edge that was closed
 *    before is opened. The ridge only ADDS built geometry behind the rim.
 *  - The shore starts at radius 10.8 because the cats' roam rect (16 × 14, clamped to 15.2 ×
 *    13.2) has its corner at radius 10.1: no cat ever stands on the water.
 *  - Silhouettes are unlit (`flat`): a pine at dusk is a hole in the sky, not a lit object,
 *    and the water's colour is chosen per phase rather than left to the toon ramp.
 *  - Repaints happen on phase change only; the per-frame work is two opacities and two
 *    positions (the shimmer), and nothing at all under reduced motion.
 *
 * Draw calls (bonfire is 122 with five cats; budget 300 with eight, ~13 per cat):
 *   water (own unlit mesh, recoloured per phase)                       +1
 *   far bank + 14 pines, one indigo, one merged mesh                    +1
 *   mountain ridge + peaks, one mesh, recoloured per phase              +1
 *   moon, flat near-white                                               +1
 *   glitter path, strips A                                              +1
 *   glitter path, strips B (alternate strips, so two can shimmer)       +1
 *   tent, peach, toon-lit, casts and receives nothing                   +1
 *   tent door glow, flat                                                +1
 *   shore stones, existing stone colour, own mesh (no receive)          +1
 *   canoe + cattails + tent poles, existing woodDark, own mesh          +1
 *   tent PointLight                                                     +0 (a light, not a draw)
 *   -----------------------------------------------------------------------
 *   total                                                              +10  → 132 with five cats
 */

import * as THREE from 'three';
import type { DayPhase } from '../../../core/time';
import type { EnvironmentDef } from '../../../data/environments';
import { C, hex, mixHex } from '../../../data/palette';
import type { Obstacle } from '../../cats/catBrain';
import type { Backdrop } from '../../props/garden';
import type { WallOpening } from '../index';
import { BoxBatch, flat, mergedBoxes, type BoxSpec } from '../../voxel';

export interface VistaContext {
  batch: BoxBatch;
  group: THREE.Group;
  def: EnvironmentDef;
}

export interface VistaResult {
  backdrops: Backdrop[];
  nightLights: THREE.PointLight[];
  obstacles: Obstacle[];
  /** Open worlds have no walls to cut; present for parity with the café's shape. */
  openings?: WallOpening[];
  update?(dt: number, elapsed: number, phase: DayPhase, reducedMotion: boolean): void;
}

/* --------------------------------------------------------------- palette */

/** The horizon rim's colour, as buildEnvironment paints it for this world. The ridge is keyed to it. */
const RIM = '#4E4374';
/** The far shore and its pines: darker than the rim behind them, so they read as holes. */
const PINE = '#2E2A4A';
/**
 * The ridge sits BEHIND the rim and in front of the sky, so its colour sits between the two —
 * halfway from this phase's sky to the rim. At night that is #342C53: darker than the rim,
 * lighter than the sky, a band of distance rather than a second lit ridge competing with the
 * fire. At dawn the sky is nearly the rim's colour and the ridge all but dissolves, which is
 * what dawn haze does.
 */
function ridgeColour(sky: string): string {
  return mixHex(sky, RIM, 0.45);
}
/** Moon and its path. Near-white, not butter: butter is 0.73 linear and never reads as light. */
const MOONLIGHT = '#FFF4D6';
const DOOR_GLOW = '#FFD08A';
const TENT_LIGHT = '#FFC98A';

/**
 * Water per phase. A darker, bluer cousin of the world's own sky (`ENVIRONMENTS.bonfire.sky`):
 * the lake is the sky seen through a lot of water, so it follows the sky's hue but never gets
 * lighter than about half of it. Hand-picked rather than mixed, because a mix that looked right
 * at night turned the afternoon lake milky.
 */
const WATER: Record<DayPhase, string> = {
  dawn: '#303670',
  morning: '#3A4384',
  afternoon: '#414A90',
  golden: '#4A4180',
  dusk: '#262A5C',
  night: '#1F2350',
};

/** How bright the moon and its path are. Dim by day — the moon is up, but it is daylight's moon. */
const MOON_ALPHA: Record<DayPhase, number> = {
  dawn: 0.6,
  morning: 0.5,
  afternoon: 0.5,
  golden: 0.6,
  dusk: 0.95,
  night: 1.0,
};

/* ---------------------------------------------------------------- layout */

/** The near shore: the camp's headland. Roam-rect corner is at 10.1; see the header. */
const SHORE_R = 10.8;
/** Where the lake ends and the far bank begins. Pines stand on the bank, in front of the rim. */
const FAR_SHORE_R = 20.0;
/** The bank runs under the rim (inner face at 25.4) so no soil shows between pine trunks. */
const BANK_OUTER_R = 26.5;
/**
 * The lake is the half of the world beyond this line. `x + z < -1.5` is a line perpendicular to
 * the default view, 1.06 units behind the origin: from the default pose the shore runs level
 * across the frame with the bay bulging back around the camp.
 */
const HALF_PLANE = -1.5;
/** Raster cell for the lake and bank. 0.8 gives a stepped shore, which is the point. */
const CELL = 0.8;

const FIRE = { x: -2.4, z: 1.8 };
/**
 * Dead ahead at the default pose, resting on the far shore against the rim's face, in the tree
 * line's notch. Radius 24.6: in front of the rim's inner face (25.4) and behind the pines
 * (20.6..24.2). y 1.85: the disc's bottom row clears the bank's top (0.35) by 0.17.
 */
const MOON = { x: -17.4, y: 1.85, z: -17.4 };
/** Half-angle of the gap in the tree line the moon sits in. */
const NOTCH_DEG = 11;
const TENT = { x: 4.6, z: -5.4 };
/** The ridge behind the rim (rim radius 28.5, its outer face ~31.6). See the header for the height. */
const RIDGE_R = 37.5;
const RIDGE_H = 14;

/** A tiny deterministic hash, so the pines and stones are the same every time you sit down. */
function noise(i: number, k: number): number {
  let n = (i * 374761393 + k * 668265263) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * Rasterise a region into row-runs: one box per contiguous run of cells along x, one row per z.
 * This is how a lake and a bank become a few dozen boxes with a stepped edge.
 */
function rasterRows(inside: (x: number, z: number) => boolean, extent: number, y: number, h: number): BoxSpec[] {
  const out: BoxSpec[] = [];
  const n = Math.ceil((extent * 2) / CELL);
  for (let row = 0; row < n; row++) {
    const cz = -extent + (row + 0.5) * CELL;
    let runStart = -1;
    for (let col = 0; col <= n; col++) {
      const cx = -extent + (col + 0.5) * CELL;
      const on = col < n && inside(cx, cz);
      if (on && runStart < 0) runStart = col;
      if (!on && runStart >= 0) {
        const len = col - runStart;
        out.push({ w: len * CELL, h, d: CELL, x: -extent + (runStart + len / 2) * CELL, y, z: cz });
        runStart = -1;
      }
    }
  }
  return out;
}

const beyondShore = (x: number, z: number) => x + z < HALF_PLANE;

/* ------------------------------------------------------------------ parts */

/** A pine is a trunk and four narrowing tiers and a tip: a stepped triangle, nothing smooth. */
function pineSpecs(x: number, z: number, baseY: number, height: number, spread: number): BoxSpec[] {
  const tierH = height * 0.22;
  const specs: BoxSpec[] = [{ w: 0.3, h: height * 0.2 + 0.1, d: 0.3, x, y: baseY + height * 0.1, z }];
  const widths = [1.0, 0.78, 0.56, 0.36];
  for (let i = 0; i < widths.length; i++) {
    const w = spread * widths[i];
    const y = baseY + height * (0.16 + i * 0.19) + tierH / 2;
    specs.push({ w, h: tierH, d: w, x, y, z });
  }
  specs.push({ w: 0.3, h: height * 0.12, d: 0.3, x, y: baseY + height * 0.94, z });
  return specs;
}

/** A peak: five stepped tiers, each narrower and taller-looking than the last. */
function mountainSpecs(x: number, z: number, height: number, base: number): BoxSpec[] {
  const specs: BoxSpec[] = [];
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const w = base * (1 - t * 0.82);
    const h = height * 0.26;
    specs.push({ w, h, d: w * 0.8, x, y: height * (t * 0.8) + h / 2, z });
  }
  return specs;
}

/**
 * The ridge: a ring of overlapping boxes, the way buildHorizonRim makes the rim, every 7.5°
 * from azimuth 120 to 330 (the legal arc is 180..270, and a 32:9 frame sees ±57° of it), plus
 * six peaks whose lower tiers are buried in the ring. In landscape the ring's top is above the
 * frame at every legal pose, so what shows at low elevation is a band of distance above the
 * rim; the peaks exist for portrait, where the skyline comes into frame.
 */
function ridgeSpecs(): BoxSpec[] {
  const specs: BoxSpec[] = [];
  for (let deg = 120; deg <= 330; deg += 7.5) {
    const a = (deg * Math.PI) / 180;
    const h = RIDGE_H + noise(deg * 2, 20) * 1.2;
    specs.push({ w: 7.0, h, d: 4.5, x: Math.sin(a) * RIDGE_R, y: h / 2, z: Math.cos(a) * RIDGE_R, ry: a });
  }
  const peaks: Array<[number, number, number]> = [
    // azimuth degrees, height, base width
    [150, 17.5, 15],
    [186, 19.0, 18],
    [213, 16.5, 13],
    [246, 18.5, 17],
    [281, 17.0, 15],
    [313, 16.0, 13],
  ];
  for (const [deg, h, base] of peaks) {
    const a = (deg * Math.PI) / 180;
    specs.push(...mountainSpecs(Math.sin(a) * (RIDGE_R + 0.6), Math.cos(a) * (RIDGE_R + 0.6), h, base));
  }
  return specs;
}

/**
 * The moon is a stepped disc, seven rows, 2.7 wide and 2.66 tall, thin, turned to face the
 * default eye. A cube read as a die; this reads as a moon drawn in pixels, which is the house.
 * A moon on the horizon is drawn big — the moon illusion — so it is a little larger than a
 * high moon would be.
 */
function moonSpecs(): BoxSpec[] {
  const rows = [1.1, 2.0, 2.5, 2.7, 2.5, 2.0, 1.1];
  const rowH = 0.38;
  const specs: BoxSpec[] = [];
  rows.forEach((w, i) => {
    specs.push({ w, h: rowH, d: 0.24, x: MOON.x, y: MOON.y + (i - 3) * rowH, z: MOON.z, ry: Math.PI / 4 });
  });
  return specs;
}

/* ------------------------------------------------------------------- main */

export function addBonfireVista(ctx: VistaContext): VistaResult {
  const { group } = ctx;
  const vista = new THREE.Group();
  vista.name = 'bonfire-vista';
  group.add(vista);

  const unlit = (specs: BoxSpec[], colour: string, name: string): THREE.Mesh | null => {
    const mesh = mergedBoxes(specs, hex(colour));
    if (!mesh) return null;
    mesh.material = flat(hex(colour));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = name;
    vista.add(mesh);
    return mesh;
  };

  /* ------------------------------------------------------------- the lake */
  // 0.02..0.07: proud of the ground (top at 0) and of the shadow patch's corners (0.003),
  // which the lake covers beyond radius 10.8, so nothing coplanar can fight it.
  const waterSpecs = rasterRows(
    (x, z) => beyondShore(x, z) && Math.hypot(x, z) > SHORE_R && Math.hypot(x, z) < FAR_SHORE_R + 0.4,
    BANK_OUTER_R + 1,
    0.045,
    0.05,
  );
  const water = mergedBoxes(waterSpecs, hex(WATER.night));
  let waterMat: THREE.MeshBasicMaterial | null = null;
  if (water) {
    // Its own material, not the cached one: this is the one colour in the vista that changes.
    waterMat = new THREE.MeshBasicMaterial({ color: hex(WATER.night) });
    water.material = waterMat;
    water.castShadow = false;
    water.receiveShadow = false;
    water.name = 'lake';
    vista.add(water);
  }

  /* --------------------------------------------------- the far shore, pines */
  // The bank sits 0.35 proud of the water so the far edge reads as land, and runs under the
  // rim so no soil shows between the trunks. Pines from azimuth 150 to 300, with a notch of
  // ±11 degrees around 225 where the moon rests; the pines flanking the notch are short. The
  // notch is that wide so the moon is still clear of the flanking pines from azimuth 200 and
  // 250, where the line of sight to it crosses the bank ten degrees off 225.
  const shoreSpecs = rasterRows(
    (x, z) => beyondShore(x, z) && Math.hypot(x, z) > FAR_SHORE_R - 0.2 && Math.hypot(x, z) < BANK_OUTER_R,
    BANK_OUTER_R + 1,
    0.175,
    0.35,
  );
  const PINE_COUNT = 14;
  for (let i = 0; i < PINE_COUNT; i++) {
    // Even spacing with a jitter, skipping the notch.
    let deg = 150 + (i / (PINE_COUNT - 1)) * 150 + (noise(i, 1) - 0.5) * 6;
    if (Math.abs(deg - 225) < NOTCH_DEG) deg = deg < 225 ? 225 - NOTCH_DEG : 225 + NOTCH_DEG;
    const a = (deg * Math.PI) / 180;
    const r = FAR_SHORE_R + 0.6 + noise(i, 2) * 3.6;
    const nearNotch = Math.abs(deg - 225) < NOTCH_DEG + 6;
    const height = nearNotch ? 4.4 + noise(i, 3) * 0.6 : 5.4 + noise(i, 3) * 3.0;
    const spread = 1.6 + height * 0.18;
    shoreSpecs.push(...pineSpecs(Math.sin(a) * r, Math.cos(a) * r, 0.35, height, spread));
  }
  unlit(shoreSpecs, PINE, 'far-shore');

  /* ---------------------------------------------------------------- ridge */
  // Behind the rim, at radius 37.5: from the default pose it is hidden entirely, and at low
  // elevation it is the built geometry above the rim, where before there was sky. Its own
  // material, like the water's, because it is recoloured with the sky on each phase change.
  const ridge = mergedBoxes(ridgeSpecs(), hex(RIM));
  let ridgeMat: THREE.MeshBasicMaterial | null = null;
  if (ridge) {
    ridgeMat = new THREE.MeshBasicMaterial({ color: hex(ridgeColour(ctx.def.sky.night)) });
    ridge.material = ridgeMat;
    ridge.castShadow = false;
    ridge.receiveShadow = false;
    ridge.name = 'mountains';
    vista.add(ridge);
  }

  /* ------------------------------------------------------- the moon, the path */
  const moon = mergedBoxes(moonSpecs(), hex(MOONLIGHT));
  const moonMat = new THREE.MeshBasicMaterial({ color: hex(MOONLIGHT), transparent: true, opacity: 1 });
  if (moon) {
    moon.material = moonMat;
    moon.castShadow = false;
    moon.receiveShadow = false;
    moon.name = 'moon';
    vista.add(moon);
  }

  // The glitter path runs from under the moon toward the FIRE, not the eye: the fire is the
  // thing the picture is about, and the two lie within a few degrees of each other anyway.
  // Strips widen toward the near shore, as a glitter path does; every other strip goes into
  // the second mesh so the two can breathe out of phase — a shimmer for two draw calls.
  const dx = FIRE.x - MOON.x;
  const dz = FIRE.z - MOON.z;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const pathRy = Math.atan2(ux, uz);
  const stripsA: BoxSpec[] = [];
  const stripsB: BoxSpec[] = [];
  let k = 0;
  // 0.5..0.8 apart: about sixteen strips between the shores. Eight read as stepping stones.
  for (let s = 3.2; s < len; s += 0.5 + noise(k, 5) * 0.3) {
    const x = MOON.x + ux * s;
    const z = MOON.z + uz * s;
    const r = Math.hypot(x, z);
    k++;
    if (r > FAR_SHORE_R - 0.6 || r < SHORE_R + 0.4 || !beyondShore(x, z)) continue;
    // Widest at the near shore, narrowest under the moon — a cone toward the viewer.
    const t = (FAR_SHORE_R - r) / (FAR_SHORE_R - SHORE_R);
    const w = 0.7 + t * 1.1 + (noise(k, 6) - 0.5) * 0.3;
    const d = 0.3 + noise(k, 7) * 0.25;
    const side = (noise(k, 8) - 0.5) * 0.5;
    const spec: BoxSpec = { w, h: 0.04, d, x: x - uz * side, y: 0.09, z: z + ux * side, ry: pathRy };
    (k % 2 === 0 ? stripsA : stripsB).push(spec);
  }
  const pathMats: THREE.MeshBasicMaterial[] = [];
  const pathMeshes: THREE.Mesh[] = [];
  for (const [specs, name] of [[stripsA, 'moon-path-a'], [stripsB, 'moon-path-b']] as Array<[BoxSpec[], string]>) {
    const mesh = mergedBoxes(specs, hex(MOONLIGHT));
    if (!mesh) continue;
    const m = new THREE.MeshBasicMaterial({ color: hex(MOONLIGHT), transparent: true, opacity: 0.8 });
    mesh.material = m;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = name;
    vista.add(mesh);
    pathMats.push(m);
    pathMeshes.push(mesh);
  }

  /* --------------------------------------------------------------- the tent */
  // A ridge tent as a stepped A-frame: five tiers of peach, each narrower, the ridge along z so
  // the gable with the door faces +z — toward the camp, and toward the eye. The door is a gap
  // in the front face of the two bottom tiers, with a flat glow box behind it; the warm light
  // stands just OUTSIDE the door, so it can light the tent's front face and the step stone —
  // inside the tent it would light only back faces, which are culled, and nothing would read
  // as lit. The orchestrator brings it up at dusk. It casts nothing and receives nothing: its
  // front corner is at light-space x 8.8, outside the shadow camera's ±8 (see the header).
  const tentW = 2.6;
  const tentD = 2.4;
  const tierH = 0.4;
  const tiers = [1.0, 0.8, 0.6, 0.42, 0.24];
  const front = TENT.z + tentD / 2;
  const doorW = 0.7;
  const face = 0.28;
  const tentSpecs: BoxSpec[] = [];
  tiers.forEach((f, i) => {
    const w = tentW * f;
    const y = i * tierH + tierH / 2;
    // Body, stopping short of the front face.
    tentSpecs.push({ w, h: tierH, d: tentD - face, x: TENT.x, y, z: TENT.z - face / 2 });
    if (i < 2) {
      // Front face split around the door.
      const side = (w - doorW) / 2;
      tentSpecs.push({ w: side, h: tierH, d: face, x: TENT.x - doorW / 2 - side / 2, y, z: front - face / 2 });
      tentSpecs.push({ w: side, h: tierH, d: face, x: TENT.x + doorW / 2 + side / 2, y, z: front - face / 2 });
    } else {
      tentSpecs.push({ w, h: tierH, d: face, x: TENT.x, y, z: front - face / 2 });
    }
  });
  const tent = mergedBoxes(tentSpecs, C.peach);
  if (tent) {
    tent.castShadow = false;
    tent.receiveShadow = false;
    tent.name = 'tent';
    vista.add(tent);
  }
  const glow = mergedBoxes([{ w: doorW, h: tierH * 2 - 0.06, d: 0.1, x: TENT.x, y: tierH - 0.03, z: front - face - 0.06 }], hex(DOOR_GLOW));
  if (glow) {
    glow.material = flat(hex(DOOR_GLOW));
    glow.castShadow = false;
    glow.receiveShadow = false;
    glow.name = 'tent-door';
    vista.add(glow);
  }
  const tentLight = new THREE.PointLight(hex(TENT_LIGHT), 0, 5.5, 2);
  // 0.7 in front of the door, at the height of the glow: the front face, the step stone and
  // a pool of ground get lit; the lit face is what says "someone is in there".
  tentLight.position.set(TENT.x, 0.7, front + 0.7);
  // Never a shadow caster: six extra renders for a tent.
  tentLight.castShadow = false;
  vista.add(tentLight);

  /* --------------------------------------------- the near shore, in old colours */
  // Stones along the bay, and a canoe and cattails, in colours the bonfire already has — but as
  // their OWN meshes, because the batch's merged stone and wood receive shadows and this is all
  // outside the shadow box (see the header).
  const stones: BoxSpec[] = [];
  for (let deg = 140; deg <= 310; deg += 4.5) {
    const i = Math.round(deg * 2);
    const a = (deg * Math.PI) / 180;
    const r = SHORE_R - 0.45 + noise(i, 9) * 0.4;
    const s = 0.3 + noise(i, 10) * 0.25;
    stones.push({ w: s, h: s * 0.6, d: s * 0.8, x: Math.sin(a) * r, y: s * 0.3, z: Math.cos(a) * r, ry: noise(i, 11) * 1.5 });
  }
  // A few along the straight legs of the shore, where it runs out of frame.
  for (const t of [8.4, 9.6, 10.9]) {
    stones.push({ w: 0.42, h: 0.24, d: 0.34, x: t, y: 0.12, z: HALF_PLANE - t + 0.35, ry: 0.4 });
    stones.push({ w: 0.42, h: 0.24, d: 0.34, x: HALF_PLANE - t + 0.35, y: 0.12, z: t, ry: -0.3 });
  }
  // Step stone at the tent door.
  stones.push({ w: 0.7, h: 0.08, d: 0.44, x: TENT.x, y: 0.04, z: front + 0.3 });
  const stoneMesh = mergedBoxes(stones, C.stone);
  if (stoneMesh) {
    stoneMesh.castShadow = false;
    stoneMesh.receiveShadow = false;
    stoneMesh.name = 'shore-stones';
    vista.add(stoneMesh);
  }

  const wood: BoxSpec[] = [];
  // A canoe pulled up on the bank at azimuth 200, lying along the shore.
  const canoe = { x: -3.2, z: -8.8, ry: 0.35 };
  const along = (u: number, v: number) => ({
    x: canoe.x + u * Math.cos(canoe.ry) + v * Math.sin(canoe.ry),
    z: canoe.z - u * Math.sin(canoe.ry) + v * Math.cos(canoe.ry),
  });
  wood.push({ w: 2.4, h: 0.16, d: 0.62, ...along(0, 0), y: 0.08, ry: canoe.ry });
  wood.push({ w: 2.4, h: 0.3, d: 0.1, ...along(0, -0.3), y: 0.23, ry: canoe.ry });
  wood.push({ w: 2.4, h: 0.3, d: 0.1, ...along(0, 0.3), y: 0.23, ry: canoe.ry });
  wood.push({ w: 0.2, h: 0.36, d: 0.56, ...along(-1.15, 0), y: 0.28, ry: canoe.ry });
  wood.push({ w: 0.2, h: 0.36, d: 0.56, ...along(1.15, 0), y: 0.28, ry: canoe.ry });
  wood.push({ w: 0.7, h: 0.06, d: 0.5, ...along(0.3, 0), y: 0.3, ry: canoe.ry }); // thwart
  // Cattails: brown stalks with fat brown heads, in two stands — by the tent and across the bay.
  const stands: Array<[number, number, number]> = [
    // azimuth degrees from, to, count
    [148, 162, 6],
    [258, 292, 9],
  ];
  for (const [from, to, count] of stands) {
    for (let i = 0; i < count; i++) {
      const deg = from + ((to - from) * (i + 0.5)) / count + (noise(i, 12) - 0.5) * 3;
      const a = (deg * Math.PI) / 180;
      const r = SHORE_R - 0.9 + noise(i, 13) * 0.7;
      const h = 0.9 + noise(i, 14) * 0.5;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      wood.push({ w: 0.06, h, d: 0.06, x, y: h / 2, z });
      wood.push({ w: 0.14, h: 0.34, d: 0.14, x, y: h - 0.1, z });
    }
  }
  // Tent ridge pole and its two end poles.
  wood.push({ w: 0.08, h: 0.08, d: tentD + 0.5, x: TENT.x, y: tiers.length * tierH + 0.04, z: TENT.z });
  wood.push({ w: 0.08, h: tiers.length * tierH + 0.3, d: 0.08, x: TENT.x, y: (tiers.length * tierH + 0.3) / 2, z: TENT.z - tentD / 2 - 0.2 });
  wood.push({ w: 0.08, h: tiers.length * tierH + 0.3, d: 0.08, x: TENT.x, y: (tiers.length * tierH + 0.3) / 2, z: front + 0.2 });
  const woodMesh = mergedBoxes(wood, C.woodDark);
  if (woodMesh) {
    woodMesh.castShadow = false;
    woodMesh.receiveShadow = false;
    woodMesh.name = 'shore-wood';
    vista.add(woodMesh);
  }

  /* ---------------------------------------------------------------- update */
  let current: DayPhase | null = null;
  let shimmer = 0;

  return {
    backdrops: [],
    nightLights: [tentLight],
    obstacles: [
      { x: TENT.x, z: TENT.z, r: 1.7 }, // tent
      { x: -7.6, z: -6.6, r: 1.5 }, // the bay's stones at the roam rect's wet corner
      { x: canoe.x, z: canoe.z, r: 1.3 }, // canoe
    ],
    update(dt, _elapsed, phase, reducedMotion) {
      if (phase !== current) {
        current = phase;
        if (waterMat) waterMat.color.set(hex(WATER[phase]));
        if (ridgeMat) ridgeMat.color.set(hex(ridgeColour(ctx.def.sky[phase])));
        moonMat.opacity = MOON_ALPHA[phase];
      }
      const base = MOON_ALPHA[phase];
      if (reducedMotion) {
        for (const m of pathMats) m.opacity = base * 0.85;
        for (const mesh of pathMeshes) mesh.position.set(0, 0, 0);
        return;
      }
      shimmer += dt;
      for (let i = 0; i < pathMats.length; i++) {
        // Two slow sines out of phase: as one set of strips brightens the other fades, and the
        // whole path drifts a hand's width along its own line. Reads as water moving.
        const wave = Math.sin(shimmer * 1.7 + i * Math.PI) * 0.5 + Math.sin(shimmer * 0.6 + i * 1.3) * 0.5;
        pathMats[i].opacity = base * (0.62 + 0.3 * wave);
        const drift = Math.sin(shimmer * 0.9 + i * 2.1) * 0.08;
        pathMeshes[i].position.set(ux * drift, 0, uz * drift);
      }
    },
  };
}
