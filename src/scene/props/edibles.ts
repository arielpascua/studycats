/**
 * Bowls and snack meshes for the break-time scene.
 *
 * Every snack shares one drop/bounce/shrink/pop lifecycle so the choreography is uniform and
 * — critically — so cleanup is one `dispose()` per object with no shape-specific special cases
 * (spec §7.6: "fully deterministic cleanup, no orphaned snack meshes").
 */

import * as THREE from 'three';
import { SNACKS, type SnackDef } from '../../data/snacks';
import { hex, PALETTE } from '../../data/palette';
import { box, disposeTree, mergedBoxes, type BoxSpec } from '../voxel';

export type SnackPhase = 'dropping' | 'resting' | 'shrinking' | 'popping' | 'done';

export interface SnackMesh {
  id: string;
  group: THREE.Group;
  def: SnackDef;
  phase: SnackPhase;
  /** 1 = whole, 0.5 = one bite gone. */
  fullness: number;
  update(dt: number, elapsed: number, reducedMotion: boolean): void;
  takeBite(): void;
  pop(): void;
  dispose(): void;
}

function shapeSpecs(def: SnackDef): { a: BoxSpec[]; b: BoxSpec[] } {
  switch (def.shape) {
    case 'rice':
      return {
        a: [{ w: 0.26, h: 0.24, d: 0.2, y: 0.12 }, { w: 0.16, h: 0.08, d: 0.14, y: 0.26 }],
        b: [{ w: 0.2, h: 0.08, d: 0.05, y: 0.08, z: 0.09 }],
      };
    case 'fish':
      return {
        a: [{ w: 0.36, h: 0.1, d: 0.14, y: 0.06 }],
        b: [{ w: 0.1, h: 0.14, d: 0.04, x: -0.2, y: 0.07 }, { w: 0.06, h: 0.06, d: 0.06, x: 0.14, y: 0.09 }],
      };
    case 'round':
      return {
        a: [{ w: 0.26, h: 0.2, d: 0.26, y: 0.1 }],
        b: [{ w: 0.2, h: 0.06, d: 0.2, y: 0.21 }],
      };
    case 'puff':
      return {
        a: [{ w: 0.18, h: 0.18, d: 0.18, y: 0.1 }, { w: 0.16, h: 0.16, d: 0.16, y: 0.26 }],
        b: [{ w: 0.04, h: 0.3, d: 0.04, y: 0.16, x: 0.12 }],
      };
    case 'berry':
      return {
        a: [{ w: 0.18, h: 0.2, d: 0.18, y: 0.1 }],
        b: [{ w: 0.14, h: 0.05, d: 0.14, y: 0.21 }, { w: 0.04, h: 0.08, d: 0.04, y: 0.26 }],
      };
    case 'crescent':
      return {
        a: [
          { w: 0.14, h: 0.12, d: 0.12, x: -0.11, y: 0.07, rz: 0.3 },
          { w: 0.16, h: 0.14, d: 0.14, y: 0.09 },
          { w: 0.14, h: 0.12, d: 0.12, x: 0.11, y: 0.07, rz: -0.3 },
        ],
        b: [{ w: 0.3, h: 0.04, d: 0.08, y: 0.16 }],
      };
    case 'cup':
      return {
        a: [{ w: 0.2, h: 0.24, d: 0.2, y: 0.12 }],
        b: [{ w: 0.17, h: 0.04, d: 0.17, y: 0.25 }, { w: 0.05, h: 0.1, d: 0.05, x: 0.13, y: 0.14 }],
      };
    case 'stick':
      return {
        a: [{ w: 0.12, h: 0.12, d: 0.34, y: 0.07 }],
        b: [{ w: 0.13, h: 0.05, d: 0.14, y: 0.14, z: -0.09 }],
      };
    case 'disc':
    default:
      return {
        a: [{ w: 0.28, h: 0.08, d: 0.28, y: 0.05 }],
        b: [{ w: 0.24, h: 0.05, d: 0.24, y: 0.11 }],
      };
  }
}

