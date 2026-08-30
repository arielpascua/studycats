/**
 * THE PARTY ROOMS — rectangular interiors you are standing inside.
 *
 * This replaces the circular arena, which was one disc reskinned per venue and therefore made
 * the library and the museum the same picture in different colours. A room here is a real place:
 * a reading table between high shelves, desks facing a chalkboard, a long table under a screen,
 * benches in front of a lit case.
 *
 * ## The chassis is shared, the furniture is not
 *
 * Floor, walls, dado, trim, ceiling and lighting are built once for every room from values in
 * `data/rooms.ts`. Only `furnish()` differs, and that is where a room earns its name. This is
 * the middle ground between five hand-built scenes (five chances to get the party scaling wrong)
 * and one skeleton in five palettes (what we just deleted).
 *
 * ## Everything is sized from where people sit
 *
 * `seatLayout()` reports the half-extent of the seated party and `roomSize()` turns that into a
 * floor, a focus volume and a shell. Nothing in this file invents a room dimension, so a room
 * grows when somebody joins because there is nowhere for it to *not* grow.
 *
 * ## Which walls you actually see
 *
 * The camera arc is 180-270 degrees, which puts the eye at POSITIVE x and z looking back toward
 * the origin. So the walls in shot are the ones at MIN x and MIN z — that is where the shelves,
 * the chalkboard, the screen and the pictures go. The +x/+z walls exist only so nothing shows
 * background, and are pushed out past the eye's own limit where they are never seen.
 */

import * as THREE from 'three';
import { hex } from '../../data/palette';
import { BONFIRE_STAGES } from '../../core/party';
import { seatLayout } from '../../core/seating';
import { CLASSROOM_COLUMNS, ROOM_LID, ROOM_MAX_XZ, roomDef, roomSize, type RoomId, type RoomTheme } from '../../data/rooms';
import type { Obstacle } from '../cats/catBrain';
import { BoxBatch, boxGeo, canvasTexture, flat, toonGradient, type BoxSpec } from '../voxel';

export interface BuiltRoom {
  group: THREE.Group;
  room: RoomId;
  /** The room's own key light. The only shadow caster — see the note where it is created. */
  keyLight: THREE.DirectionalLight;
  /** The warm centre: the growing shared object. */
  hearthLight: THREE.PointLight;
  firePoint: THREE.Vector3;
  /** Furniture the cats must path around. */
  obstacles: Obstacle[];
  /** Where the shared timer should stand, in front of the wall everyone is facing. */
  timerAnchor: { x: number; z: number; facing: number };
  setStage(stage: number, into: number): void;
  update(dt: number, elapsed: number, reducedMotion: boolean): void;
  dispose(): void;
}

/** How far past the eye's limit the far walls stand, so the room has floor beyond the furniture. */
const WALL_MARGIN = 2.0;

/**
 * Wall slabs are this thick, and a wall at `wallZ` therefore has its INNER, VISIBLE face at
 * `wallZ + WALL_THICK`.
 *
 * Everything hung on a wall must be placed against that face, not against `wallZ`. Getting this
 * wrong is not subtle-looking: a board placed at `wallZ + 0.2` is buried *inside* the plaster,
 * and one whose front lands exactly on `wallZ + 0.3` is coplanar with the wall and z-fights,
 * which renders as a stippled dither crawling over the whole surface. Both shipped once.
 */
const WALL_THICK = 0.3;

/** Mount a slab of thickness `d` on a wall face, standing `out` proud of it. */
function mount(face: number, d: number, out = 0.02): number {
  return face + out + d / 2;
}

/** The five tiers of the shared hearth: box size and height. */
const TIERS: Array<{ s: number; y: number; flat?: number }> = [
  { s: 0.74, y: 1.02, flat: 0.42 },
  { s: 0.62, y: 1.44, flat: 0.42 },
  { s: 0.5, y: 1.8, flat: 0.42 },
  { s: 0.38, y: 2.1, flat: 0.42 },
  { s: 0.28, y: 2.34, flat: 0.5 },
];

/* ------------------------------------------------------------------ helpers */

