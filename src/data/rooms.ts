/**
 * THE PARTY ROOMS — actual places, not one disc in five palettes.
 *
 * Party mode used to be a circular island reskinned per venue, which is why the library and the
 * museum looked like the same scene wearing different colours. A room here is a rectangular
 * interior with real furniture: a reading table between high shelves, desks facing a board, a
 * long table under a screen, benches in front of a lit case.
 *
 * ## Everything is derived from where people sit
 *
 * A room does not declare its size. `seatLayout()` (core/seating.ts) reports the half-extent of
 * the seated party, and the floor, the camera's focus volume, the shell the eye is clamped to
 * and the walkable area all fall out of that number. So a room grows when someone joins because
 * there is nowhere for it to *not* grow — the growth is written once, here, instead of once per
 * room.
 *
 * ## The numbers were measured, not chosen
 *
 * A walled interior is harder to shoot than the old open island: the shell clamps the eye, so it
 * cannot simply back away until everyone fits. `PITCH`, `SEAT_OFFSET`, `CLASSROOM_COLUMNS` and
 * `FURNITURE_MARGIN` are all set by sweeping the real camera rig over every legal pose, party
 * size and aspect ratio and shrinking until nothing crops — see tests/seating.test.ts, which
 * imports these very constants and fails if anyone nudges them. Portrait at eight members is the
 * binding case and it is not close; treat every number below as load-bearing.
 */

import { seatLayout, type SeatPlanSpec } from '../core/seating';
import type { EnvironmentDef } from './environments';
import type { DayPhase } from '../core/time';

/**
 * Distance between same-side neighbours along a run. Members advance half of this, alternating
 * sides, so this is also the width of a two-person "bay" of table.
 *
 * 1.4 is the largest value that keeps an eight-cat party in frame on a phone. 1.5 crops.
 */
export const PITCH = 1.4;

/** Half the width of a table, plus the gap from its edge to the middle of a cushion. */
export const SEAT_OFFSET = 1.05;

/** Desks per row in the classroom before wrapping to the row behind. Four crops in portrait. */
export const CLASSROOM_COLUMNS = 3;

/**
 * Breathing room around the seated party in the camera's focus volume.
 *
 * This is NOT "fit all the furniture in shot" — the shelves, the board and the walls are
 * allowed to run off the edges, and should. It is the margin that stops the shot being tight on
 * the cats' whiskers. 1.6 crops at eight in portrait; 1.1 does not.
 */
export const FURNITURE_MARGIN = 1.1;

/**
 * The eye's caps, shared by every room.
 *
 * `shell.height` is the camera rig's vertical limit and a room's drawn ceiling must sit ABOVE
 * it — when a venue drew a lid at the eye's own height the rig climbed above it during break
 * framing and rendered the room from the roof, which is a black screen. `ROOM_LID` is where the
 * ceiling slab actually goes, and tests assert the gap.
 */
export const ROOM_MAX_XZ = 21.5;
export const ROOM_CEILING = 16.2;
export const ROOM_LID = 17.4;

export type RoomId = 'library' | 'classroom' | 'conference' | 'museum';

/**
 * A room's look. Only values — the builder is shared, so a room is its palette, its wall
 * treatment, its furniture kit and its light, and nothing structural.
 */
export interface RoomTheme {
  /** Floorboards / tiles / marble, alternating so the floor is not one flat sheet. */
  floorA: string;
  floorB: string;
  /** Board width in world units; 0.9 is a floorboard, 2.2 is a marble slab. */
  floorPitch: number;
  /** The lower, lit part of the walls, and the darker part above it. */
  wallLow: string;
  wallHigh: string;
  /** Skirting / dado rail / cornice trim. */
  trim: string;
  /** Where the lit band stops and the dark upper wall begins. */
  dadoY: number;
  /** The main furniture body (table, desks, benches) and its accent. */
  wood: string;
  woodDark: string;
  /** Seat cushions. */
  seatA: string;
  seatB: string;
  key: { color: string; intensity: number; position: [number, number, number] };
  ambient: { color: string; intensity: number };
  /** Backdrop behind any window/door opening — never the raw sky. */
  sky: string;
  hearth: {
    /** What the shared, growing object is called, in the panel and in toasts. */
    name: string;
    /** Five colours, bottom tier first. */
    tiers: [string, string, string, string, string];
    light: string;
    reach: number;
  };
}

export interface RoomDef {
  id: RoomId;
  label: string;
  blurb: string;
  icon: string;
  price: number;
  ambience: 'room' | 'birds' | 'fire' | 'cafe';
  snacks: readonly string[];
  /** Where the party sits, and therefore how big the room is. */
  plan: SeatPlanSpec;
  theme: RoomTheme;
}

