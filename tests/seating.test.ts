/**
 * Seating plans, and the one thing that actually decides their numbers: whether the camera can
 * frame the party that sits in them.
 *
 * The circular arena was replaced because it made every venue the same disc. The reason a
 * rectangular room is *harder* is that a walled interior clamps the eye — it cannot back away
 * the way it could over open water — so the seated party's footprint is a hard budget, not a
 * style preference. These tests measure that budget against the real rig instead of asserting a
 * number somebody guessed.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SEAT_HALF,
  layoutHalf,
  seatLayout,
  tightestGap,
  type SeatPlanSpec,
} from '../src/core/seating';
import { MAX_PARTY, MIN_PARTY } from '../src/core/party';
import { ROOMS, ROOM_ORDER, ROOM_CEILING, ROOM_LID, ROOM_MAX_XZ, DEFAULT_ROOM, roomSize } from '../src/data/rooms';
import { migrate, normalize } from '../src/core/save';
import {
  AZIMUTH_DEFAULT,
  AZIMUTH_MAX,
  AZIMUTH_MIN,
  ELEVATION_DEFAULT,
  ELEVATION_MAX,
  ELEVATION_MIN,
  createCameraRig,
  type CameraMood,
} from '../src/scene/camera';

/* ------------------------------------------------------------------- plans */

// The REAL plans, imported rather than restated. A copy here would pass forever while production
// drifted — the whole point of this file is that these exact numbers stay framable.
const PLANS: Record<string, SeatPlanSpec> = Object.fromEntries(
  ROOM_ORDER.map((id) => [id, ROOMS[id].plan]),
);

const COUNTS = [MIN_PARTY, 3, 4, 5, 6, 7, MAX_PARTY];

describe('seat plans', () => {
  it('seats exactly the party, at every size', () => {
    for (const [name, plan] of Object.entries(PLANS)) {
      for (const n of COUNTS) {
        expect(seatLayout(n, plan).seats, `${name} at ${n}`).toHaveLength(n);
      }
    }
  });

  it('is deterministic — the same party always gets the same chairs', () => {
    for (const plan of Object.values(PLANS)) {
      expect(seatLayout(6, plan).seats).toEqual(seatLayout(6, plan).seats);
    }
  });

  it('never seats two cats on top of each other', () => {
    // A cat is SEAT_HALF wide from the middle, so anything under 2 * SEAT_HALF is a lap.
    for (const [name, plan] of Object.entries(PLANS)) {
      for (const n of COUNTS) {
        const gap = tightestGap(seatLayout(n, plan).seats);
        expect(gap, `${name} at ${n} seats overlap`).toBeGreaterThan(SEAT_HALF * 2);
      }
    }
  });

  it('grows with the party — every join makes the seated footprint bigger or equal', () => {
    for (const [name, plan] of Object.entries(PLANS)) {
      let previous = 0;
      for (const n of COUNTS) {
        const { halfX, halfZ } = seatLayout(n, plan);
        const area = halfX * halfZ;
        expect(area, `${name} shrank going to ${n}`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = area;
      }
    }
  });

  it('faces everyone at the thing they came to look at', () => {
    // 'across': each cat looks at the opposite column, i.e. straight over the table.
    const table = seatLayout(6, PLANS.library);
    for (const seat of table.seats) {
      const forward = { x: Math.sin(seat.facing), z: Math.cos(seat.facing) };
      // The table runs along z, so everyone faces across it in x, toward x = 0.
      expect(Math.sign(forward.x)).toBe(-Math.sign(seat.x));
      expect(Math.abs(forward.z)).toBeLessThan(0.01);
    }

    // 'focal': everyone looks at the board.
    const room = seatLayout(7, PLANS.classroom);
    for (const seat of room.seats) {
      const forward = { x: Math.sin(seat.facing), z: Math.cos(seat.facing) };
      const toBoard = { x: 0 - seat.x, z: -6 - seat.z };
      const len = Math.hypot(toBoard.x, toBoard.z);
      expect(forward.x * (toBoard.x / len) + forward.z * (toBoard.z / len)).toBeGreaterThan(0.999);
    }
  });

  it('pads the extent by the cat, not just the cushion', () => {
    const { halfX, halfZ } = layoutHalf([{ x: 0, z: 0, facing: 0 }]);
    expect(halfX).toBe(SEAT_HALF);
    expect(halfZ).toBe(SEAT_HALF);
  });
});

/* ------------------------------------------------------- the camera budget */

const MOODS: CameraMood[] = ['idle', 'focus', 'break'];

/**
 * The worst normalised-device coordinate any corner of the focus box reaches, across every legal
 * camera pose. Anything over 1 is off-screen — i.e. the party is cropped.
 */
function worstFraming(focus: { center: THREE.Vector3; half: THREE.Vector3 }, shell: never, aspect: number): number {
  const rig = createCameraRig(1000 * aspect, 1000);
  rig.frame(1000 * aspect, 1000);
  rig.setFocus(focus);
  rig.setShell(shell);
  rig.setReducedMotion(true);

  let worst = 0;
  const v = new THREE.Vector3();
  for (const mood of MOODS) {
    rig.setMood(mood);
    for (let az = AZIMUTH_MIN; az <= AZIMUTH_MAX; az += 15) {
      for (let el = ELEVATION_MIN; el <= ELEVATION_MAX; el += 6) {
        // Default zoom only, matching the contract tests/framing.test.ts already holds the solo
        // rooms to. Zooming IN is a deliberate crop — the user asked to get closer — and
        // `resetView()` does not reset zoom, so sweeping it here would also accumulate.
        rig.resetView();
        rig.orbitBy(az - AZIMUTH_DEFAULT, el - ELEVATION_DEFAULT);
        for (let i = 0; i < 8; i++) rig.update(5, 0);
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
              v.set(
                focus.center.x + sx * focus.half.x,
                focus.center.y + sy * focus.half.y,
                focus.center.z + sz * focus.half.z,
              ).project(rig.camera);
              worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
            }
          }
        }
      }
    }
  }
  return worst;
}

