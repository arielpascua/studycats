/**
 * PICNIC HILL — the valley below.
 *
 * The camera stands on a hill in the +x/+z quadrant and looks down into -x/-z. Until now the
 * ground ran flat to a green rim and stopped. This module puts a valley in that quadrant: a
 * reed bank where the hill drops away, a lake tinted by the hour, a jetty with a rowboat and
 * one lamp, a village on the far shore, two ranges of stepped hills in hazy blues, and a big
 * shade tree at the left edge of the frame so you look PAST something into all of it. At night
 * the lake carries the moon's shimmer path and the village lights its windows — that, plus the
 * jetty lamp, is what keeps 11pm worth looking at.
 *
 * Layout is polar about the desk, because the eye orbits: θ=180° is -x (the frame's left at the
 * default pose), θ=270° is -z (its right), θ=225° the diagonal straight ahead. Measured with the
 * real rig at the default pose (eye 8.9, 7.7, 8.2; frame top 5° below horizontal):
 *   reeds r 8.7-9.1   lake r 9.3-16.3 (reads -19.7°..-15°, a band across the whole width)
 *   shore r 16.6-19.5 (treeline, village, jetty lamp)   near hills r 18-21, 3-4.2 tall (-7°)
 *   far range r 23, 7.8-9.6 tall (reads +1.5°: above the frame top, so it also hides the rim,
 *   whose crest reads -4.4°..0.1°). The rim is untouched — it still closes the top edge on its
 *   own wherever the far range does not reach.
 *
 * Draw-call arithmetic (a castShadow=false mesh is 1, a caster is 2, a box in an existing batch
 * colour is 0):
 *   lake (own tinted material)                      1
 *   night glow: moon, shimmer, windows, lamp flame  1  (hidden by day, so 0 then)
 *   reeds + far-shore treeline (leafDark)           1
 *   near hills (own tinted material)                1
 *   far range (own tinted material)                 1
 *   village walls + boat seat + lamp housing (paper) 1
 *   village roofs (pinkDeep)                        1
 *   jetty + rowboat + lamp post (woodDark)          1
 *   wildflower heads + straw hat (butter, no cast)  1
 *   kite on its string (pink, no cast, animated)    1
 *   C.leaf added to the batch (a caster)            2
 *   ------------------------------------------------
 *   12 — picnic goes 79 → 91 with five cats, ~130 with eight, against a budget of 300.
 * Everything at r > 8 is its own mesh with castShadow AND receiveShadow off: the shadow camera
 * is a ±8 box, and a receiver outside it gets the sampler's clamp band painted across it.
 */

import * as THREE from 'three';
import type { DayPhase } from '../../../core/time';
import type { EnvironmentDef } from '../../../data/environments';
import { C, hex, PALETTE } from '../../../data/palette';
import type { Obstacle } from '../../cats/catBrain';
import type { Backdrop } from '../../props/garden';
import { BoxBatch, flat, mergedBoxes, type BoxSpec } from '../../voxel';
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
  /** Walled worlds only: holes the orchestrator must cut for the vista. The picnic has no walls. */
  openings?: WallOpening[];
  update?(dt: number, elapsed: number, phase: DayPhase, reducedMotion: boolean): void;
}

/* --------------------------------------------------------------- palette */

/**
 * The valley by the hour. Water is the sky's mirror, so it follows the phase sky; the near
 * range is the saturated haze and the far range sits closer to the sky than to the ground —
 * that ordering is what makes them read as distance. At night the near range drops BELOW the
 * sky (a silhouette) and the far range stays a shade above it (haze), so the two still separate.
 */
const VALLEY: Record<DayPhase, { water: string; hillNear: string; hillFar: string }> = {
  dawn: { water: '#E4BFC8', hillNear: '#B896AE', hillFar: '#DDB6C0' },
  morning: { water: '#93C3E3', hillNear: '#86A3C2', hillFar: '#B0C6DE' },
  afternoon: { water: '#86BDE2', hillNear: '#7E9FC3', hillFar: '#A9C2E0' },
  golden: { water: '#EDB57E', hillNear: '#B98474', hillFar: '#E1A68A' },
  dusk: { water: '#9A82B4', hillNear: '#66528A', hillFar: '#9A83B8' },
  night: { water: '#161838', hillNear: '#141430', hillFar: '#2B2854' },
};

