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

import type { SeatPlanSpec } from '../core/seating';

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

export interface RoomDef {
  id: RoomId;
  label: string;
  blurb: string;
  icon: string;
  price: number;
  /** Where the party sits, and therefore how big the room is. */
  plan: SeatPlanSpec;
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
    plan: { kind: 'table', axis: 'z', pitch: PITCH, offset: SEAT_OFFSET, face: 'across' },
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
  },
  conference: {
    id: 'conference',
    label: 'THE GOOD MEETING ROOM',
    blurb: 'the long table, the good chairs, and nobody booking over you',
    icon: '📊',
    price: 260,
    plan: { kind: 'table', axis: 'x', pitch: PITCH, offset: SEAT_OFFSET, face: 'across' },
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