export function createSnackMesh(id: string, defId: string, x: number, z: number, dropFrom = 3.2): SnackMesh {
  const def = SNACKS[defId] ?? SNACKS.onigiri;
  const group = new THREE.Group();
  group.name = `snack:${id}`;
  group.position.set(x, dropFrom, z);
  group.scale.setScalar(def.scale);
  group.rotation.y = Math.random() * Math.PI * 2;

  const specs = shapeSpecs(def);
  const a = mergedBoxes(specs.a, hex(def.colorA));
  const b = mergedBoxes(specs.b, hex(def.colorB));
  if (a) group.add(a);
  if (b) group.add(b);

  let phase: SnackPhase = 'dropping';
  let vy = 0;
  let bounces = 0;
  let punch = 0;
  let shrinkT = 0;
  let popT = 0;
  let fullness = 1;

  const restY = 0;
  const baseScale = def.scale;

  const api: SnackMesh = {
    id,
    group,
    def,
    get phase() {
      return phase;
    },
    set phase(p: SnackPhase) {
      phase = p;
    },
    get fullness() {
      return fullness;
    },
    set fullness(f: number) {
      fullness = f;
    },
    takeBite() {
      fullness = Math.max(0, fullness - 0.5);
      shrinkT = 0;
      phase = fullness > 0 ? 'shrinking' : 'popping';
      punch = 1;
    },
    pop() {
      if (phase === 'done') return;
      phase = 'popping';
      popT = 0;
    },
    update(dt, elapsed, reducedMotion) {
      if (phase === 'done') return;

      if (reducedMotion) {
        // No drama: land instantly, shrink instantly, disappear instantly.
        if (phase === 'dropping') {
          group.position.y = restY;
          phase = 'resting';
        }
        if (phase === 'shrinking') {
          group.scale.setScalar(baseScale * (0.55 + fullness * 0.45));
          phase = 'resting';
        }
        if (phase === 'popping') {
          phase = 'done';
          group.visible = false;
        }
        return;
      }

      switch (phase) {
        case 'dropping': {
          vy -= 16 * dt;
          group.position.y += vy * dt;
          if (group.position.y <= restY) {
            group.position.y = restY;
            bounces++;
            if (bounces >= 2 || Math.abs(vy) < 1.6) {
              vy = 0;
              phase = 'resting';
              punch = 1; // scale-punch on landing
            } else {
              vy = -vy * 0.42;
              punch = 0.7;
            }
          }
          break;
        }
        case 'resting': {
          // A barely-there hover so food doesn't look welded to the floor.
          group.position.y = restY + Math.sin(elapsed * 1.6 + x) * 0.006;
          break;
        }
        case 'shrinking': {
          shrinkT += dt * 5;
          if (shrinkT >= 1) phase = 'resting';
          break;
        }
        case 'popping': {
          popT += dt * 4.5;
          const k = Math.min(1, popT);
          group.scale.setScalar(baseScale * fullness * (1 - k) * (1 + k * 0.7));
          group.rotation.y += dt * 9;
          group.position.y = restY + k * 0.4;
          if (k >= 1) {
            phase = 'done';
            group.visible = false;
          }
          return;
        }
        default:
          break;
      }

      if (punch > 0) punch = Math.max(0, punch - dt * 4.5);
      const squash = 1 + Math.sin(punch * Math.PI) * 0.28;
      const size = baseScale * (0.55 + fullness * 0.45);
      group.scale.set(size * squash, size / (squash * 0.7 + 0.3), size * squash);
    },
    dispose() {
      phase = 'done';
      disposeTree(group);
    },
  };

  return api;
}

export interface BowlMesh {
  id: string;
  group: THREE.Group;
  update(dt: number, elapsed: number, reducedMotion: boolean): void;
  /** Slide-in entrance from off-slab. */
  arrive(): void;
  leave(): void;
  isGone(): boolean;
  dispose(): void;
}

export function createBowl(id: string, kind: 'milk' | 'kibble', x: number, z: number): BowlMesh {
  const group = new THREE.Group();
  group.name = `bowl:${id}`;

  const shell = mergedBoxes(
    [
      { w: 0.52, h: 0.1, d: 0.52, y: 0.05 },
      { w: 0.58, h: 0.08, d: 0.58, y: 0.13 },
    ],
    hex(kind === 'milk' ? PALETTE.paper : PALETTE.wood),
  )!;
  group.add(shell);

  const fill = box({ w: 0.44, h: 0.06, d: 0.44, y: 0.14 }, hex(kind === 'milk' ? PALETTE.cream : PALETTE.woodDark));
  group.add(fill);

  const targetX = x;
  const offX = x + Math.sign(x || 1) * 6;
  group.position.set(offX, 0, z);

  let state: 'in' | 'idle' | 'out' | 'gone' = 'in';

  return {
    id,
    group,
    arrive() {
      state = 'in';
    },
    leave() {
      state = 'out';
    },
    isGone: () => state === 'gone',
    update(dt, elapsed, reducedMotion) {
      if (state === 'gone') return;
      const goal = state === 'out' ? offX : targetX;
      if (reducedMotion) {
        group.position.x = goal;
      } else {
        group.position.x += (goal - group.position.x) * Math.min(1, dt * 6);
      }
      if (state === 'in' && Math.abs(group.position.x - targetX) < 0.02) state = 'idle';
      if (state === 'out' && Math.abs(group.position.x - offX) < 0.1) {
        state = 'gone';
        group.visible = false;
      }
      if (state === 'idle' && !reducedMotion) {
        fill.position.y = 0.14 + Math.sin(elapsed * 2.2) * 0.004;
      }
    },
    dispose() {
      state = 'gone';
      disposeTree(group);
    },
  };
}