/** Built by the SAME function the scene uses, so the test cannot pass a kinder room. */
function roomFor(halfX: number, halfZ: number) {
  const size = roomSize(halfX, halfZ);
  return {
    focus: {
      center: new THREE.Vector3(...size.focus.center),
      half: new THREE.Vector3(...size.focus.half),
    },
    // ShellBox calls this `height`, not `ceiling`. Passing the wrong key leaves it undefined and
    // the clamp collapses onto the focus, which reads as "nothing fits anywhere".
    shell: size.shell as never,
  };
}

describe('the camera can actually frame these rooms', () => {
  // Portrait is the binding case: the same box that fits comfortably in 16:9 is the one that
  // crops on a phone, and the arena's predecessor shipped that bug twice.
  const ASPECTS: Array<[string, number]> = [
    ['landscape 16:9', 16 / 9],
    ['square', 1],
    ['portrait 390x844', 390 / 844],
  ];

  it('holds the whole party, in every plan, at every size, at every aspect', () => {
    const failures: string[] = [];
    for (const [name, plan] of Object.entries(PLANS)) {
      for (const n of COUNTS) {
        const { halfX, halfZ } = seatLayout(n, plan);
        const { focus, shell } = roomFor(halfX, halfZ);
        for (const [aspectName, aspect] of ASPECTS) {
          const worst = worstFraming(focus, shell, aspect);
          if (worst > 1) failures.push(`${name} n=${n} ${aspectName}: ${worst.toFixed(3)}`);
        }
      }
    }
    expect(failures, `the party does not fit in frame:\n${failures.join('\n')}`).toEqual([]);
  });
});

describe('the room the eye is allowed in', () => {
  it('keeps the eye below the ceiling slab it draws', () => {
    // The failure this prevents: the rig climbs above a drawn lid while framing a break and
    // renders the room from the roof. That shipped once already.
    expect(ROOM_CEILING).toBeLessThan(ROOM_LID);
  });

  it('grows only toward the viewer, so the far walls never move', () => {
    // The camera arc is 180-270 degrees, which puts the eye at +x/+z. The shell must give it
    // room to back off THERE, into space behind the viewer, and nowhere else — the -x/-z walls
    // are the ones you actually see and the ones furniture is anchored to.
    const small = roomSize(1.5, 1.5);
    const big = roomSize(3.0, 4.0);
    expect(small.shell.maxX).toBe(big.shell.maxX);
    expect(small.shell.maxZ).toBe(big.shell.maxZ);
    expect(big.shell.minX).toBeLessThan(small.shell.minX);
    expect(big.shell.minZ).toBeLessThan(small.shell.minZ);
    expect(small.shell.maxX).toBe(ROOM_MAX_XZ);
  });

  it('gives the cats a floor wider than the seating they sit on', () => {
    for (const id of ROOM_ORDER) {
      for (const n of COUNTS) {
        const { halfX, halfZ } = seatLayout(n, ROOMS[id].plan);
        const size = roomSize(halfX, halfZ);
        expect(size.walkable.w / 2, `${id} n=${n} floor narrower than its seats`).toBeGreaterThan(halfX);
        expect(size.walkable.d / 2, `${id} n=${n} floor shallower than its seats`).toBeGreaterThan(halfZ);
      }
    }
  });
});

describe('save v5 -> v6: venues become rooms', () => {
  it('carries every paid-for venue across to the room that replaced it', () => {
    const { raw } = migrate({
      version: 5,
      unlocks: { venues: ['clearing', 'school', 'museum'] },
      settings: { mode: 'party', venue: 'school' },
    } as never);

    const state = normalize(raw);
    // The clearing has no successor, so its owner lands in the free room rather than losing it.
    expect(state.unlocks.rooms.sort()).toEqual(['classroom', 'library', 'museum']);
    expect(state.settings.room).toBe('classroom');
  });

  it('never leaves a save standing in a room it does not own', () => {
    const state = normalize({
      version: 7,
      unlocks: { rooms: ['library'] },
      settings: { room: 'museum' },
    } as never);
    expect(state.settings.room).toBe(DEFAULT_ROOM);
  });

  it('always owns the free room, whatever the save said', () => {
    const state = normalize({ version: 7, unlocks: { rooms: [] } } as never);
    expect(state.unlocks.rooms).toContain(DEFAULT_ROOM);
    expect(ROOMS[DEFAULT_ROOM].price).toBe(0);
  });
});