/**
 * Two rooms run their seating along z and two along x.
 *
 * At the camera's fixed 180-270 degree arc a run and its transpose cost exactly the same to
 * frame, but they look completely different — a line of cats receding to the left of frame
 * versus to the right, seen in profile versus from behind. It is the cheapest way to stop four
 * rooms reading as one room, and it costs nothing.
 */
export const ROOMS: Record<RoomId, RoomDef> = {
  library: {
    id: 'library',
    label: 'NIGHT LIBRARY',
    blurb: 'green lamps, high shelves, nobody talking above a whisper',
    icon: '📚',
    price: 0,
    ambience: 'room',
    snacks: ['cocoa', 'milkbread', 'croissant', 'macaron', 'sandwich'],
    plan: { kind: 'table', axis: 'z', pitch: PITCH, offset: SEAT_OFFSET, face: 'across' },
    theme: {
      floorA: '#7A5540', floorB: '#8A6049', floorPitch: 0.9,
      wallLow: '#5C4033', wallHigh: '#241A22', trim: '#3E2C24', dadoY: 6.2,
      wood: '#A9764E', woodDark: '#5E4030',
      seatA: '#7C4A55', seatB: '#A76B72',
      key: { color: '#FFE7BE', intensity: 1.15, position: [-9, 13, -7] },
      ambient: { color: '#8A7488', intensity: 0.9 },
      sky: '#241B2E',
      hearth: { name: 'reading lamp', tiers: ['#2E7D5B', '#3F9A71', '#8FD9A8', '#CFF3DD', '#F6FFF9'], light: '#9BE8BC', reach: 10 },
    },
  },
  classroom: {
    id: 'classroom',
    label: 'AFTER-SCHOOL ROOM',
    blurb: 'chalk dust, low sun, the desks nobody cleared',
    icon: '🏫',
    price: 220,
    plan: {
      kind: 'rows',
      axis: 'x',
      pitch: PITCH,
      rowPitch: PITCH,
      columns: CLASSROOM_COLUMNS,
      offset: 0,
      face: 'focal',
      focal: { x: 0, z: -6 },
    },
    ambience: 'birds',
    snacks: ['onigiri', 'sandwich', 'melonpan', 'lemonade', 'friedchicken'],
    theme: {
      floorA: '#B9A183', floorB: '#C4AC8E', floorPitch: 1.1,
      wallLow: '#CFE0D8', wallHigh: '#7E9AA0', trim: '#8A9E96', dadoY: 5.4,
      wood: '#C9A56B', woodDark: '#6E5A44',
      seatA: '#4E7FA8', seatB: '#79A9CC',
      key: { color: '#FFD9A0', intensity: 1.0, position: [-8, 12, -6] },
      ambient: { color: '#8E90B4', intensity: 0.78 },
      sky: '#F2C98A',
      hearth: { name: 'chalkboard sun', tiers: ['#E8A34A', '#F2BC6A', '#FFE9A8', '#FFF4D2', '#FFFCEE'], light: '#FFD98A', reach: 9.5 },
    },
  },
  conference: {
    id: 'conference',
    label: 'THE GOOD MEETING ROOM',
    blurb: 'the long table, the good chairs, and nobody booking over you',
    icon: '📊',
    price: 260,
    ambience: 'cafe',
    snacks: ['cocoa', 'croissant', 'macaron', 'lemonade', 'sandwich', 'milkbread'],
    plan: { kind: 'table', axis: 'x', pitch: PITCH, offset: SEAT_OFFSET, face: 'across' },
    theme: {
      floorA: '#5A5F76', floorB: '#646A82', floorPitch: 1.6,
      wallLow: '#D8DCE6', wallHigh: '#2E3242', trim: '#9AA0B4', dadoY: 5.0,
      wood: '#5E4636', woodDark: '#3A2C24',
      seatA: '#2E3448', seatB: '#4A5470',
      key: { color: '#DCE6FF', intensity: 0.95, position: [-9, 13, -8] },
      ambient: { color: '#6E7694', intensity: 0.76 },
      sky: '#2B3050',
      hearth: { name: 'projector', tiers: ['#5FA8E8', '#7FC0F2', '#A8DAFA', '#D2EEFF', '#F2FBFF'], light: '#8FC8F5', reach: 10 },
    },
  },
  museum: {
    id: 'museum',
    label: 'QUIET MUSEUM',
    blurb: 'marble, one lit case, and the whole wing to yourselves',
    icon: '🏛️',
    price: 300,
    plan: {
      kind: 'benches',
      axis: 'x',
      pitch: PITCH,
      offset: SEAT_OFFSET,
      face: 'focal',
      focal: { x: 0, z: -5 },
    },
    ambience: 'room',
    snacks: ['macaron', 'cocoa', 'strawberry', 'croissant', 'milkbread'],
    theme: {
      floorA: '#B9B2C6', floorB: '#CFC8D8', floorPitch: 2.2,
      wallLow: '#E4E0EC', wallHigh: '#3A3C5C', trim: '#9E96B4', dadoY: 7.0,
      wood: '#8E86A0', woodDark: '#5A5470',
      seatA: '#5A6096', seatB: '#868CC0',
      key: { color: '#CBD6FF', intensity: 0.92, position: [-8, 15, -8] },
      ambient: { color: '#5C6488', intensity: 0.7 },
      sky: '#1A1E30',
      hearth: { name: 'exhibit', tiers: ['#5FC7E8', '#7FD9F2', '#A8E9FA', '#D2F5FF', '#F2FDFF'], light: '#8FDDF5', reach: 10.5 },
    },
  },
};

