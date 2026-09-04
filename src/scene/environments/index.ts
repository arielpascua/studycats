/**
 * The four worlds (spec §12 M4). Each is a floating slab with the same desk cluster on it, so
 * the timer always sits in the same place and only the world around it changes.
 *
 * Everything static is merged per colour by `BoxBatch` — a whole room lands in roughly a dozen
 * draw calls, which is what keeps the ≤300 budget comfortable once eight cats are walking.
 */

import * as THREE from 'three';
import { ENVIRONMENTS, type EnvironmentDef, type EnvironmentId } from '../../data/environments';
import { C, hex, mixHex, PALETTE } from '../../data/palette';
import type { DayPhase } from '../../core/time';
import { BoxBatch, box, boxGeo, disposeTree, flat, mergedBoxes, type BoxSpec } from '../voxel';
import { createLaptop, createMug, createPlant, createWindow, type Laptop, type Mug, type Window } from '../props/desk';
import type { Obstacle } from '../cats/catBrain';
import { buildRoom as buildPartyRoom, roomMetrics, type BuiltRoom } from './room';
import { addLantern, addMaple, addSteppingStones, createBackdrop, createLanternGlow, MOSS, type Backdrop, type GardenView } from '../props/garden';
import { DEFAULT_ROOM, roomEnvDef, type RoomId } from '../../data/rooms';

export interface BuiltEnvironment {
  id: EnvironmentId;
  def: EnvironmentDef;
  group: THREE.Group;
  laptop: Laptop;
  mug: Mug;
  window: Window | null;
  /** Prop bounding circles the cats path around. */
  obstacles: Obstacle[];
  /** Per-environment accent lights, tinted by day phase. */
  accents: THREE.Light[];
  /** Where the fire is, for spark emission. Null when the world has no fire. */
  firePoint: THREE.Vector3 | null;
  /**
   * Present when the world has a painted far distance. The shop's purchasable window views
   * repaint this rather than hanging a plane — there is a doorway where the window used to be.
   */
  setView?(view: GardenView): void;
  /** Present only in a party room: the room, and the shared object the party grows together. */
  party: BuiltRoom | null;
  /** Which party room this is, or null in solo. */
  room: RoomId | null;
  update(dt: number, elapsed: number, phase: DayPhase, reducedMotion: boolean): void;
  dispose(): void;
}

/**
 * Half-extent of the shadow-receiving ground patch. Must stay >= the shadow camera's own
 * orthographic half-extent in world.ts, or the band this exists to remove comes back.
 */
export const SHADOW_HALF = 8;

/**
 * The ground the viewer is standing on.
 *
 * This used to be a floating island: a small slab with a tapered underside, which is what made
 * the scene read as an object on a table. Worse, that underside hung to y = -1.2 and was the
 * single corner that held the camera furthest away. The ground now simply covers the shell, so
 * it runs off the bottom and sides of the frame at every angle.
 */
function buildGround(def: EnvironmentDef, topColor: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'ground';
  const shell = def.shell;

  // The ground is TWO meshes, and the split is not cosmetic.
  //
  // The shadow camera is a tight orthographic box around the play area (world.ts), because that
  // is the only place anything casts. Ground outside that box still samples the shadow map, and
  // at the frustum edge the sampler clamps — which paints a hard dark band right across the
  // far grass. Letting only the inner patch receive shadows removes the band completely and
  // costs nothing: nothing out there was ever going to cast one.
  const outer =
    shell.kind === 'open'
      ? box({ w: shell.groundHalf * 2, h: 0.2, d: shell.groundHalf * 2, y: -0.1 }, topColor)
      : box(
          {
            w: shell.maxX - shell.minX,
            h: 0.2,
            d: shell.maxZ - shell.minZ,
            x: (shell.minX + shell.maxX) / 2,
            y: -0.1,
            z: (shell.minZ + shell.maxZ) / 2,
          },
          topColor,
        );
  outer.castShadow = false;
  outer.receiveShadow = false;
  g.add(outer);

  // Sits a hair proud of the outer ground so the two coplanar quads cannot z-fight.
  const inner = box({ w: SHADOW_HALF * 2.2, h: 0.2, d: SHADOW_HALF * 2.2, y: -0.097 }, topColor);
  inner.castShadow = false;
  inner.receiveShadow = true;
  g.add(inner);

  return g;
}

/**
 * The four walls and the ceiling that put the viewer inside the room.
 *
 * The two FAR walls keep the exact coordinates they always had — inner faces at
 * `shell.minZ + 0.24` and `shell.minX + 0.24` — so the window, shelf, skirting and every
 * furniture slot anchor stay put. Only the near two are new, and they sit behind the eye where
 * they are never actually seen; their job is to guarantee no sky can reach a frame edge.
 *
 * Nothing here casts a shadow. `mergedBoxes` defaults castShadow to true, and a 16-unit wall
 * inside the shadow camera's box draws a hard straight terminator across the middle of the
 * visible floor.
 */
/**
 * A hole in one of the two far walls — the ones the camera actually looks at — for a vista.
 *
 * `wall: 'z'` is the min-z wall (the one you face at the default pose); `from`/`to` are then x.
 * `wall: 'x'` is the min-x wall; `from`/`to` are z. `y0`..`y1` is the vertical extent, so a sill
 * survives below and a lintel above. Openings are cut by emitting MORE boxes into the SAME
 * merged mesh — piers between openings, a sill and a lintel per opening — so a vista costs
 * nothing at the draw-call level. What you build behind the hole is where the calls go.
 */
/**
 * What a world's vista adds. The files under ./vistas/ each export one function of this shape.
 *
 * `batch` is the world's own BoxBatch, handed over BEFORE it is built, so vista boxes in colours
 * the world already uses cost nothing. `group` is for what cannot merge — textured quads, unlit
 * glow cubes, lights. `openings` are cut into the shell walls by buildEnvironment, which is why
 * the walls are built after the world now rather than before it.
 */
export interface VistaContext {
  batch: BoxBatch;
  group: THREE.Group;
  def: EnvironmentDef;
}

