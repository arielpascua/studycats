/**
 * WHERE EVERYONE SITS — pure seating plans for the party rooms.
 *
 * The old party sat on a circle, which is why every venue was the same disc reskinned. A real
 * room seats people the way its furniture does: along a table, in rows facing a board, on
 * benches facing a wall. This module is that, and nothing else — no DOM, no Three.js, so the
 * scene and the tests agree on where everybody is by construction.
 *
 * Two ideas do all the work.
 *
 * **People sit across from each other, not zig-zagged down a line.** Members alternate sides of
 * the run and advance half a pitch each time, so same-side neighbours are a full pitch apart and
 * the two columns interleave. Advancing a *whole* pitch per member instead makes an eight-seat
 * run half again as long, and the length of that run is the single number the camera cannot
 * afford — see `layoutHalf` below and tests/seating.test.ts.
 *
 * **The layout reports its own extent.** `SeatLayout.halfX/halfZ` is the half-size of the box
 * the seated party occupies, and the room, the camera's focus volume and the walkable area are
 * all derived from it. Nothing downstream declares a room dimension; if a plan grows, the room
 * and the shot grow with it automatically. That is the "expands with the party" behaviour, and
 * it now lives in one place instead of five.
 */

import { MAX_PARTY, MIN_PARTY, type Seat } from './party';

/** Which way the line of seats runs. Purely visual — both cost the camera the same. */
export type RunAxis = 'x' | 'z';

export type SeatPlanKind = 'table' | 'rows' | 'benches';

/** Where a seated cat looks. */
export type SeatFacing =
  /** At the opposite column — a table. */
  | 'across'
  /** At a fixed point: the board, the exhibit, the screen. */
  | 'focal';

export interface SeatPlanSpec {
  kind: SeatPlanKind;
  axis: RunAxis;
  /** Distance between same-side neighbours along the run. Members advance half of this. */
  pitch: number;
  /**
   * Half the distance between the two columns — table half-width plus the gap to a cushion.
   * For `rows` this is the gap between the two halves of the classroom, i.e. the aisle.
   */
  offset: number;
  face: SeatFacing;
  /** Required when `face` is 'focal'. */
  focal?: { x: number; z: number };
  /** `rows` only: seats per row before wrapping to the row behind. */
  columns?: number;
  /** `rows` only: distance between rows, back to front. */
  rowPitch?: number;
}

export interface SeatLayout {
  seats: Seat[];
  /** Half-extent of the seated party, including the cat's own footprint. */
  halfX: number;
  halfZ: number;
}

/**
 * A seated cat's own footprint, from the middle of the cushion.
 *
 * The camera has to frame the *cats*, not the points they stand on, so every extent this module
 * reports is padded by this. Getting it from `createCat().radius` would drag Three.js into a
 * pure module, so it is stated here and pinned by a test against the real cat.
 */
export const SEAT_HALF = 0.46;

function clampCount(memberCount: number): number {
  const n = Math.round(memberCount) || MIN_PARTY;
  return Math.max(1, Math.min(MAX_PARTY, n));
}

/**
 * Facing, in the convention the rest of the game already uses: 0 is +z, and forward is
 * `(sin f, cos f)`. Pinned by tests/party.test.ts, so it cannot drift.
 */
function faceToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  if (Math.hypot(dx, dz) < 1e-6) return 0;
  return Math.atan2(dx, dz);
}

/**
 * Seats for a party, in the given plan.
 *
 * Deterministic and stable: member `i` is always in the same chair for a given count, so a cat
 * does not teleport across the room because somebody else joined. Seat 0 is nearest the camera's
 * default bearing, so the host's cat is the one you see best — the same promise the old ring
 * made, kept in a rectangular room.
 */
export function seatLayout(memberCount: number, spec: SeatPlanSpec): SeatLayout {
  const n = clampCount(memberCount);
  const seats: Seat[] = [];

  if (spec.kind === 'rows') {
    // A classroom: fill front to back, left to right, every desk facing the board.
    const columns = Math.max(1, spec.columns ?? 4);
    const rowPitch = spec.rowPitch ?? spec.pitch;
    const rows = Math.ceil(n / columns);

    for (let i = 0; i < n; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      // Rows are centred on the room, and a short final row centres itself rather than hanging
      // off to one side.
      const inThisRow = Math.min(columns, n - row * columns);
      const along = (col - (inThisRow - 1) / 2) * spec.pitch;
      const back = (row - (rows - 1) / 2) * rowPitch;

      const x = spec.axis === 'x' ? along : back;
      const z = spec.axis === 'x' ? back : along;
      seats.push({ x, z, facing: 0 });
    }
  } else {
    // A table or a pair of benches: two columns, members alternating, advancing half a pitch
    // each so the columns interleave and nobody sits directly opposite a gap.
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const along = (i - (n - 1) / 2) * (spec.pitch / 2);
      const cross = side * spec.offset;

      const x = spec.axis === 'x' ? along : cross;
      const z = spec.axis === 'x' ? cross : along;
      seats.push({ x, z, facing: 0 });
    }
  }

  // Facing is applied after placement, so 'across' can look at the actual opposite column and
  // 'focal' at the actual board, rather than at where we assumed they would be.
  for (const seat of seats) {
    if (spec.face === 'focal') {
      const f = spec.focal ?? { x: 0, z: 0 };
      seat.facing = faceToward(seat.x, seat.z, f.x, f.z);
    } else if (spec.axis === 'x') {
      seat.facing = faceToward(seat.x, seat.z, seat.x, 0);
    } else {
      seat.facing = faceToward(seat.x, seat.z, 0, seat.z);
    }
  }

  return { seats, ...layoutHalf(seats) };
}

/** The half-extent of a set of seats, padded by the cat that sits on each one. */
export function layoutHalf(seats: readonly Seat[]): { halfX: number; halfZ: number } {
  if (seats.length === 0) return { halfX: SEAT_HALF, halfZ: SEAT_HALF };
  let maxX = 0;
  let maxZ = 0;
  for (const s of seats) {
    maxX = Math.max(maxX, Math.abs(s.x));
    maxZ = Math.max(maxZ, Math.abs(s.z));
  }
  return { halfX: maxX + SEAT_HALF, halfZ: maxZ + SEAT_HALF };
}

/**
 * How far apart the two closest seats are.
 *
 * Exists so a test can assert nobody is sitting in anybody's lap at any party size, which is the
 * failure mode a plan with too small a pitch produces and which is invisible until you look at
 * eight cats at once.
 */
export function tightestGap(seats: readonly Seat[]): number {
  let min = Infinity;
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      min = Math.min(min, Math.hypot(seats[i].x - seats[j].x, seats[i].z - seats[j].z));
    }
  }
  return Number.isFinite(min) ? min : Infinity;
}