/** A run of books/box-files along a shelf, cycling colours so it reads as spines, not paint. */
function spines(
  batch: BoxBatch,
  colours: readonly string[],
  from: number,
  to: number,
  y: number,
  z: number,
  axis: 'x' | 'z',
  depth: number,
): void {
  const width = 0.17;
  const count = Math.max(1, Math.floor((to - from) / width));
  for (let i = 0; i < count; i++) {
    const at = from + (i + 0.5) * width;
    const h = 0.34 + ((i * 7) % 3) * 0.07;
    const spec: BoxSpec =
      axis === 'x'
        ? { w: width * 0.86, h, d: depth, x: at, y: y + h / 2, z }
        : { w: depth, h, d: width * 0.86, x: z, y: y + h / 2, z: at };
    batch.add(spec, hex(colours[i % colours.length]));
  }
}

/**
 * The canvas inside a museum frame, painted in code.
 *
 * These are the one place in the game that wanted real pictures. They are drawn rather than
 * imported for the same reason every other texture here is: the project ships no raster assets,
 * so there is nothing to 404, nothing to license and nothing to keep in sync with the palette.
 * Each painting is a horizon, a few bands and one simple subject, seeded by index so the wing
 * looks curated rather than random and looks the same every time you walk in.
 */
const PAINTINGS: Array<{ sky: string; land: string; accent: string; subject: 'sun' | 'peaks' | 'moon' | 'grove' }> = [
  { sky: '#E8C9C0', land: '#7A4E52', accent: '#C97A98', subject: 'sun' },
  { sky: '#CFE0E8', land: '#3E5A66', accent: '#7FA9C4', subject: 'peaks' },
  { sky: '#D8E0C8', land: '#4E6446', accent: '#8FA97F', subject: 'grove' },
  { sky: '#E4DCC4', land: '#6E5A3E', accent: '#D9A26B', subject: 'moon' },
];

function paintingTexture(index: number): THREE.CanvasTexture {
  const p = PAINTINGS[index % PAINTINGS.length];
  return canvasTexture(96, 120, (ctx) => {
    const w = 96;
    const h = 120;
    const horizon = Math.round(h * 0.62);

    ctx.fillStyle = p.sky;
    ctx.fillRect(0, 0, w, horizon);

    // The subject sits on the horizon so every painting shares a composition and the four read
    // as one collection.
    ctx.fillStyle = p.accent;
    if (p.subject === 'sun' || p.subject === 'moon') {
      const r = p.subject === 'sun' ? 15 : 11;
      const cy = horizon - 34;
      for (let y = -r; y <= r; y++) {
        const span = Math.round(Math.sqrt(r * r - y * y));
        ctx.fillRect(w / 2 - span, cy + y, span * 2, 1);
      }
    } else if (p.subject === 'peaks') {
      for (const [cx, height] of [[30, 42], [62, 30]] as Array<[number, number]>) {
        for (let y = 0; y < height; y++) {
          const half = Math.round((y / height) * 22);
          ctx.fillRect(cx - half, horizon - height + y, half * 2, 1);
        }
      }
    } else {
      for (const [cx, top] of [[26, 30], [48, 44], [70, 34]] as Array<[number, number]>) {
        ctx.fillRect(cx - 2, horizon - top, 4, top);
        ctx.fillRect(cx - 10, horizon - top - 12, 20, 16);
      }
    }

    ctx.fillStyle = p.land;
    ctx.fillRect(0, horizon, w, h - horizon);
    // Two paler bands in the foreground: a field, and enough tonal separation that the lower
    // half is not one dead rectangle.
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(0, horizon + 10, w, 6);
    ctx.fillRect(0, horizon + 26, w, 4);
    ctx.globalAlpha = 1;
  });
}


/* ---------------------------------------------------------------- furniture */

interface FurnishContext {
  batch: BoxBatch;
  group: THREE.Group;
  theme: RoomTheme;
  seats: ReturnType<typeof seatLayout>;
  /** Far wall planes — the ones in shot. */
  wallX: number;
  wallZ: number;
  /** The visible INNER faces of those walls. Hang things on these, never on wallX/wallZ. */
  faceX: number;
  faceZ: number;
  halfX: number;
  halfZ: number;
  obstacles: Obstacle[];
  /** Anything a furnishing allocates itself and must therefore free. */
  disposables: Array<{ dispose(): void }>;
}