export interface VistaResult {
  backdrops: Backdrop[];
  nightLights: THREE.PointLight[];
  obstacles: Obstacle[];
  openings?: WallOpening[];
  update?(dt: number, elapsed: number, phase: DayPhase, reducedMotion: boolean): void;
}

export type VistaHook = (ctx: VistaContext) => VistaResult;

export interface WallOpening {
  wall: 'z' | 'x';
  from: number;
  to: number;
  y0: number;
  y1: number;
}

/**
 * Split a full-height wall running along `a0..a1` into boxes that cover everything EXCEPT the
 * given openings. Returns [alongCentre, alongLength, yCentre, yHeight] tuples in wall-local
 * terms, for the caller to orient.
 */
export function cutWall(a0: number, a1: number, h: number, openings: WallOpening[]): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const sorted = [...openings].sort((p, q) => p.from - q.from);
  let cursor = a0;
  for (const o of sorted) {
    const from = Math.max(a0, Math.min(a1, o.from));
    const to = Math.max(a0, Math.min(a1, o.to));
    if (from > cursor) out.push([(cursor + from) / 2, from - cursor, h / 2, h]);
    if (to > from) {
      if (o.y0 > 0) out.push([(from + to) / 2, to - from, o.y0 / 2, o.y0]);
      if (o.y1 < h) out.push([(from + to) / 2, to - from, (o.y1 + h) / 2, h - o.y1]);
    }
    cursor = Math.max(cursor, to);
  }
  if (cursor < a1) out.push([(cursor + a1) / 2, a1 - cursor, h / 2, h]);
  return out;
}