export const ROOM_ORDER: readonly RoomId[] = ['library', 'classroom', 'conference', 'museum'];

export const DEFAULT_ROOM: RoomId = 'library';

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROOMS, value);
}

export function roomDef(id: RoomId | string): RoomDef {
  return isRoomId(id) ? ROOMS[id] : ROOMS[DEFAULT_ROOM];
}

export interface RoomSize {
  /** Half-extents of the seated party itself. */
  halfX: number;
  halfZ: number;
  /** What the camera must contain. */
  focus: { center: [number, number, number]; half: [number, number, number] };
  /** The volume the eye may never leave. Grows only toward the viewer, at +x/+z. */
  shell: { minX: number; maxX: number; minZ: number; maxZ: number; height: number };
  /** Rectangular footprint the cats path inside. */
  walkable: { w: number; d: number };
}

/**
 * The room a seated party implies.
 *
 * The shell deliberately grows only toward +x and +z. That is where the camera is (the arc is
 * 180-270 degrees, which puts the eye at positive x and z), so the eye gets room to back off
 * into space that is behind the viewer and never rendered, while the far walls — the ones you
 * actually see, and the ones the shelves and the board are anchored to — stay put.
 */
export function roomSize(halfX: number, halfZ: number): RoomSize {
  const fx = halfX + FURNITURE_MARGIN;
  const fz = halfZ + FURNITURE_MARGIN;
  return {
    halfX,
    halfZ,
    focus: { center: [0, 0.78, 0], half: [fx, 1.2, fz] },
    shell: {
      minX: -(fx + 1),
      maxX: ROOM_MAX_XZ,
      minZ: -(fz + 1),
      maxZ: ROOM_MAX_XZ,
      height: ROOM_CEILING,
    },
    // Cats roam the whole floor, not just the seating. Doubled because `walkable` is a full
    // width/depth rather than a half-extent.
    walkable: { w: (fx + 1.4) * 2, d: (fz + 1.4) * 2 },
  };
}

/**
 * The party environment's `EnvironmentDef`, themed and SIZED by the room and the roster.
 *
 * Unlike the solo worlds this is not a constant: the shell and the gameplay footprint both grow
 * with the party, so the def is rebuilt whenever the roster changes. Everything downstream that
 * reads `env.def` — the day/night pass, the ambience layer, the snack pool, the scene label, the
 * camera's shell — becomes room-aware without knowing rooms exist.
 */
export function roomEnvDef(id: RoomId | string, memberCount: number, plan?: SeatLayoutLike): EnvironmentDef {
  const def = roomDef(id);
  const t = def.theme;
  const layout = plan ?? seatLayout(memberCount, def.plan);
  const size = roomSize(layout.halfX, layout.halfZ);

  const everyPhase = <T,>(value: T): Record<DayPhase, T> => ({
    dawn: value,
    morning: value,
    afternoon: value,
    golden: value,
    dusk: value,
    night: value,
  });

  return {
    id: 'arena',
    label: def.label,
    blurb: def.blurb,
    icon: def.icon,
    price: def.price,
    ambience: def.ambience,
    snacks: [...def.snacks],
    // A party room is deliberately phase-independent. You went somewhere; the time of day you
    // left behind is not the point, and a library at 3pm and at 3am look the same from inside.
    sky: everyPhase(t.sky),
    key: everyPhase({ color: t.key.color, intensity: t.key.intensity }),
    ambient: everyPhase(t.ambient),
    floor: size.walkable,
    shell: {
      kind: 'walls',
      minX: size.shell.minX,
      maxX: size.shell.maxX,
      minZ: size.shell.minZ,
      maxZ: size.shell.maxZ,
      ceiling: size.shell.height,
      rimHeight: 0,
      groundHalf: ROOM_MAX_XZ + 2,
    },
  };
}

interface SeatLayoutLike {
  halfX: number;
  halfZ: number;
}