function furnishLibrary(c: FurnishContext): void {
  const { batch, theme, seats, halfZ } = c;

  // A rug under the whole group. Without it the near floor is a large empty deck, and the party
  // reads as standing on a plain rather than gathered around something.
  batch.add({ w: 5.4, h: 0.06, d: halfZ * 2 + 3.4, x: 0, y: 0.03, z: 0 }, hex('#6E3E44'));
  batch.add({ w: 4.6, h: 0.07, d: halfZ * 2 + 2.6, x: 0, y: 0.04, z: 0 }, hex('#7E4A50'));

  // The reading table the party sits around, running along z between the two columns of chairs.
  const tableLen = halfZ * 2 + 0.6;
  batch.addMany(
    [
      { w: 1.5, h: 0.14, d: tableLen, y: 0.72 },
      { w: 1.62, h: 0.06, d: tableLen + 0.12, y: 0.79 },
    ],
    hex(theme.wood),
  );
  for (const sz of [-1, 1]) {
    batch.add({ w: 0.2, h: 0.72, d: 0.2, x: 0, y: 0.36, z: sz * (tableLen / 2 - 0.4) }, hex(theme.woodDark));
  }
  c.obstacles.push({ x: 0, z: 0, r: Math.max(1.1, tableLen * 0.42) });

  // A chair behind every cushion, backs outward.
  for (const seat of seats.seats) {
    const outward = Math.sign(seat.x) || 1;
    batch.addMany(
      [
        { w: 0.5, h: 0.08, d: 0.5, x: seat.x + outward * 0.16, y: 0.44, z: seat.z },
        { w: 0.1, h: 0.62, d: 0.5, x: seat.x + outward * 0.4, y: 0.72, z: seat.z },
      ],
      hex(theme.woodDark),
    );
  }

  // Wall of shelves on both visible walls, with real spines.
  const books = ['#C4707E', '#E0BE8C', '#7FA9C4', '#8FA97F', '#B08AC0', '#D9A26B', '#6E8FA8'];
  for (let shelf = 0; shelf < 5; shelf++) {
    const y = 0.6 + shelf * 1.05;
    batch.add({ w: Math.abs(c.wallX) * 2 + 8, h: 0.1, d: 0.5, x: 0, y, z: c.wallZ + 0.3 }, hex(theme.woodDark));
    spines(batch, books, c.wallX + 0.6, ROOM_MAX_XZ - 6, y + 0.05, c.wallZ + 0.3, 'x', 0.44);

    batch.add({ w: 0.5, h: 0.1, d: Math.abs(c.wallZ) * 2 + 8, x: c.wallX + 0.3, y, z: 0 }, hex(theme.woodDark));
    spines(batch, books, c.wallZ + 0.6, ROOM_MAX_XZ - 6, y + 0.05, c.wallX + 0.3, 'z', 0.44);
  }

  // A second reading table further into the room, unoccupied. The camera cannot come closer
  // than it does — the seating test proves every smaller room crops — so the near floor is in
  // shot regardless, and the honest fix is to furnish it rather than shrink the room.
  const fz = halfZ + 5.0;
  batch.addMany(
    [
      { w: 1.4, h: 0.14, d: 3.0, x: -1.2, y: 0.72, z: fz },
      { w: 1.52, h: 0.06, d: 3.12, x: -1.2, y: 0.79, z: fz },
    ],
    hex(theme.wood),
  );
  for (const sz of [-1, 1]) {
    batch.add({ w: 0.18, h: 0.72, d: 0.18, x: -1.2, y: 0.36, z: fz + sz * 1.1 }, hex(theme.woodDark));
    for (const sx of [-1, 1]) {
      batch.addMany(
        [
          { w: 0.5, h: 0.08, d: 0.5, x: -1.2 + sx * 1.2, y: 0.44, z: fz + sz * 0.7 },
          { w: 0.1, h: 0.62, d: 0.5, x: -1.2 + sx * 1.46, y: 0.72, z: fz + sz * 0.7 },
        ],
        hex(theme.woodDark),
      );
    }
  }
  c.obstacles.push({ x: -1.2, z: fz, r: 1.4 });

  // A rolling ladder against the shelves — the one shape that says "library" on its own.
  const lx = c.wallX + 0.9;
  batch.addMany(
    [
      { w: 0.1, h: 5.2, d: 0.1, x: lx, y: 2.6, z: -1.2 },
      { w: 0.1, h: 5.2, d: 0.1, x: lx, y: 2.6, z: -2.0 },
    ],
    hex(theme.woodDark),
  );
  for (let i = 0; i < 8; i++) {
    batch.add({ w: 0.12, h: 0.07, d: 0.8, x: lx, y: 0.5 + i * 0.6, z: -1.6 }, hex(theme.wood));
  }
}