function buildShellWalls(
  def: EnvironmentDef,
  wallColor: number,
  sideColor: number,
  ceilingColor: number,
  openings: WallOpening[] = [],
): THREE.Group {
  const g = new THREE.Group();
  g.name = 'shell';
  const shell = def.shell;
  if (shell.kind !== 'walls') return g;

  const w = shell.maxX - shell.minX;
  const d = shell.maxZ - shell.minZ;
  const cx = (shell.minX + shell.maxX) / 2;
  const cz = (shell.minZ + shell.maxZ) / 2;
  const h = shell.ceiling;

  const farSpecs: BoxSpec[] = cutWall(shell.minX, shell.maxX, h, openings.filter((o) => o.wall === 'z')).map(
    ([ac, al, yc, yh]) => ({ w: al, h: yh, d: 0.24, x: ac, y: yc, z: shell.minZ + 0.12 }),
  );
  const far = mergedBoxes(farSpecs, wallColor);

  const sideXSpecs: BoxSpec[] = cutWall(shell.minZ, shell.maxZ, h, openings.filter((o) => o.wall === 'x')).map(
    ([ac, al, yc, yh]) => ({ w: 0.24, h: yh, d: al, x: shell.minX + 0.12, y: yc, z: ac }),
  );
  const side = mergedBoxes(
    [
      ...sideXSpecs,
      // The two near walls, behind the viewer.
      { w: 0.24, h, d, x: shell.maxX - 0.12, y: h / 2, z: cz },
      { w, h, d: 0.24, x: cx, y: h / 2, z: shell.maxZ - 0.12 },
    ],
    sideColor,
  );
  const ceiling = mergedBoxes([{ w, h: 0.24, d, x: cx, y: h + 0.12, z: cz }], ceilingColor);

  for (const mesh of [far, side, ceiling]) {
    if (!mesh) continue;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

/** A low ridge at the horizon, so an open world has a silhouette instead of a hard ground edge. */
function buildHorizonRim(def: EnvironmentDef, color: number): THREE.Group | null {
  const g = new THREE.Group();
  g.name = 'rim';
  const shell = def.shell;
  if (shell.kind !== 'open') return null;

  const radius = shell.groundHalf * 0.62;
  const specs: BoxSpec[] = [];
  const segments = 40;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const height = shell.rimHeight * (0.7 + ((i * 7) % 5) * 0.12);
    specs.push({
      w: radius * 0.22,
      h: height,
      d: radius * 0.22,
      x: Math.sin(a) * radius,
      y: height / 2,
      z: Math.cos(a) * radius,
      ry: a,
    });
  }
  const rim = mergedBoxes(specs, color);
  if (!rim) return null;
  rim.castShadow = false;
  rim.receiveShadow = false;
  g.add(rim);
  return g;
}

/** Desk + chair, shared by every world so the timer never moves. */
function buildDesk(batch: BoxBatch): void {
  const wood = C.wood;
  const dark = C.woodDark;
  batch.add({ w: 3.0, h: 0.14, d: 1.5, x: 0.4, y: 1.0, z: -1.5 }, wood);
  batch.addMany(
    [
      { w: 0.16, h: 1.0, d: 0.16, x: -0.9, y: 0.5, z: -0.9 },
      { w: 0.16, h: 1.0, d: 0.16, x: 1.7, y: 0.5, z: -0.9 },
      { w: 0.16, h: 1.0, d: 0.16, x: -0.9, y: 0.5, z: -2.1 },
      { w: 0.16, h: 1.0, d: 0.16, x: 1.7, y: 0.5, z: -2.1 },
    ],
    dark,
  );
  // Chair
  batch.add({ w: 1.0, h: 0.12, d: 1.0, x: 0.4, y: 0.62, z: -0.1 }, wood);
  batch.add({ w: 1.0, h: 0.9, d: 0.12, x: 0.4, y: 1.1, z: 0.4 }, dark);
  batch.addMany(
    [
      { w: 0.1, h: 0.62, d: 0.1, x: -0.02, y: 0.31, z: -0.48 },
      { w: 0.1, h: 0.62, d: 0.1, x: 0.82, y: 0.31, z: -0.48 },
      { w: 0.1, h: 0.62, d: 0.1, x: -0.02, y: 0.31, z: 0.32 },
      { w: 0.1, h: 0.62, d: 0.1, x: 0.82, y: 0.31, z: 0.32 },
    ],
    dark,
  );
}

/* ------------------------------------------------------------------ worlds */

function buildRoom(def: EnvironmentDef): {
  statics: THREE.Group;
  obstacles: Obstacle[];
  windowProp: Window | null;
  lamps: THREE.PointLight[];
  backdrops: Backdrop[];
  nightLights: THREE.PointLight[];
} {
  const batch = new BoxBatch();
  // No reference to def.floor here any more: the room's geometry is the SHELL, and def.floor is
  // now purely the gameplay footprint the cats stay inside.

  // Floorboards
  // Boards run the full length of the shell, not of the play area, or the floor stops in
  // mid-air a couple of metres from the desk.
  const shell = def.shell;
  const boards: BoxSpec[] = [];
  const boardSpan = shell.maxZ - shell.minZ;
  const boardCount = Math.ceil(boardSpan / 0.8);
  for (let i = 0; i < boardCount; i++) {
    boards.push({
      w: shell.maxX - shell.minX - 0.4,
      h: 0.02,
      d: 0.72,
      x: (shell.minX + shell.maxX) / 2,
      y: 0.011,
      z: shell.minZ + 0.5 + i * 0.8,
    });
  }
  batch.addMany(boards, C.woodDark);

  // Skirting along the two FAR walls only — the near two are behind the viewer.
  // Note these use shell.minZ / shell.minX, which evaluate to exactly the old -d/2 and -w/2:
  // the far walls have not moved, so nothing mounted on them moves either.
  // Skirting on the far wall is split around the garden doors, which run to the floor.
  for (const [x0, x1] of [[shell.minX, DOOR_X0 - 0.08], [DOOR_X1 + 0.08, shell.maxX]] as Array<[number, number]>) {
    batch.add({ w: x1 - x0, h: 0.22, d: 0.3, x: (x0 + x1) / 2, y: 0.11, z: shell.minZ + 0.15 }, hex(PALETTE.paper));
  }
  batch.add({
    w: 0.3,
    h: 0.22,
    d: shell.maxZ - shell.minZ,
    x: shell.minX + 0.15,
    y: 0.11,
    z: (shell.minZ + shell.maxZ) / 2,
  }, hex(PALETTE.paper));

  // A shelf with three books
  batch.add({ w: 1.8, h: 0.1, d: 0.4, x: -3.2, y: 2.4, z: shell.minZ + 0.4 }, C.wood);
  batch.addMany(
    [
      { w: 0.16, h: 0.5, d: 0.3, x: -3.8, y: 2.7, z: shell.minZ + 0.4 },
      { w: 0.14, h: 0.42, d: 0.3, x: -3.6, y: 2.66, z: shell.minZ + 0.4 },
      { w: 0.18, h: 0.54, d: 0.3, x: -3.4, y: 2.72, z: shell.minZ + 0.4 },
    ],
    hex(PALETTE.pinkDeep),
  );

  buildDesk(batch);

  /* ---------------------------------------------------------- cosiness */
  //
  // The room shipped as a desk, a plant and a shelf against forty square metres of bare
  // lavender. That is a diorama of a room, not a room. Everything below is BUILT-IN décor —
  // none of it overlaps a purchasable furniture slot (SLOT_ANCHORS: two wall spots on the far
  // wall, three floor spots, the corner, the desk, the window), so the shop still has things to
  // sell into an already-cosy space rather than being the only source of cosiness.

  // A desk lamp at the free end of the desk. The warm point light it carries is the single
  // biggest change in the room at night: without it the scene is lit only by a cold key and
  // the laptop's screen.
  const lampX = -0.62;
  const lampZ = -1.9;
  batch.addMany(
    [
      { w: 0.3, h: 0.06, d: 0.3, x: lampX, y: 1.1, z: lampZ },
      { w: 0.06, h: 0.6, d: 0.06, x: lampX, y: 1.43, z: lampZ },
    ],
    hex(PALETTE.ink),
  );

  /* -------------------------------------------------------- the garden doors */
  //
  // The one big beautiful thing you look through the room at. The wall you face has a floor-to-
  // lintel opening with two sliding door leaves parked at its edges, and behind it a real
  // garden: moss, a stone path, a lantern, two maples, and a painted far distance closing it.
  // The opening itself is cut in buildShellWalls at zero draw-call cost; everything here is the
  // frame and what stands beyond it.
  const face = shell.minZ + 0.24; // the far wall's inner face
  // Posts and lintel.
  batch.addMany(
    [
      { w: 0.16, h: DOOR_Y1 + 0.25, d: 0.3, x: DOOR_X0 - 0.08, y: (DOOR_Y1 + 0.25) / 2, z: face - 0.05 },
      { w: 0.16, h: DOOR_Y1 + 0.25, d: 0.3, x: DOOR_X1 + 0.08, y: (DOOR_Y1 + 0.25) / 2, z: face - 0.05 },
      { w: DOOR_X1 - DOOR_X0 + 0.32, h: 0.2, d: 0.3, x: (DOOR_X0 + DOOR_X1) / 2, y: DOOR_Y1 + 0.1, z: face - 0.05 },
    ],
    C.woodDark,
  );
  // Two sliding leaves, parked open at the edges: a wood frame with a muntin grid, paper panes.
  for (const [x0, x1] of [[DOOR_X0, DOOR_X0 + 1.0], [DOOR_X1 - 1.0, DOOR_X1]] as Array<[number, number]>) {
    const cx = (x0 + x1) / 2;
    batch.add({ w: 1.0, h: DOOR_Y1, d: 0.06, x: cx, y: DOOR_Y1 / 2, z: face - 0.14 }, hex(PALETTE.paper));
    batch.addMany(
      [
        { w: 0.08, h: DOOR_Y1, d: 0.1, x: x0 + 0.04, y: DOOR_Y1 / 2, z: face - 0.14 },
        { w: 0.08, h: DOOR_Y1, d: 0.1, x: x1 - 0.04, y: DOOR_Y1 / 2, z: face - 0.14 },
        { w: 1.0, h: 0.08, d: 0.1, x: cx, y: 0.04, z: face - 0.14 },
        { w: 1.0, h: 0.08, d: 0.1, x: cx, y: DOOR_Y1 - 0.04, z: face - 0.14 },
        { w: 0.05, h: DOOR_Y1, d: 0.08, x: cx, y: DOOR_Y1 / 2, z: face - 0.14 },
      ],
      C.wood,
    );
    for (let i = 1; i < 6; i++) {
      batch.add({ w: 1.0, h: 0.05, d: 0.08, x: cx, y: (DOOR_Y1 / 6) * i, z: face - 0.14 }, C.wood);
    }
  }
  // A wooden step down onto the garden, flush with the floor.
  batch.add({ w: DOOR_X1 - DOOR_X0 + 0.3, h: 0.12, d: 0.9, x: (DOOR_X0 + DOOR_X1) / 2, y: 0.06, z: shell.minZ - 0.45 }, C.wood);

  // A cat bed by the side wall: a soft base with a raised rim. Cats that wander to it look like
  // they meant to; cats that do not still leave the room looking lived in.
  const bedX = -4.5;
  const bedZ = 3.6;
  batch.add({ w: 1.0, h: 0.12, d: 1.0, x: bedX, y: 0.06, z: bedZ }, hex(PALETTE.pinkDeep));
  batch.add({ w: 0.8, h: 0.06, d: 0.8, x: bedX, y: 0.14, z: bedZ }, hex(PALETTE.rug));
  batch.addMany(
    [
      { w: 1.0, h: 0.26, d: 0.16, x: bedX, y: 0.13, z: bedZ - 0.42 },
      { w: 1.0, h: 0.26, d: 0.16, x: bedX, y: 0.13, z: bedZ + 0.42 },
      { w: 0.16, h: 0.26, d: 0.7, x: bedX - 0.42, y: 0.13, z: bedZ },
    ],
    hex(PALETTE.pinkDeep),
  );

  // A wall clock and a small framed picture on the side wall, which had nothing on it at all.
  const sideX = shell.minX + 0.36;
  batch.add({ w: 0.12, h: 0.66, d: 0.66, x: sideX, y: 2.55, z: 1.1 }, hex(PALETTE.paper));
  batch.add({ w: 0.14, h: 0.22, d: 0.06, x: sideX + 0.02, y: 2.64, z: 1.1 }, hex(PALETTE.ink));
  batch.add({ w: 0.14, h: 0.06, d: 0.18, x: sideX + 0.02, y: 2.55, z: 1.17 }, hex(PALETTE.ink));
  batch.add({ w: 0.12, h: 0.9, d: 0.72, x: sideX, y: 1.95, z: 3.2 }, hex(PALETTE.mint));
  batch.add({ w: 0.08, h: 0.66, d: 0.5, x: sideX + 0.04, y: 1.95, z: 3.2 }, hex(PALETTE.butter));
  batch.add({ w: 0.06, h: 0.18, d: 0.18, x: sideX + 0.06, y: 2.05, z: 3.1 }, hex(PALETTE.peach));

  // A tall bookcase on the side wall, which had nothing on it and filled the left half of the
  // default frame with flat lavender. Spines in the room's own palette so it belongs here.
  const bcX = shell.minX + 0.5;
  const bcZ = 0.2;
  batch.addMany(
    [
      { w: 0.5, h: 4.2, d: 0.12, x: bcX, y: 2.1, z: bcZ - 1.14 },
      { w: 0.5, h: 4.2, d: 0.12, x: bcX, y: 2.1, z: bcZ + 1.14 },
      { w: 0.5, h: 0.12, d: 2.4, x: bcX, y: 4.2, z: bcZ },
    ],
    C.woodDark,
  );
  const spineColours = [PALETTE.pinkDeep, PALETTE.lavDeep, PALETTE.mint, PALETTE.butter, PALETTE.peach, PALETTE.ink];
  for (let shelfIdx = 0; shelfIdx < 4; shelfIdx++) {
    const y = 0.5 + shelfIdx * 0.95;
    batch.add({ w: 0.5, h: 0.08, d: 2.3, x: bcX, y, z: bcZ }, C.wood);
    let z = bcZ - 1.05;
    let i = 0;
    while (z < bcZ + 1.0) {
      const w = 0.12 + ((i * 7 + shelfIdx * 3) % 3) * 0.05;
      const h = 0.5 + ((i * 5 + shelfIdx) % 4) * 0.08;
      batch.add({ w: 0.36, h, d: w, x: bcX + 0.04, y: y + 0.04 + h / 2, z: z + w / 2 }, hex(spineColours[(i + shelfIdx) % spineColours.length]));
      z += w + 0.02;
      i++;
    }
  }

  // A stack of books on the floor, the way books actually end up.
  batch.addMany(
    [
      { w: 0.5, h: 0.09, d: 0.36, x: -4.75, y: 0.045, z: -0.4 },
      { w: 0.44, h: 0.09, d: 0.32, x: -4.72, y: 0.135, z: -0.36, ry: 0.15 },
      { w: 0.46, h: 0.08, d: 0.34, x: -4.78, y: 0.22, z: -0.42, ry: -0.1 },
    ],
    hex(PALETTE.lavDeep),
  );

  /* ------------------------------------------------------------ the garden */
  // Moss, proud of the wooden shadow patch that already runs behind the wall so no floorboard
  // ever shows through the doorway. Wider than the opening: at azimuth 270 the look-through
  // angle is steep and the eye sees a long way sideways.
  batch.add({ w: 13, h: 0.12, d: 2.6, x: 1.6, y: 0.06, z: shell.minZ - 1.5 }, hex(MOSS));
  addSteppingStones(batch, { x: 3.1, z: shell.minZ - 0.9 }, { x: 2.4, z: shell.minZ - 2.2 }, 3);
  const flameAt = addLantern(batch, 2.6, shell.minZ - 1.35);
  addMaple(batch, 4.6, shell.minZ - 1.25, 1.15);
  addMaple(batch, 0.95, shell.minZ - 1.6, 1.0);
  addMaple(batch, -1.4, shell.minZ - 2.0, 0.8);

  /* ------------------------------------------------------------ the clutter */
  // The reference's study spot is crowded with small true things at the cat's own height.
  const tray = { x: 2.9, z: -2.3 };
  batch.add({ w: 0.9, h: 0.06, d: 0.6, x: tray.x, y: 0.03, z: tray.z, ry: 0.15 }, C.wood);
  batch.addMany(
    [
      { w: 0.28, h: 0.22, d: 0.28, x: tray.x - 0.2, y: 0.17, z: tray.z, ry: 0.15 }, // teapot body
      { w: 0.08, h: 0.06, d: 0.08, x: tray.x - 0.2, y: 0.31, z: tray.z }, // lid knob
      { w: 0.14, h: 0.14, d: 0.14, x: tray.x + 0.16, y: 0.13, z: tray.z - 0.14 }, // cup
      { w: 0.14, h: 0.14, d: 0.14, x: tray.x + 0.2, y: 0.13, z: tray.z + 0.14 }, // cup
    ],
    hex(PALETTE.mint),
  );
  batch.add({ w: 0.24, h: 0.05, d: 0.24, x: tray.x - 0.02, y: 0.085, z: tray.z + 0.2 }, hex(PALETTE.paper));
  batch.add({ w: 0.62, h: 0.16, d: 0.62, x: -1.9, y: 0.08, z: 1.8, ry: 0.3 }, hex(PALETTE.pinkDeep)); // floor cushion
  batch.addMany(
    [
      { w: 0.42, h: 0.04, d: 0.32, x: -0.55, y: 1.09, z: -1.15, ry: -0.35 }, // open notebook on the desk
      { w: 0.42, h: 0.04, d: 0.32, x: -0.18, y: 1.09, z: -1.02, ry: -0.35 },
    ],
    hex(PALETTE.paper),
  );
  batch.add({ w: 0.3, h: 0.03, d: 0.03, x: -0.05, y: 1.12, z: -0.85, ry: 0.5 }, hex(PALETTE.ink)); // pen
  for (let i = 0; i < 3; i++) { // sticky notes below the print slot
    batch.add({ w: 0.2, h: 0.2, d: 0.02, x: -0.9 + i * 0.28, y: 1.72, z: face - 0.02, ry: 0 }, hex([PALETTE.butter, PALETTE.pink, PALETTE.mint][i]));
  }

  const statics = batch.build('room');

  // The lantern's flame and light. The light is off by day and comes up at dusk: the garden is
  // the saturated thing in daylight, and at night the room's lamps take over while the garden
  // goes cool — this one warm point out there is what stops it going dead.
  const glow = createLanternGlow(flameAt);
  statics.add(glow.flame, glow.light);

  // A string of paper lanterns along the lintel, outside. Unlit, so they read as glowing.
  const string = mergedBoxes(
    Array.from({ length: 5 }, (_, i) => ({ w: 0.22, h: 0.28, d: 0.22, x: DOOR_X0 + 0.5 + i * 1.05, y: DOOR_Y1 - 0.35, z: shell.minZ - 0.7 })),
    hex('#FFF4D6'),
  );
  if (string) {
    string.material = flat(hex('#FFF4D6'));
    string.castShadow = false;
    statics.add(string);
  }

  // The painted far distance, as an L: a back plane, and a return on the left that catches the
  // rays from azimuth 250-270, which look through the doorway at a steep angle and would
  // otherwise reach past the back plane's edge to raw background.
  const back = createBackdrop(13, 5.6, 0);
  back.mesh.position.set(1.6, 2.8, shell.minZ - 2.9);
  statics.add(back.mesh);
  const ret = createBackdrop(3.0, 5.6, 1);
  ret.mesh.position.set(-0.85, 2.8, shell.minZ - 1.45);
  ret.mesh.rotation.y = Math.PI / 2;
  statics.add(ret.mesh);

  // The lampshade is unlit so it reads as the thing that is glowing, not a thing being lit.
  const shade = new THREE.Mesh(boxGeo(0.46, 0.24, 0.46), flat(hex(PALETTE.peach)));
  shade.position.set(lampX, 1.8, lampZ);
  shade.castShadow = false;
  statics.add(shade);

  const lampLight = new THREE.PointLight(hex('#FFC98A'), 1.7, 6.5, 2);
  lampLight.position.set(lampX, 1.72, lampZ);
  // Not a shadow caster: a point-light shadow is six extra scene renders, for a table lamp.
  lampLight.castShadow = false;
  statics.add(lampLight);

  // No window prop: the wall it hung on is a doorway now. See setView for what the shop's
  // window views do instead.
  const windowProp: Window | null = null;

  const plant = createPlant(PALETTE.leaf, PALETTE.rug);
  plant.position.set(-4.2, 0, -2.2);
  statics.add(plant);

  return {
    statics,
    obstacles: [
      { x: 0.4, z: -1.5, r: 1.5 }, // desk
      { x: 0.4, z: 0.15, r: 0.7 }, // chair
      { x: -4.2, z: -2.2, r: 0.5 }, // plant
      { x: bedX, z: bedZ, r: 0.6 }, // cat bed
      { x: -4.75, z: -0.4, r: 0.35 }, // books
      { x: shell.minX + 0.5, z: 0.2, r: 0.7 }, // bookcase
      { x: tray.x, z: tray.z, r: 0.55 }, // tea tray
      { x: -1.9, z: 1.8, r: 0.4 }, // floor cushion
    ],
    windowProp,
    lamps: [lampLight],
    backdrops: [back, ret],
    nightLights: [glow.light],
  };
}

/**
 * Each solo world's vista, by id. A world with no entry simply has no far thing yet. The cozy
 * room's is built into buildRoom itself because it also reshapes the room; these three are
 * additive and live in ./vistas/.
 */
const VISTAS: Partial<Record<EnvironmentId, VistaHook>> = {};

/** The garden doors' opening in the cozy room's far wall. Floor to lintel, so a cat can sit on the sill. */
const DOOR_X0 = 0.5;
const DOOR_X1 = 5.7;
const DOOR_Y1 = 3.4;

function buildPicnic(def: EnvironmentDef, vista?: VistaHook): { statics: THREE.Group; obstacles: Obstacle[]; vista: VistaResult | undefined } {
  const batch = new BoxBatch();

  // Tufts of taller grass scattered around the edge
  const tufts: BoxSpec[] = [];
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2;
    const r = 3.6 + ((i * 7) % 5) * 0.35;
    tufts.push({ w: 0.14, h: 0.26 + ((i * 3) % 4) * 0.08, d: 0.14, x: Math.sin(a) * r, y: 0.13, z: Math.cos(a) * r * 0.8 });
  }
  batch.addMany(tufts, hex(PALETTE.leafDark));

  // Checked blanket
  const checks: BoxSpec[] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if ((r + c) % 2 === 0) continue;
      checks.push({ w: 0.56, h: 0.02, d: 0.56, x: -1.7 + c * 0.6, y: 0.035, z: 0.6 + r * 0.6 });
    }
  }
  batch.add({ w: 3.2, h: 0.03, d: 3.2, x: -0.5, y: 0.02, z: 1.8 }, hex(PALETTE.paper));
  batch.addMany(checks, hex(PALETTE.pink));

  // Basket
  batch.add({ w: 0.8, h: 0.5, d: 0.6, x: -2.6, y: 0.25, z: 2.2 }, C.wood);
  batch.add({ w: 0.84, h: 0.1, d: 0.64, x: -2.6, y: 0.52, z: 2.2 }, C.woodDark);

  buildDesk(batch);
  // The vista adds to the batch before it is built, so its boxes merge for free.
  const vistaGroup = new THREE.Group();
  vistaGroup.name = 'vista';
  const vistaOut = vista?.({ batch, group: vistaGroup, def });
  const statics = batch.build('picnic');
  statics.add(vistaGroup);

  // A little tree at the back
  const treeTrunk = box({ w: 0.42, h: 2.4, d: 0.42, x: 4.0, y: 1.2, z: -2.6 }, C.woodDark);
  const canopy = mergedBoxes(
    [
      { w: 2.2, h: 0.9, d: 2.0, y: 2.7 },
      { w: 1.5, h: 0.8, d: 1.4, y: 3.3, x: 0.2 },
    ],
    C.leaf,
  )!;
  canopy.position.set(4.0, 0, -2.6);
  statics.add(treeTrunk, canopy);

  return {
    statics,
    vista: vistaOut,
    obstacles: [
      ...(vistaOut?.obstacles ?? []),
      { x: 0.4, z: -1.5, r: 1.5 },
      { x: 0.4, z: 0.15, r: 0.7 },
      { x: 4.0, z: -2.6, r: 0.7 },
      { x: -2.6, z: 2.2, r: 0.5 },
    ],
  };
}