/** Moon, its shimmer on the water, the village windows and the jetty flame: one warm ivory. */
const GLOW = '#F6E8C0';
const LAMP = '#FFB870';

const DEG = Math.PI / 180;

/* --------------------------------------------------------------- helpers */

/** The same tiny deterministic hash garden.ts uses, so the valley is identical every visit. */
function noise(x: number, y: number, seed: number): number {
  let n = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  n = ((n ^ (n >>> 13)) * 1274126177) | 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * A box on the circle about the desk, turned to face it. `w` runs along the tangent, `d` along
 * the radius; `dx` slides it along the tangent and `dz` pushes it inward, toward the eye.
 * ry = -(θ + 90°) is the rotation that puts the box's local +x on the tangent and local +z on
 * the inward radial — checked at θ=225°, where it comes out as the +45° the lake needs.
 */
function ring(thetaDeg: number, r: number, w: number, h: number, d: number, y: number, dx = 0, dz = 0): BoxSpec {
  const a = thetaDeg * DEG;
  const tx = -Math.sin(a);
  const tz = Math.cos(a);
  const nx = -Math.cos(a);
  const nz = -Math.sin(a);
  return {
    w, h, d,
    x: Math.cos(a) * r + tx * dx + nx * dz,
    y,
    z: Math.sin(a) * r + tz * dx + nz * dz,
    ry: -(a + Math.PI / 2),
  };
}

/** A far mesh: one colour, one call, and never part of the shadow pass in either direction. */
function farMesh(specs: BoxSpec[], color: number, name: string): THREE.Mesh | null {
  const mesh = mergedBoxes(specs, color);
  if (!mesh) return null;
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ vista */

export function addPicnicVista(ctx: VistaContext): VistaResult {
  const { batch, group, def } = ctx;

  // The far range must stand inside the rim (groundHalf * 0.62 in buildHorizonRim) or it is
  // behind the thing it exists to hide.
  const rimRadius = def.shell.groundHalf * 0.62;
  const FAR_R = Math.min(23, rimRadius - 4);

  /* ------------------------------------------------------------- the lake */
  // Seven tangent boxes, 20° apart, so the shoreline is an arc and not a chord: from the eye a
  // straight-edged lake reads as a swimming pool. Their coplanar tops are staggered by 4 mm —
  // well above depth precision at 25 units, well below anything the eye can see.
  const lakeSpecs: BoxSpec[] = [];
  for (let i = 0; i < 7; i++) {
    const theta = 165 + i * 20;
    const wobble = noise(i, 11, 3) * 0.8 - 0.4; // an irregular far shore
    lakeSpecs.push(ring(theta, 12.8 + wobble * 0.5, 6.2, 0.06, 7.0 + wobble, 0.03 + i * 0.004));
  }
  const waterMat = new THREE.MeshBasicMaterial({ color: hex(VALLEY.afternoon.water) });
  const lake = mergedBoxes(lakeSpecs, hex(VALLEY.afternoon.water))!;
  lake.material = waterMat;
  lake.name = 'valley:lake';
  lake.castShadow = false;
  lake.receiveShadow = false;
  group.add(lake);

  /* ----------------------------------------------------- reeds + treeline */
  // A reed bank where the hill drops to the water. It is 0.35-0.6 tall at r ≈ 8.9, which from
  // the eye hides the shoreline behind it — so the lake starts BELOW the hill's edge, and a flat
  // ground plane reads as a slope. The far shore gets a treeline in the same colour wherever the
  // village is not.
  const greens: BoxSpec[] = [];
  for (let i = 0; i < 46; i++) {
    const theta = 165 + i * 3;
    const h = 0.35 + noise(i, 1, 5) * 0.25;
    greens.push(ring(theta, 8.7 + noise(i, 2, 5) * 0.4, 0.5 + noise(i, 3, 5) * 0.5, h, 0.35, h / 2));
  }
  for (let i = 0; i < 38; i++) {
    const theta = 150 + i * 4;
    if (theta > 196 && theta < 220) continue; // the village's waterfront
    const h = 1.0 + noise(i, 4, 7) * 0.8;
    const w = 1.0 + noise(i, 5, 7) * 0.9;
    greens.push(ring(theta, 16.9 + noise(i, 6, 7) * 0.8, w, h, w * 0.8, h / 2));
    // A second, lower blob beside it so the line lumps like a treeline rather than a fence.
    if (noise(i, 8, 7) > 0.45) greens.push(ring(theta + 2, 17.6, w * 0.7, h * 0.7, w * 0.6, h * 0.35));
  }
  const treeline = farMesh(greens, hex(PALETTE.leafDark), 'valley:treeline');
  if (treeline) group.add(treeline);

  /* ----------------------------------------------------------- the hills */
  // Near range: discrete stepped lumps between the far shore and the far range, low enough
  // (3-4.2) that the far range still shows above them at the default pose. One stands behind
  // the village, at r 21, so the houses have a slope to sit under.
  const nearSpecs: BoxSpec[] = [];
  const nearHills: Array<[number, number, number, number]> = [
    // θ, r, base width, height
    [156, 19.0, 6.5, 3.4], [172, 20.2, 7.5, 4.0], [188, 18.6, 6.0, 3.1], [206, 21.0, 8.0, 4.2],
    [224, 19.4, 7.0, 3.6], [240, 20.6, 6.5, 3.2], [256, 18.8, 7.5, 4.0], [274, 20.0, 6.0, 3.3],
    [292, 19.2, 7.0, 3.8], [308, 20.4, 6.5, 3.5],
  ];
  for (const [theta, r, w, h] of nearHills) {
    const step = h / 3;
    nearSpecs.push(ring(theta, r, w, step, 3.2, step / 2));
    nearSpecs.push(ring(theta, r, w * 0.66, step, 2.6, step * 1.5, w * 0.08));
    nearSpecs.push(ring(theta, r, w * 0.36, step, 2.0, step * 2.5, -w * 0.05));
  }
  const nearMat = new THREE.MeshBasicMaterial({ color: hex(VALLEY.afternoon.hillNear) });
  const near = mergedBoxes(nearSpecs, hex(VALLEY.afternoon.hillNear))!;
  near.material = nearMat;
  near.name = 'valley:hills-near';
  near.castShadow = false;
  near.receiveShadow = false;
  group.add(near);

  // Far range: a continuous chain like the rim itself, 8° apart with overlapping segments, so
  // there is no gap for the green rim to show through. It spans θ 110-340: every direction the
  // eye can be pointed from the +x/+z quadrant, at any zoom or aspect. Heights 7.8-9.6 with a
  // narrower cap on each, so the crest steps rather than runs level.
  const farSpecs: BoxSpec[] = [];
  const segW = FAR_R * (8 * DEG) * 1.35;
  for (let i = 0; i <= 29; i++) {
    const theta = 110 + i * 8;
    const h = 7.8 + ((i * 5) % 7) * 0.26;
    farSpecs.push(ring(theta, FAR_R, segW, h, 4.0, h / 2));
    farSpecs.push(ring(theta, FAR_R, segW * 0.55, 1.3, 3.0, h + 0.65, segW * (((i * 3) % 5) - 2) * 0.08));
  }
  const farMat = new THREE.MeshBasicMaterial({ color: hex(VALLEY.afternoon.hillFar) });
  const far = mergedBoxes(farSpecs, hex(VALLEY.afternoon.hillFar))!;
  far.material = farMat;
  far.name = 'valley:hills-far';
  far.castShadow = false;
  far.receiveShadow = false;
  group.add(far);

  /* --------------------------------------------------------- the village */
  // Seven houses and a church on the far shore, left of the diagonal so they never sit in the
  // moon's path. Walls face the water (local +z is inward), windows go on that face.
  const walls: BoxSpec[] = [];
  const roofs: BoxSpec[] = [];
  const glow: BoxSpec[] = [];
  const houses: Array<[number, number, number]> = [
    // θ, r, footprint
    [199, 18.4, 1.3], [202.5, 17.7, 1.1], [205.5, 19.0, 1.4], [209, 17.6, 1.2],
    [212.5, 18.6, 1.3], [216, 17.9, 1.0], [206.5, 20.3, 1.5],
  ];
  for (const [theta, r, s] of houses) {
    const h = s * 0.85;
    walls.push(ring(theta, r, s, h, s * 0.9, h / 2));
    roofs.push(ring(theta, r, s * 1.2, 0.3, s * 1.1, h + 0.15));
    roofs.push(ring(theta, r, s * 0.7, 0.3, s * 1.1, h + 0.45));
    // Two windows on the water-facing wall, a hair proud of it.
    for (const side of [-1, 1]) glow.push(ring(theta, r, 0.2, 0.22, 0.05, h * 0.5, side * s * 0.25, s * 0.45 + 0.03));
  }
  // The church: a taller nave and a tower with a spire, the one thing in the village that
  // breaks the roofline.
  walls.push(ring(208, 18.9, 1.4, 1.3, 2.2, 0.65));
  roofs.push(ring(208, 18.9, 1.6, 0.34, 2.3, 1.47));
  roofs.push(ring(208, 18.9, 0.8, 0.34, 2.3, 1.8));
  walls.push(ring(208, 18.9, 0.7, 2.7, 0.7, 1.35, 0, 1.3));
  roofs.push(ring(208, 18.9, 0.5, 0.5, 0.5, 2.95, 0, 1.3));
  roofs.push(ring(208, 18.9, 0.24, 0.5, 0.24, 3.4, 0, 1.3));
  for (const dy of [0.5, 1.0]) glow.push(ring(208, 18.9, 0.22, 0.3, 0.05, dy + 0.3, 0, 1.68));

  /* ------------------------------------------------------------ the jetty */
  // Right of the diagonal, from the reed bank out over the water: planks on four posts, a lamp
  // at the end, a rowboat tied alongside. The lamp is the one warm point in the valley at night.
  const JETTY_T = 243;
  const wood: BoxSpec[] = [];
  wood.push(ring(JETTY_T, 10.3, 0.9, 0.1, 2.8, 0.42));
  for (const [dx, dz] of [[-0.36, -1.2], [0.36, -1.2], [-0.36, 1.2], [0.36, 1.2]]) {
    wood.push(ring(JETTY_T, 10.3, 0.14, 0.5, 0.14, 0.2, dx, dz));
  }
  // Lamp post at the far end (dz negative = away from the eye, out over the water).
  const lampSpec = ring(JETTY_T, 10.3, 0.1, 1.3, 0.1, 1.05, 0.32, -1.25);
  wood.push(lampSpec);
  const lampAt = { x: lampSpec.x ?? 0, y: 1.84, z: lampSpec.z ?? 0 };
  // A paper cap and base with the flame showing between them — a closed housing would hide it.
  walls.push({ w: 0.3, h: 0.08, d: 0.3, x: lampAt.x, y: 1.99, z: lampAt.z });
  walls.push({ w: 0.2, h: 0.06, d: 0.2, x: lampAt.x, y: 1.72, z: lampAt.z });
  glow.push({ w: 0.16, h: 0.16, d: 0.16, x: lampAt.x, y: lampAt.y, z: lampAt.z });
  // The rowboat: a floor, two gunwales, bow and stern, and a paper seat, floating at the
  // lake's surface beside the jetty.
  const BOAT_T = 249;
  wood.push(ring(BOAT_T, 10.8, 0.66, 0.12, 1.6, 0.13));
  for (const dx of [-0.29, 0.29]) wood.push(ring(BOAT_T, 10.8, 0.1, 0.3, 1.6, 0.27, dx));
  for (const dz of [-0.78, 0.78]) wood.push(ring(BOAT_T, 10.8, 0.66, 0.3, 0.1, 0.27, 0, dz));
  walls.push(ring(BOAT_T, 10.8, 0.5, 0.06, 0.14, 0.3, 0, 0.15));

  /* ------------------------------------------------------- the night sky */
  // A moon low over the far range at θ 228 — just above the ridge when you tilt the camera
  // down, and even when it is out of frame its shimmer on the lake says where it is. The
  // shimmer is a run of flat dashes that widen toward the viewer, the way a moon path does.
  const MOON_T = 228;
  const moonRows = [0.8, 1.3, 1.6, 1.7, 1.6, 1.3, 0.8];
  moonRows.forEach((w, i) => glow.push(ring(MOON_T, FAR_R - 0.5, w, 0.22, 0.16, 9.0 + (i - 3) * 0.22)));
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const r = 15.6 - t * 6.0;
    const w = 0.25 + t * 0.55;
    glow.push(ring(MOON_T + (noise(i, 9, 2) - 0.5) * 2.2, r, w, 0.02, 0.14, 0.1));
  }
  // Stars, far up and far out, for the poses that see sky.
  for (let i = 0; i < 26; i++) {
    const theta = 130 + noise(i, 21, 4) * 180;
    const s = noise(i, 23, 4) > 0.7 ? 0.32 : 0.22;
    glow.push(ring(theta, FAR_R + 3 + noise(i, 22, 4) * 3, s, s, s, 10 + noise(i, 24, 4) * 10));
  }

  const wallMesh = farMesh(walls, hex(PALETTE.paper), 'valley:walls');
  const roofMesh = farMesh(roofs, hex(PALETTE.pinkDeep), 'valley:roofs');
  const woodMesh = farMesh(wood, C.woodDark, 'valley:jetty');
  const glowMesh = farMesh(glow, hex(GLOW), 'valley:glow');
  for (const m of [wallMesh, roofMesh, woodMesh]) if (m) group.add(m);
  if (glowMesh) {
    // Unlit, so it reads as the thing that is glowing rather than a thing being lit.
    glowMesh.material = flat(hex(GLOW));
    glowMesh.visible = false;
    group.add(glowMesh);
  }

  const lampLight = new THREE.PointLight(hex(LAMP), 0, 6, 2);
  lampLight.position.set(lampAt.x, lampAt.y + 0.1, lampAt.z);
  // Never a shadow caster: six extra scene renders, for a lamp on a jetty.
  lampLight.castShadow = false;
  group.add(lampLight);

  /* --------------------------------------------------- the framing tree */
  // At the frame's left edge (reads 34° left at the default pose, where the frame is 37° wide),
  // and near enough that its canopy hangs into the top-left corner over the lake. A shade tree,
  // not a maple: the picnic is a summer hill, and its greens are the rim's and the tufts'.
  const TREE = { x: -4.5, z: 5.5 };
  batch.add({ w: 0.55, h: 3.8, d: 0.55, x: TREE.x, y: 1.9, z: TREE.z }, C.woodDark);
  batch.add({ w: 1.7, h: 0.26, d: 0.26, x: TREE.x - 0.7, y: 3.1, z: TREE.z + 0.2, ry: 0.5, rz: 0.45 }, C.woodDark);
  batch.add({ w: 1.4, h: 0.24, d: 0.24, x: TREE.x + 0.6, y: 2.7, z: TREE.z - 0.3, ry: -0.6, rz: -0.4 }, C.woodDark);
  const cloud: Array<[number, number, number, number, number, number, number]> = [
    // w, h, d, dx, dy, dz, colour (0 = leaf, 1 = leafDark)
    [2.3, 1.0, 2.0, -0.9, 3.9, 0.2, 1], [2.2, 1.0, 1.9, 1.0, 4.0, -0.4, 0], [1.9, 0.9, 1.9, 0.2, 3.6, 1.0, 1],
    [2.8, 1.1, 2.3, 0.0, 4.8, 0.0, 0], [1.9, 0.9, 1.7, -1.4, 5.0, -0.6, 0], [1.8, 0.9, 1.6, 1.5, 5.2, 0.7, 1],
    [2.1, 1.0, 1.8, 0.1, 5.8, 0.3, 0], [1.4, 0.8, 1.3, -0.9, 6.0, 0.6, 0], [1.3, 0.8, 1.1, 0.9, 6.3, -0.5, 0],
    [1.0, 0.7, 0.9, -0.1, 6.7, -0.1, 0], [1.1, 0.7, 0.9, 1.6, 3.2, 1.2, 1], [1.0, 0.6, 0.9, -1.9, 3.4, 0.9, 0],
  ];
  for (const [w, h, d, dx, dy, dz, tone] of cloud) {
    batch.add({ w, h, d, x: TREE.x + dx, y: dy, z: TREE.z + dz }, tone === 0 ? C.leaf : hex(PALETTE.leafDark));
  }
  // A few blossoms on the outside of the canopy, in the blanket's pink so nothing new is spent.
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05;
    batch.add({ w: 0.34, h: 0.3, d: 0.34, x: TREE.x + Math.cos(a) * 1.9, y: 4.2 + (i % 3) * 0.8, z: TREE.z + Math.sin(a) * 1.6 }, C.pink);
  }

  /* -------------------------------------------------------- wildflowers */
  // The saturated thing between the desk and the water, on the hillside r 4.7-8. Stems go in
  // the batch's leafDark; pink and paper heads ride the blanket's colours for nothing; the
  // butter heads (and the straw hat) share one mesh that casts nothing — a 16 cm flower has no
  // shadow worth two draw calls. None of it sits on a furniture slot or a tree.
  const keepClear: Array<[number, number, number]> = [
    [-4.1, -2.6, 1.0], [-2.6, -3.7, 0.9], [-0.2, -3.7, 0.9], // slot anchors on the far side
    [4.0, -2.6, 1.1], [TREE.x, TREE.z, 1.3], [4.7, -3.3, 0.5], // the two trees and the kite spool
  ];
  const butter: BoxSpec[] = [];
  for (let i = 0; i < 90; i++) {
    const theta = 150 + noise(i, 31, 9) * 150;
    const r = 4.7 + noise(i, 32, 9) * 3.3;
    const x = Math.cos(theta * DEG) * r;
    const z = Math.sin(theta * DEG) * r;
    if (keepClear.some(([cx, cz, cr]) => (x - cx) ** 2 + (z - cz) ** 2 < cr * cr)) continue;
    const hh = 0.3 + noise(i, 33, 9) * 0.12;
    batch.add({ w: 0.06, h: hh, d: 0.06, x, y: hh / 2, z }, hex(PALETTE.leafDark));
    const head: BoxSpec = { w: 0.16, h: 0.11, d: 0.16, x, y: hh + 0.04, z, ry: (i % 4) * 0.4 };
    const tone = i % 3;
    if (tone === 0) batch.add(head, C.pink);
    else if (tone === 1) batch.add(head, C.paper);
    else butter.push(head);
  }
  // A straw hat dropped on the blanket, and an open book beside it — the picnic is in progress.
  butter.push({ w: 0.7, h: 0.05, d: 0.7, x: -1.15, y: 0.075, z: 3.05, ry: 0.3 });
  butter.push({ w: 0.4, h: 0.22, d: 0.4, x: -1.15, y: 0.2, z: 3.05, ry: 0.3 });
  batch.addMany(
    [
      { w: 0.42, h: 0.04, d: 0.32, x: -1.95, y: 0.07, z: 0.85, ry: 0.35 },
      { w: 0.42, h: 0.04, d: 0.32, x: -1.55, y: 0.07, z: 0.98, ry: 0.35 },
    ],
    C.paper,
  );
  const butterMesh = mergedBoxes(butter, C.butter);
  if (butterMesh) {
    butterMesh.name = 'valley:flowers';
    butterMesh.castShadow = false;
    group.add(butterMesh);
  }

  /* --------------------------------------------------------------- kite */
  // "Something buzzing past": a pink kite on a string staked by the small tree, flying out over
  // the lake at the top-right of the frame (reads 12° below the frame top, 21° right). String
  // and kite are ONE mesh hung from a pivot at the stake, so the whole thing swings as a rigid
  // pendulum and the string never has to stretch.
  const SPOOL = { x: 4.7, z: -3.3 };
  batch.add({ w: 0.24, h: 0.18, d: 0.24, x: SPOOL.x, y: 0.09, z: SPOOL.z }, C.woodDark);
  const STRING_L = 6.2;
  const kiteSpecs: BoxSpec[] = [
    { w: 0.03, h: STRING_L, d: 0.03, y: STRING_L / 2 },
    { w: 0.78, h: 0.78, d: 0.06, y: STRING_L + 0.42, rz: Math.PI / 4 },
    { w: 0.26, h: 0.1, d: 0.05, x: 0.12, y: STRING_L - 0.15, rz: 0.4 },
    { w: 0.26, h: 0.1, d: 0.05, x: -0.1, y: STRING_L - 0.55, rz: -0.4 },
    { w: 0.26, h: 0.1, d: 0.05, x: 0.14, y: STRING_L - 0.95, rz: 0.5 },
  ];
  const kite = mergedBoxes(kiteSpecs, C.pink)!;
  kite.name = 'valley:kite';
  kite.castShadow = false;
  const kiteRig = new THREE.Group();
  kiteRig.name = 'valley:kite-rig';
  kiteRig.position.set(SPOOL.x, 0.18, SPOOL.z);
  kiteRig.add(kite);
  group.add(kiteRig);
  const UP = new THREE.Vector3(0, 1, 0);
  const kiteDir = new THREE.Vector3();
  const aimKite = (elevDeg: number, azDeg: number, twist: number) => {
    const e = elevDeg * DEG;
    const a = azDeg * DEG;
    kiteDir.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
    kiteRig.quaternion.setFromUnitVectors(UP, kiteDir);
    kiteRig.rotateY(twist);
  };
  aimKite(38, 235, 0);

  /* --------------------------------------------------------------- phase */
  // The valley repaints by the hour the way the garden's canvas does: only when the phase
  // changes, never per frame. It is presented as a Backdrop so the orchestrator drives it with
  // the same setPhase/dispose it already gives the cozy room's paint; `mesh` is the lake, the
  // principal surface. setView is a no-op — the shop's window views mean nothing on a hill.
  let current: DayPhase | null = null;
  const valley: Backdrop = {
    mesh: lake,
    setPhase(phase) {
      if (phase === current) return;
      current = phase;
      const p = VALLEY[phase];
      waterMat.color.set(p.water);
      nearMat.color.set(p.hillNear);
      farMat.color.set(p.hillFar);
      if (glowMesh) glowMesh.visible = phase === 'night' || phase === 'dusk';
    },
    setView() {
      /* nothing to swap: the valley is the view */
    },
    dispose() {
      waterMat.dispose();
      nearMat.dispose();
      farMat.dispose();
    },
  };
  valley.setPhase('afternoon');

  return {
    backdrops: [valley],
    nightLights: [lampLight],
    obstacles: [
      { x: TREE.x, z: TREE.z, r: 0.8 }, // the framing tree
      // The walkable rect's far corner runs out over the reed bank and the water. Four circles
      // along r 9.6 wall it off, overlapping so there is no path between them.
      { x: Math.cos(172 * DEG) * 9.6, z: Math.sin(172 * DEG) * 9.6, r: 1.9 },
      { x: Math.cos(195 * DEG) * 9.6, z: Math.sin(195 * DEG) * 9.6, r: 1.9 },
      { x: Math.cos(215 * DEG) * 9.6, z: Math.sin(215 * DEG) * 9.6, r: 1.9 },
      { x: Math.cos(235 * DEG) * 9.6, z: Math.sin(235 * DEG) * 9.6, r: 1.9 },
    ],
    update(_dt, elapsed, phase, reducedMotion) {
      valley.setPhase(phase);
      if (reducedMotion) {
        aimKite(38, 235, 0);
        return;
      }
      // A slow lift and drift, and a twist about the string — a kite in a lazy wind.
      aimKite(
        38 + Math.sin(elapsed * 0.7) * 4 + Math.sin(elapsed * 1.9) * 1.2,
        235 + Math.sin(elapsed * 0.45) * 6,
        Math.sin(elapsed * 1.3) * 0.28,
      );
    },
  };
}