function furnishClassroom(c: FurnishContext): void {
  const { batch, theme, seats } = c;

  // A desk in front of every cat, with a book slot under the top.
  for (const seat of seats.seats) {
    batch.addMany(
      [
        { w: 0.86, h: 0.08, d: 0.6, x: seat.x, y: 0.68, z: seat.z - 0.62 },
        { w: 0.8, h: 0.06, d: 0.5, x: seat.x, y: 0.48, z: seat.z - 0.62 },
      ],
      hex(theme.wood),
    );
    for (const sx of [-1, 1]) {
      batch.add({ w: 0.07, h: 0.66, d: 0.07, x: seat.x + sx * 0.36, y: 0.33, z: seat.z - 0.62 }, hex(theme.woodDark));
    }
    batch.add({ w: 0.46, h: 0.08, d: 0.44, x: seat.x, y: 0.42, z: seat.z + 0.3 }, hex(theme.seatA));
    c.obstacles.push({ x: seat.x, z: seat.z - 0.62, r: 0.5 });
  }

  // The chalkboard fills the wall everyone is facing, with a tray and a ledge of erasers.
  const boardW = Math.min(10, Math.abs(c.wallX) * 2 + 4);
  batch.add({ w: boardW + 0.4, h: 2.6, d: 0.12, x: 0, y: 2.3, z: mount(c.faceZ, 0.12) }, hex(theme.woodDark));
  batch.add({ w: boardW, h: 2.2, d: 0.06, x: 0, y: 2.3, z: mount(c.faceZ, 0.06, 0.14) }, hex('#2E4A3E'));
  batch.add({ w: boardW + 0.4, h: 0.12, d: 0.3, x: 0, y: 1.1, z: mount(c.faceZ, 0.3, 0.02) }, hex(theme.wood));
  for (let i = 0; i < 5; i++) {
    batch.add({ w: 0.24, h: 0.1, d: 0.16, x: -boardW / 2 + 0.6 + i * 0.7, y: 1.22, z: mount(c.faceZ, 0.16, 0.12) }, hex('#F6F1E2'));
  }

  // Rows of EMPTY desks behind the party, toward the viewer.
  //
  // The room has to be large — the camera physically cannot frame eight cats in a walled
  // interior from any closer, which the seating test proves by failing at every smaller size.
  // So the near floor is going to be in shot no matter what, and the honest fix is furniture
  // rather than a smaller room: a classroom with three desks in an empty hall reads as a
  // mistake, and a classroom with twenty desks reads as a classroom.
  const cols = CLASSROOM_COLUMNS + 2;
  for (let row = 0; row < 4; row++) {
    const z = c.halfZ + 1.4 + row * 1.5;
    for (let col = 0; col < cols; col++) {
      const x = (col - (cols - 1) / 2) * 1.5;
      batch.addMany(
        [
          { w: 0.86, h: 0.08, d: 0.6, x, y: 0.68, z: z - 0.62 },
          { w: 0.8, h: 0.06, d: 0.5, x, y: 0.48, z: z - 0.62 },
        ],
        hex(theme.wood),
      );
      for (const sx of [-1, 1]) {
        batch.add({ w: 0.07, h: 0.66, d: 0.07, x: x + sx * 0.36, y: 0.33, z: z - 0.62 }, hex(theme.woodDark));
      }
      batch.add({ w: 0.46, h: 0.08, d: 0.44, x, y: 0.42, z: z + 0.3 }, hex(theme.seatA));
      c.obstacles.push({ x, z: z - 0.62, r: 0.5 });
    }
  }

  // The teacher's desk, off to one side so it never blocks the party.
  const tx = -Math.abs(c.wallX) + 2.2;
  batch.addMany(
    [
      { w: 1.9, h: 0.12, d: 0.9, x: tx, y: 0.78, z: c.wallZ + 1.7 },
      { w: 1.7, h: 0.66, d: 0.7, x: tx, y: 0.39, z: c.wallZ + 1.7 },
    ],
    hex(theme.wood),
  );
  c.obstacles.push({ x: tx, z: c.wallZ + 1.7, r: 1.1 });

  // A clock above the board — the detail that makes a room a classroom.
  batch.add({ w: 0.62, h: 0.62, d: 0.12, x: 0, y: 4.1, z: mount(c.faceZ, 0.12) }, hex('#F6F1E2'));
  batch.add({ w: 0.06, h: 0.22, d: 0.1, x: 0, y: 4.19, z: mount(c.faceZ, 0.1, 0.14) }, hex(theme.woodDark));
  batch.add({ w: 0.18, h: 0.06, d: 0.1, x: 0.06, y: 4.1, z: mount(c.faceZ, 0.1, 0.14) }, hex(theme.woodDark));
}