function buildBonfire(def: EnvironmentDef, vista?: VistaHook): { statics: THREE.Group; obstacles: Obstacle[]; fire: THREE.Group; firePoint: THREE.Vector3; vista: VistaResult | undefined } {
  const batch = new BoxBatch();

  const ground: BoxSpec[] = [];
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    ground.push({ w: 0.4, h: 0.1, d: 0.4, x: Math.sin(a) * (3.8 + (i % 3) * 0.4), y: 0.05, z: Math.cos(a) * (3.2 + (i % 4) * 0.3) });
  }
  batch.addMany(ground, hex(PALETTE.stone));

  // Fire ring
  const ring: BoxSpec[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ring.push({ w: 0.32, h: 0.22, d: 0.32, x: -2.4 + Math.sin(a) * 0.95, y: 0.11, z: 1.8 + Math.cos(a) * 0.95, ry: a });
  }
  batch.addMany(ring, hex(PALETTE.stone));

  // Sitting logs
  batch.addMany(
    [
      { w: 1.8, h: 0.36, d: 0.36, x: -2.4, y: 0.18, z: 3.4 },
      { w: 0.36, h: 0.36, d: 1.6, x: -4.3, y: 0.18, z: 1.6, ry: 0.2 },
    ],
    C.woodDark,
  );

  buildDesk(batch);
  // The vista adds to the batch before it is built, so its boxes merge for free.
  const vistaGroup = new THREE.Group();
  vistaGroup.name = 'vista';
  const vistaOut = vista?.({ batch, group: vistaGroup, def });
  const statics = batch.build('bonfire');
  statics.add(vistaGroup);

  // The fire itself: three stacked, animated boxes with an unlit core.
  const fire = new THREE.Group();
  fire.name = 'fire';
  fire.position.set(-2.4, 0, 1.8);
  const logs = mergedBoxes(
    [
      { w: 0.9, h: 0.2, d: 0.2, y: 0.12, rz: 0.1 },
      { w: 0.2, h: 0.2, d: 0.9, y: 0.12, rz: -0.1 },
    ],
    C.woodDark,
  )!;
  fire.add(logs);
  const flames: THREE.Mesh[] = [];
  const flameSpecs = [
    { s: 0.5, y: 0.42, c: hex(PALETTE.ember) },
    { s: 0.34, y: 0.72, c: hex(PALETTE.emberHot) },
    { s: 0.2, y: 0.95, c: hex(PALETTE.butter) },
  ];
  for (const f of flameSpecs) {
    const m = new THREE.Mesh(boxGeo(f.s, f.s, f.s), flat(f.c));
    m.position.y = f.y;
    m.castShadow = false;
    fire.add(m);
    flames.push(m);
  }
  (fire as THREE.Group & { flames: THREE.Mesh[] }).flames = flames;
  statics.add(fire);

  // Marshmallow on a stick, leaning on a log — the bonfire's signature detail.
  const stick = new THREE.Group();
  stick.position.set(-3.5, 0.36, 2.7);
  stick.rotation.z = -0.5;
  stick.rotation.y = 0.6;
  const rod = box({ w: 0.05, h: 1.4, d: 0.05, y: 0.7 }, C.woodDark);
  const mallow = box({ w: 0.16, h: 0.16, d: 0.16, y: 1.42 }, hex(PALETTE.cream));
  stick.add(rod, mallow);
  stick.name = 'marshmallowStick';
  statics.add(stick);

  return {
    statics,
    fire,
    firePoint: new THREE.Vector3(-2.4, 0.6, 1.8),
    vista: vistaOut,
    obstacles: [
      ...(vistaOut?.obstacles ?? []),
      { x: 0.4, z: -1.5, r: 1.5 },
      { x: 0.4, z: 0.15, r: 0.7 },
      { x: -2.4, z: 1.8, r: 1.1 },
      { x: -2.4, z: 3.4, r: 0.6 },
    ],
  };
}

function buildCafe(def: EnvironmentDef, vista?: VistaHook): { statics: THREE.Group; obstacles: Obstacle[]; windowProp: Window; lamps: THREE.PointLight[]; vista: VistaResult | undefined } {
  const batch = new BoxBatch();

  // Chequerboard café floor
  const shell = def.shell;
  const tiles: BoxSpec[] = [];
  const cols = Math.ceil((shell.maxX - shell.minX) / 1.0);
  const rows = Math.ceil((shell.maxZ - shell.minZ) / 0.95);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 === 0) continue;
      tiles.push({ w: 0.9, h: 0.02, d: 0.9, x: shell.minX + 0.6 + c * 1.0, y: 0.012, z: shell.minZ + 0.6 + r * 0.95 });
    }
  }
  batch.addMany(tiles, hex(PALETTE.paper2));

  batch.add({
    w: shell.maxX - shell.minX,
    h: 0.3,
    d: 0.32,
    x: (shell.minX + shell.maxX) / 2,
    y: 1.0,
    z: shell.minZ + 0.18,
  }, C.wood);

  // Counter + cups
  batch.add({ w: 2.6, h: 1.05, d: 0.8, x: -3.6, y: 0.52, z: -2.4 }, C.woodDark);
  batch.add({ w: 2.7, h: 0.1, d: 0.9, x: -3.6, y: 1.08, z: -2.4 }, C.wood);
  batch.addMany(
    [
      { w: 0.18, h: 0.2, d: 0.18, x: -4.3, y: 1.23, z: -2.4 },
      { w: 0.18, h: 0.2, d: 0.18, x: -4.05, y: 1.23, z: -2.5 },
      { w: 0.18, h: 0.2, d: 0.18, x: -3.8, y: 1.23, z: -2.35 },
    ],
    hex(PALETTE.paper),
  );

  buildDesk(batch);
  // The vista adds to the batch before it is built, so its boxes merge for free.
  const vistaGroup = new THREE.Group();
  vistaGroup.name = 'vista';
  const vistaOut = vista?.({ batch, group: vistaGroup, def });
  const statics = batch.build('cafe');
  statics.add(vistaGroup);

  const windowProp = createWindow('city');
  windowProp.group.position.set(2.4, 0, shell.minZ + 0.26);
  statics.add(windowProp.group);

  // Two warm pendant lamps
  const lamps: THREE.PointLight[] = [];
  for (const x of [-1.6, 3.0]) {
    const shade = box({ w: 0.6, h: 0.3, d: 0.6, y: 3.0 }, hex(PALETTE.peach));
    shade.position.x = x;
    shade.position.z = -1.0;
    const cord = box({ w: 0.05, h: 1.0, d: 0.05, y: 3.6 }, hex(PALETTE.ink));
    cord.position.x = x;
    cord.position.z = -1.0;
    statics.add(shade, cord);

    const light = new THREE.PointLight(hex(PALETTE.peach), 2.2, 7, 2);
    light.position.set(x, 2.75, -1.0);
    statics.add(light);
    lamps.push(light);
  }

  return {
    statics,
    windowProp,
    lamps,
    vista: vistaOut,
    obstacles: [
      ...(vistaOut?.obstacles ?? []),
      { x: 0.4, z: -1.5, r: 1.5 },
      { x: 0.4, z: 0.15, r: 0.7 },
      { x: -3.6, z: -2.4, r: 1.3 },
    ],
  };
}