function furnishConference(c: FurnishContext): void {
  const { batch, theme, seats, halfX } = c;

  // One long table running along x, the party down both sides.
  const tableLen = halfX * 2 + 0.8;
  batch.addMany(
    [
      { w: tableLen, h: 0.12, d: 1.6, y: 0.74 },
      { w: tableLen + 0.14, h: 0.06, d: 1.72, y: 0.81 },
    ],
    hex(theme.wood),
  );
  batch.add({ w: tableLen * 0.5, h: 0.6, d: 0.5, y: 0.4 }, hex(theme.woodDark));
  c.obstacles.push({ x: 0, z: 0, r: Math.max(1.2, tableLen * 0.4) });

  // Office chairs: a seat, a tall back, and a post down to a base.
  for (const seat of seats.seats) {
    const outward = Math.sign(seat.z) || 1;
    batch.addMany(
      [
        { w: 0.52, h: 0.1, d: 0.52, x: seat.x, y: 0.46, z: seat.z + outward * 0.18 },
        { w: 0.52, h: 0.72, d: 0.1, x: seat.x, y: 0.86, z: seat.z + outward * 0.44 },
      ],
      hex(theme.seatB),
    );
    batch.add({ w: 0.1, h: 0.4, d: 0.1, x: seat.x, y: 0.22, z: seat.z + outward * 0.18 }, hex(theme.woodDark));
    batch.add({ w: 0.46, h: 0.06, d: 0.46, x: seat.x, y: 0.05, z: seat.z + outward * 0.18 }, hex(theme.woodDark));
  }

  // The screen everyone pretends to read, and a whiteboard beside it.
  const screenW = Math.min(7.5, Math.abs(c.wallX) * 2 + 3);
  batch.add({ w: screenW + 0.3, h: 3.0, d: 0.14, x: 0, y: 2.6, z: mount(c.faceZ, 0.14) }, hex('#1A1E2E'));
  batch.add({ w: screenW, h: 2.7, d: 0.06, x: 0, y: 2.6, z: mount(c.faceZ, 0.06, 0.16) }, hex('#2E4A7A'));
  // The whiteboard hangs on the -x wall, so it must be thin in X and wide in Z. It was authored
  // the other way round and rendered as a sliver seen edge-on.
  batch.add({ w: 0.1, h: 2.0, d: 3.2, x: mount(c.faceX, 0.1), y: 2.3, z: -1.4 }, hex('#F6F6F2'));

  // Spare chairs pushed back from the table and a plant in the corner. A meeting room with
  // exactly as many chairs as people reads as a diorama; a real one has extras.
  for (let i = 0; i < 4; i++) {
    const x = -2.4 + i * 1.6;
    const z = halfX * 0 + c.halfZ + 3.4;
    batch.addMany(
      [
        { w: 0.52, h: 0.1, d: 0.52, x, y: 0.46, z },
        { w: 0.52, h: 0.72, d: 0.1, x, y: 0.86, z: z + 0.26 },
      ],
      hex(theme.seatB),
    );
    batch.add({ w: 0.1, h: 0.4, d: 0.1, x, y: 0.22, z }, hex(theme.woodDark));
    batch.add({ w: 0.46, h: 0.06, d: 0.46, x, y: 0.05, z }, hex(theme.woodDark));
  }
  const px = -halfX - 2.6;
  batch.add({ w: 0.6, h: 0.7, d: 0.6, x: px, y: 0.35, z: 1.2 }, hex('#7A5240'));
  batch.addMany(
    [
      { w: 0.28, h: 1.1, d: 0.28, x: px, y: 1.2, z: 1.2 },
      { w: 1.0, h: 0.3, d: 1.0, x: px, y: 1.8, z: 1.2 },
      { w: 0.7, h: 0.3, d: 0.7, x: px, y: 2.05, z: 1.2 },
    ],
    hex('#4E7A5A'),
  );

  // A credenza along the near-ish wall with a row of glasses on it.
  const cz = Math.abs(c.wallZ) - 1.0;
  batch.add({ w: 3.4, h: 0.9, d: 0.7, x: c.wallX + 0.6, y: 0.45, z: cz }, hex(theme.woodDark));
  for (let i = 0; i < 6; i++) {
    batch.add({ w: 0.14, h: 0.22, d: 0.14, x: c.wallX + 0.6 - 1.4 + i * 0.56, y: 1.01, z: cz }, hex('#CFE0F0'));
  }
}