/* ------------------------------------------------------------------ assembly */

export interface BuildOptions {
  /** Party size, for the arena. Ignored by the solo worlds. */
  memberCount?: number;
  /** Ring radius, for the arena. Ignored by the solo worlds. */
  radius?: number;
  /** Which party room to build. Ignored by the solo worlds. */
  room?: RoomId | string;
}

export function buildEnvironment(id: EnvironmentId, options: BuildOptions = {}): BuiltEnvironment {
  if (id === 'arena') return buildPartyEnvironment(options);

  const def = ENVIRONMENTS[id];
  const group = new THREE.Group();
  group.name = `env:${id}`;

  const groundColor =
    id === 'picnic' ? C.grass : id === 'bonfire' ? hex(PALETTE.soil) : hex(PALETTE.wood);
  group.add(buildGround(def, groundColor));

  if (def.shell.kind !== 'walls') {
    const rim = buildHorizonRim(def, id === 'bonfire' ? hex('#4E4374') : hex(PALETTE.leafDark));
    if (rim) group.add(rim);
  }

  let obstacles: Obstacle[] = [];
  let vistaOut: VistaResult | undefined;
  // Openings the world wants cut into its shell. The cozy room's garden doors are built into
  // buildRoom; the other worlds' come from their vista, which is why the walls are built AFTER
  // the switch below.
  let openings: WallOpening[] = id === 'room' ? [{ wall: 'z', from: DOOR_X0, to: DOOR_X1, y0: 0, y1: DOOR_Y1 }] : [];
  let windowProp: Window | null = null;
  let backdrops: Backdrop[] = [];
  let nightLights: THREE.PointLight[] = [];
  let firePoint: THREE.Vector3 | null = null;
  let fireGroup: (THREE.Group & { flames?: THREE.Mesh[] }) | null = null;
  const accents: THREE.Light[] = [];

  switch (id) {
    case 'picnic': {
      const built = buildPicnic(def, VISTAS.picnic);
      group.add(built.statics);
      obstacles = built.obstacles;
      vistaOut = built.vista;
      break;
    }
    case 'bonfire': {
      const built = buildBonfire(def, VISTAS.bonfire);
      group.add(built.statics);
      obstacles = built.obstacles;
      vistaOut = built.vista;
      firePoint = built.firePoint;
      fireGroup = built.fire as THREE.Group & { flames?: THREE.Mesh[] };
      const fireLight = new THREE.PointLight(hex(PALETTE.ember), 3.4, 11, 2);
      fireLight.position.copy(built.firePoint);
      // NOT a shadow caster. A point-light shadow is a cube map — six extra renders of every
      // caster near the fire — and with eight cats that alone put the bonfire over the 300-call
      // budget. The key light still casts, so the cats keep their grounding shadows; what goes is
      // the fire's own flicker-shadow on the logs, which nobody looking at the picture can tell.
      fireLight.castShadow = false;
      group.add(fireLight);
      accents.push(fireLight);
      break;
    }
    case 'cafe': {
      const built = buildCafe(def, VISTAS.cafe);
      group.add(built.statics);
      obstacles = built.obstacles;
      windowProp = built.windowProp;
      accents.push(...built.lamps);
      vistaOut = built.vista;
      break;
    }
    case 'room':
    default: {
      const built = buildRoom(def);
      group.add(built.statics);
      obstacles = built.obstacles;
      windowProp = built.windowProp;
      accents.push(...built.lamps);
      backdrops = built.backdrops;
      nightLights = built.nightLights;
      break;
    }
  }

  if (vistaOut) {
    backdrops = [...backdrops, ...vistaOut.backdrops];
    nightLights = [...nightLights, ...vistaOut.nightLights];
    if (vistaOut.openings) openings = [...openings, ...vistaOut.openings];
  }

  if (def.shell.kind === 'walls') {
    group.add(
      buildShellWalls(
        def,
        hex(id === 'cafe' ? PALETTE.woodDark : PALETTE.lav),
        hex(id === 'cafe' ? PALETTE.wood : PALETTE.lavDeep),
        hex(id === 'cafe' ? PALETTE.paper2 : PALETTE.paper),
        openings,
      ),
    );
  }

  const laptop = createLaptop();
  laptop.group.position.set(0.35, 1.07, -1.55);
  laptop.group.rotation.y = 0.06;
  group.add(laptop.group);
  accents.push(laptop.light);

  const mug = createMug();
  mug.group.position.set(1.45, 1.07, -1.15);
  group.add(mug.group);

  let flicker = 0;

  return {
    id,
    def,
    group,
    laptop,
    mug,
    window: windowProp,
    obstacles,
    accents,
    firePoint,
    party: null,
    room: null,
    setView: backdrops.length > 0 ? (view) => { for (const b of backdrops) b.setView(view); } : undefined,
    update(dt, elapsed, phase, reducedMotion) {
      laptop.update(dt, elapsed, reducedMotion);
      mug.update(dt, reducedMotion);

      if (windowProp) {
        const sky = def.sky[phase];
        const night = phase === 'night' || phase === 'dusk';
        windowProp.setSky(night ? mixHex(sky, PALETTE.night, 0.35) : sky, phase === 'night');
      }
      // The painted far distance follows the clock: six repaints a day, none per frame. The
      // garden lantern comes up at dusk and is the only warm point outside after dark.
      for (const b of backdrops) b.setPhase(phase);
      const dark = phase === 'night' || phase === 'dusk';
      for (const l of nightLights) l.intensity = dark ? 1.05 : 0;
      vistaOut?.update?.(dt, elapsed, phase, reducedMotion);

      if (fireGroup?.flames) {
        flicker += dt;
        const flames = fireGroup.flames;
        for (let i = 0; i < flames.length; i++) {
          const s = reducedMotion ? 1 : 1 + Math.sin(flicker * (7 + i * 2.3) + i) * 0.16;
          flames[i].scale.set(s, 1 + (s - 1) * 1.8, s);
          flames[i].rotation.y = reducedMotion ? 0 : Math.sin(flicker * 2 + i) * 0.3;
        }
        const light = accents[0];
        if (light instanceof THREE.PointLight) {
          light.intensity = reducedMotion ? 3.2 : 3.0 + Math.sin(flicker * 11) * 0.5 + Math.sin(flicker * 4.3) * 0.35;
        }
      }
    },
    dispose() {
      for (const b of backdrops) b.dispose();
      disposeTree(group);
    },
  };
}