function furnishMuseum(c: FurnishContext): void {
  const { batch, theme, seats } = c;

  // Benches: a slab on two plinths, no backs, facing the case.
  for (const seat of seats.seats) {
    batch.add({ w: 1.2, h: 0.12, d: 0.5, x: seat.x, y: 0.44, z: seat.z + 0.1 }, hex(theme.wood));
    for (const sx of [-1, 1]) {
      batch.add({ w: 0.16, h: 0.44, d: 0.4, x: seat.x + sx * 0.44, y: 0.22, z: seat.z + 0.1 }, hex(theme.woodDark));
    }
  }

  // A colonnade standing proud of the visible walls.
  for (let i = 0; i < 5; i++) {
    const z = c.wallZ + 2.2 + i * 3.4;
    if (z > ROOM_MAX_XZ - 4) break;
    batch.addMany(
      [
        { w: 1.0, h: 0.4, d: 1.0, x: c.wallX + 1.1, y: 0.2, z },
        { w: 0.78, h: 9.0, d: 0.78, x: c.wallX + 1.1, y: 4.7, z },
        { w: 1.05, h: 0.45, d: 1.05, x: c.wallX + 1.1, y: 9.4, z },
      ],
      hex(theme.trim),
    );
  }

  // Framed pictures on the wall everyone is facing. The frame merges into the batch; the canvas
  // is its own mesh because it carries a texture and cannot merge with flat colour.
  for (let i = 0; i < 4; i++) {
    const x = -3.6 + i * 2.4;
    batch.add({ w: 1.7, h: 2.1, d: 0.12, x, y: 3.0, z: mount(c.faceZ, 0.12) }, hex(theme.woodDark));

    const tex = paintingTexture(i);
    const canvasMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.44, 1.84),
      new THREE.MeshToonMaterial({ map: tex, gradientMap: toonGradient() }),
    );
    canvasMesh.position.set(x, 3.0, mount(c.faceZ, 0, 0.15));
    canvasMesh.castShadow = false;
    canvasMesh.receiveShadow = false;
    c.group.add(canvasMesh);
    c.disposables.push(tex, canvasMesh.geometry, canvasMesh.material as THREE.Material);
  }

  // More of the gallery: small plinths with their own pieces, receding toward the viewer. A
  // wing with a single case in it reads as an empty room, not a museum.
  const pieces = ['#C97A98', '#7FA9C4', '#D9A26B'];
  for (let i = 0; i < 3; i++) {
    const z = c.halfZ + 3.0 + i * 3.0;
    const x = i % 2 === 0 ? -2.6 : 2.6;
    batch.addMany(
      [
        { w: 1.1, h: 0.14, d: 1.1, x, y: 0.07, z },
        { w: 0.85, h: 1.05, d: 0.85, x, y: 0.6, z },
        { w: 1.0, h: 0.1, d: 1.0, x, y: 1.17, z },
      ],
      hex(theme.wood),
    );
    batch.add({ w: 0.44, h: 0.5, d: 0.44, x, y: 1.47, z }, hex(pieces[i % pieces.length]));
    c.obstacles.push({ x, z, r: 0.8 });
  }

  // Velvet rope around the case in the middle.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const rx = Math.sin(a) * 2.0;
    const rz = Math.cos(a) * 2.0;
    batch.add({ w: 0.1, h: 0.62, d: 0.1, x: rx, y: 0.31, z: rz }, hex(theme.trim));
    batch.add({ w: 0.16, h: 0.1, d: 0.16, x: rx, y: 0.65, z: rz }, hex('#B08A4E'));
  }
  c.obstacles.push({ x: 0, z: 0, r: 1.5 });
}