/**
 * A party room, presented through the same interface as every other world.
 *
 * The shared timer still needs somewhere to live, so the laptop stands on a side table against
 * the wall the party is facing rather than being deleted: it keeps the clock legible *in the
 * room*, and every code path that draws the timer keeps working unchanged in multiplayer.
 */
function buildPartyEnvironment(options: BuildOptions): BuiltEnvironment {
  const roomId = options.room ?? DEFAULT_ROOM;
  const memberCount = Math.max(2, Math.min(8, options.memberCount ?? 2));
  const { seats } = roomMetrics(roomId, memberCount);
  const def = roomEnvDef(roomId, memberCount, seats);

  const group = new THREE.Group();
  group.name = `env:party:${roomId}`;

  const room = buildPartyRoom(roomId, memberCount);
  group.add(room.group);

  // A side table with the shared laptop on it, at the anchor the room chose. The laptop's screen
  // faces +z in its own space, so aiming it at the party means pointing it at the origin.
  const anchor = room.timerAnchor;
  const stand = mergedBoxes(
    [
      { w: 1.3, h: 0.7, d: 0.9, x: anchor.x, y: 0.35, z: anchor.z },
      { w: 1.44, h: 0.1, d: 1.02, x: anchor.x, y: 0.74, z: anchor.z },
    ],
    hex(room.room === 'museum' ? '#8E86A0' : C.woodDark === undefined ? '#5E4636' : '#5E4636'),
  );
  if (stand) {
    stand.receiveShadow = true;
    group.add(stand);
  }

  const laptop = createLaptop();
  laptop.group.position.set(anchor.x, 0.79, anchor.z);
  laptop.group.rotation.y = Math.atan2(-anchor.x, -anchor.z);
  group.add(laptop.group);

  const mug = createMug(PALETTE.paper, PALETTE.mint);
  mug.group.position.set(anchor.x - 0.62, 0.79, anchor.z + 0.24);
  group.add(mug.group);

  const obstacles: Obstacle[] = [
    ...room.obstacles,
    { x: anchor.x, z: anchor.z, r: 1.0 },
  ];

  return {
    id: 'arena',
    def,
    group,
    laptop,
    mug,
    window: null,
    obstacles,
    accents: [room.hearthLight, room.keyLight, laptop.light],
    firePoint: room.firePoint,
    party: room,
    room: room.room,
    update(dt, elapsed, _phase, reducedMotion) {
      laptop.update(dt, elapsed, reducedMotion);
      mug.update(dt, reducedMotion);
      room.update(dt, elapsed, reducedMotion);
    },
    dispose() {
      room.dispose();
      disposeTree(group);
    },
  };
}