const FURNISH: Record<RoomId, (c: FurnishContext) => void> = {
  library: furnishLibrary,
  classroom: furnishClassroom,
  conference: furnishConference,
  museum: furnishMuseum,
};

/* ------------------------------------------------------------------ builder */

export function buildRoom(roomId: RoomId | string, memberCount: number): BuiltRoom {
  const def = roomDef(roomId);
  const theme = def.theme;
  const seats = seatLayout(memberCount, def.plan);
  const size = roomSize(seats.halfX, seats.halfZ);

  const group = new THREE.Group();
  group.name = `room:${def.id}`;

  // The walls you SEE stand a little beyond the eye's own limit, so there is floor past the
  // furniture rather than a wall pressed against the back of the last chair.
  const wallX = size.shell.minX - WALL_MARGIN;
  const wallZ = size.shell.minZ - WALL_MARGIN;
  // The walls you do NOT see are pushed past the eye's cap purely so nothing shows background.
  const nearX = ROOM_MAX_XZ + 1;
  const nearZ = ROOM_MAX_XZ + 1;

  const width = nearX - wallX;
  const depth = nearZ - wallZ;
  const cx = (wallX + nearX) / 2;
  const cz = (wallZ + nearZ) / 2;

  const batch = new BoxBatch();

  /* -------------------------------------------------------------- the floor */

  // Boards, alternating, running along z. Two colours rather than one flat sheet: a single
  // colour reads as a plane, and a plane reads as a diorama base rather than a floor.
  const boards = Math.ceil(width / theme.floorPitch);
  for (let i = 0; i < boards; i++) {
    const x = wallX + (i + 0.5) * theme.floorPitch;
    batch.add(
      { w: theme.floorPitch * 0.97, h: 0.4, d: depth, x, y: -0.2, z: cz },
      hex(i % 2 === 0 ? theme.floorA : theme.floorB),
    );
  }

  /* --------------------------------------------------------------- the walls */

  const lidY = ROOM_LID;
  // Lower band lit, upper band dark. The room then reads as having a normal, human ceiling
  // height even though the actual lid is far above, out of frame and out of the eye's reach.
  for (const [yFrom, yTo, colour] of [
    [0, theme.dadoY, theme.wallLow],
    [theme.dadoY, lidY, theme.wallHigh],
  ] as Array<[number, number, string]>) {
    const h = yTo - yFrom;
    const y = yFrom + h / 2;
    batch.addMany(
      [
        { w: width, h, d: WALL_THICK, x: cx, y, z: wallZ + WALL_THICK / 2 },
        { w: WALL_THICK, h, d: depth, x: wallX + WALL_THICK / 2, y, z: cz },
        { w: width, h, d: WALL_THICK, x: cx, y, z: nearZ - WALL_THICK / 2 },
        { w: WALL_THICK, h, d: depth, x: nearX - WALL_THICK / 2, y, z: cz },
      ],
      hex(colour),
    );
  }

  // Skirting and a dado rail, so the wall is not one undivided slab.
  batch.addMany(
    [
      { w: width, h: 0.34, d: 0.42, x: cx, y: 0.17, z: wallZ + 0.21 },
      { w: 0.42, h: 0.34, d: depth, x: wallX + 0.21, y: 0.17, z: cz },
      { w: width, h: 0.16, d: 0.4, x: cx, y: theme.dadoY, z: wallZ + 0.2 },
      { w: 0.4, h: 0.16, d: depth, x: wallX + 0.2, y: theme.dadoY, z: cz },
    ],
    hex(theme.trim),
  );

  // The lid. It exists to stop the eye seeing background over the walls; the room's perceived
  // ceiling is the dark upper band, not this.
  batch.add({ w: width, h: 0.4, d: depth, x: cx, y: lidY, z: cz }, hex(theme.wallHigh));

  /* ------------------------------------------------------------- furniture */

  const obstacles: Obstacle[] = [];
  const disposables: Array<{ dispose(): void }> = [];
  FURNISH[def.id]({
    batch,
    group,
    theme,
    seats,
    wallX,
    wallZ,
    faceX: wallX + WALL_THICK,
    faceZ: wallZ + WALL_THICK,
    halfX: seats.halfX,
    halfZ: seats.halfZ,
    obstacles,
    disposables,
  });

  // Cushions last, so they sit on top of whatever seating the room built.
  for (const seat of seats.seats) {
    batch.add({ w: 0.66, h: 0.12, d: 0.66, x: seat.x, y: 0.55, z: seat.z, ry: seat.facing }, hex(theme.seatA));
    batch.add({ w: 0.54, h: 0.06, d: 0.54, x: seat.x, y: 0.63, z: seat.z, ry: seat.facing }, hex(theme.seatB));
  }

  const statics = batch.build(`room-${def.id}`);
  statics.receiveShadow = true;
  group.add(statics);

  /* ---------------------------------------------------------------- hearth */

  const firePoint = new THREE.Vector3(0, 1.1, 0);
  const tiers: THREE.Mesh[] = [];
  for (let i = 0; i < TIERS.length; i++) {
    const f = TIERS[i];
    const h = f.flat ? f.s * f.flat : f.s;
    const mesh = new THREE.Mesh(boxGeo(f.s, h, f.s), flat(hex(theme.hearth.tiers[i])));
    mesh.position.set(0, f.y, 0);
    mesh.castShadow = false;
    mesh.visible = false;
    group.add(mesh);
    tiers.push(mesh);
  }

  const hearthLight = new THREE.PointLight(hex(theme.hearth.light), 2.4, theme.hearth.reach + 5, 2);
  hearthLight.position.copy(firePoint);
  // Never a shadow caster: a PointLight shadow is a cube map, i.e. six extra renders of the whole
  // room, which measured as most of a 294-call frame on its own. The key casts; this only lights.
  hearthLight.castShadow = false;
  group.add(hearthLight);

  /* ----------------------------------------------------------------- light */

  const keyLight = new THREE.DirectionalLight(hex(theme.key.color), theme.key.intensity);
  keyLight.position.set(...theme.key.position);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.camera.near = 1;
  keyLight.shadow.camera.far = 60;
  const shadowHalf = Math.max(9, seats.halfX + seats.halfZ + 5);
  keyLight.shadow.camera.left = -shadowHalf;
  keyLight.shadow.camera.right = shadowHalf;
  keyLight.shadow.camera.top = shadowHalf;
  keyLight.shadow.camera.bottom = -shadowHalf;
  keyLight.shadow.camera.updateProjectionMatrix();
  keyLight.shadow.bias = -0.0016;
  keyLight.shadow.normalBias = 0.03;
  group.add(keyLight);
  group.add(keyLight.target);

  /* ------------------------------------------------------------- behaviour */

  let stage = 0;
  let into = 0;
  let clock = 0;

  return {
    group,
    room: def.id,
    keyLight,
    hearthLight,
    firePoint,
    obstacles,
    // The timer stands against the wall everyone faces, just off to the side of the hearth so it
    // never hides it.
    timerAnchor: { x: seats.halfX + 1.0, z: wallZ + 1.2, facing: 0 },

    setStage(nextStage, nextInto) {
      stage = Math.max(0, Math.min(BONFIRE_STAGES, Math.round(nextStage)));
      into = Math.max(0, Math.min(1, nextInto));
      for (let i = 0; i < tiers.length; i++) {
        // The tier being earned fades in, so progress shows between stages rather than only at
        // the moment one completes.
        tiers[i].visible = i < stage || (i === stage && into > 0.15);
      }
    },

    update(dt, _elapsed, reducedMotion) {
      clock += dt;
      const lit = Math.max(0.35, stage + into);
      for (let i = 0; i < tiers.length; i++) {
        if (!tiers[i].visible) continue;
        const base = i === stage ? 0.35 + into * 0.65 : 1;
        tiers[i].scale.setScalar(base);
      }
      hearthLight.distance = theme.hearth.reach + lit * 2.4;
      // A lamp breathes; it does not flicker like a campfire. Reduced motion holds it steady.
      hearthLight.intensity = reducedMotion ? 1.4 + lit * 0.7 : 1.4 + lit * 0.7 + Math.sin(clock * 1.3) * 0.12;
    },

    dispose() {
      // Textures and per-room geometry are NOT shared through the voxel caches, so nothing else
      // will free them when the room is swapped.
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

/** Exposed so the environment wrapper and the camera agree on the room's size. */
export function roomMetrics(roomId: RoomId | string, memberCount: number) {
  const def = roomDef(roomId);
  const seats = seatLayout(memberCount, def.plan);
  return { seats, size: roomSize(seats.halfX, seats.halfZ) };
}
