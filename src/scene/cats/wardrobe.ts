/**
 * Builds the cosmetics a cat wears.
 *
 * Every item is boxes from the same vocabulary as the cats, so a dressed cat still belongs to
 * the world. Each slot mounts on a different joint, which is what makes them composable: a hat
 * rides the head bob, a cape swings with the body, and they can never collide because they are
 * never on the same transform.
 *
 *   hat    → headPivot, above the skull
 *   collar → root, at the neck
 *   cape   → root, on the back
 *   charm  → headPivot, floating above
 */

import * as THREE from 'three';
import { COSMETICS, type CosmeticSlot, type Outfit } from '../../data/cosmetics';
import { hex } from '../../data/palette';
import { box, boxGeo, flat, mergedBoxes, TAU, type BoxSpec } from '../voxel';

export interface WornItem {
  id: string;
  slot: CosmeticSlot;
  group: THREE.Group;
  /** Charms bob and turn; the animator drives them through this. */
  animated: boolean;
}

/** Where each slot attaches, in the local space of its joint. */
const MOUNT: Record<CosmeticSlot, { x: number; y: number; z: number }> = {
  // Relative to whatever part mountFor() attaches them to. The hat and charm ride the head, so
  // they moved when the head grew; the collar and cape ride the body, which shrank.
  hat: { x: 0, y: 0.68, z: 0 },
  collar: { x: 0, y: 0.44, z: 0.34 },
  cape: { x: 0, y: 0.46, z: -0.1 },
  charm: { x: 0, y: 1.16, z: 0 },
};

function buildHat(shape: string, a: number, b: number): THREE.Group {
  const g = new THREE.Group();
  switch (shape) {
    case 'party': {
      // A cone is four narrowing boxes at this scale, and it keeps the voxel read.
      const specs: BoxSpec[] = [];
      for (let i = 0; i < 4; i++) {
        const w = 0.26 - i * 0.055;
        specs.push({ w, h: 0.09, d: w, y: 0.05 + i * 0.09 });
      }
      const cone = mergedBoxes(specs, a);
      if (cone) g.add(cone);
      g.add(box({ w: 0.09, h: 0.09, d: 0.09, y: 0.43 }, b));
      break;
    }
    case 'crown': {
      const band = mergedBoxes([{ w: 0.3, h: 0.07, d: 0.3, y: 0.05 }], a);
      if (band) g.add(band);
      const points: BoxSpec[] = [];
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU + Math.PI / 4;
        points.push({ w: 0.07, h: 0.11, d: 0.07, x: Math.sin(angle) * 0.11, y: 0.14, z: Math.cos(angle) * 0.11 });
      }
      const spikes = mergedBoxes(points, a);
      if (spikes) g.add(spikes);
      g.add(box({ w: 0.06, h: 0.06, d: 0.06, y: 0.15 }, b));
      break;
    }
    case 'flowers': {
      const ring: BoxSpec[] = [];
      for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * TAU;
        ring.push({ w: 0.09, h: 0.06, d: 0.09, x: Math.sin(angle) * 0.15, y: 0.05, z: Math.cos(angle) * 0.15, ry: angle });
      }
      const petals = mergedBoxes(ring, a);
      if (petals) g.add(petals);
      const stems: BoxSpec[] = [];
      for (let i = 0; i < 7; i++) {
        const angle = (i / 7) * TAU + 0.4;
        stems.push({ w: 0.05, h: 0.04, d: 0.05, x: Math.sin(angle) * 0.15, y: 0.02, z: Math.cos(angle) * 0.15 });
      }
      const leaves = mergedBoxes(stems, b);
      if (leaves) g.add(leaves);
      break;
    }
    case 'headphones': {
      const band = mergedBoxes(
        [
          { w: 0.06, h: 0.1, d: 0.06, x: -0.16, y: 0.1 },
          { w: 0.06, h: 0.1, d: 0.06, x: 0.16, y: 0.1 },
          { w: 0.32, h: 0.06, d: 0.06, y: 0.17 },
        ],
        a,
      );
      if (band) g.add(band);
      const cups = mergedBoxes(
        [
          { w: 0.1, h: 0.16, d: 0.12, x: -0.2, y: 0.0 },
          { w: 0.1, h: 0.16, d: 0.12, x: 0.2, y: 0.0 },
        ],
        b,
      );
      if (cups) g.add(cups);
      break;
    }
    case 'chef': {
      const cap = mergedBoxes(
        [
          { w: 0.3, h: 0.08, d: 0.3, y: 0.04 },
          { w: 0.34, h: 0.2, d: 0.34, y: 0.18 },
          { w: 0.26, h: 0.09, d: 0.26, y: 0.32 },
        ],
        a,
      );
      if (cap) g.add(cap);
      g.add(box({ w: 0.31, h: 0.05, d: 0.31, y: 0.03 }, b));
      break;
    }
    case 'beanie':
    default: {
      const cap = mergedBoxes(
        [
          { w: 0.34, h: 0.14, d: 0.34, y: 0.07 },
          { w: 0.28, h: 0.08, d: 0.28, y: 0.17 },
        ],
        a,
      );
      if (cap) g.add(cap);
      g.add(box({ w: 0.36, h: 0.06, d: 0.36, y: 0.02 }, b));
      g.add(box({ w: 0.1, h: 0.08, d: 0.1, y: 0.24 }, b));
      break;
    }
  }
  return g;
}

function buildCollar(shape: string, a: number, b: number): THREE.Group {
  const g = new THREE.Group();
  const band = mergedBoxes([{ w: 0.5, h: 0.08, d: 0.14 }], a);
  if (band) g.add(band);

  switch (shape) {
    case 'bow':
      g.add(box({ w: 0.1, h: 0.11, d: 0.06, x: -0.09, z: 0.06 }, b));
      g.add(box({ w: 0.1, h: 0.11, d: 0.06, x: 0.09, z: 0.06 }, b));
      g.add(box({ w: 0.07, h: 0.07, d: 0.07, z: 0.07 }, a));
      break;
    case 'bandana': {
      const cloth = mergedBoxes(
        [
          { w: 0.34, h: 0.12, d: 0.06, y: -0.08, z: 0.06 },
          { w: 0.2, h: 0.1, d: 0.06, y: -0.17, z: 0.06 },
          { w: 0.1, h: 0.08, d: 0.06, y: -0.25, z: 0.06 },
        ],
        b,
      );
      if (cloth) g.add(cloth);
      break;
    }
    case 'scarf': {
      const wrap = mergedBoxes([{ w: 0.54, h: 0.14, d: 0.2, y: -0.04 }], b);
      if (wrap) g.add(wrap);
      // The trailing end, which the animator swings.
      const tail = mergedBoxes(
        [
          { w: 0.12, h: 0.22, d: 0.08, x: 0.16, y: -0.2, z: -0.02 },
          { w: 0.1, h: 0.18, d: 0.08, x: 0.18, y: -0.38, z: -0.06 },
        ],
        a,
      );
      if (tail) {
        tail.name = 'scarfTail';
        g.add(tail);
      }
      break;
    }
    case 'bell':
    default:
      g.add(box({ w: 0.11, h: 0.11, d: 0.11, y: -0.08, z: 0.06 }, b));
      break;
  }
  return g;
}

function buildCape(shape: string, a: number, b: number): THREE.Group {
  const g = new THREE.Group();
  switch (shape) {
    case 'wings': {
      const feathers: BoxSpec[] = [];
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          feathers.push({
            w: 0.1,
            h: 0.26 - i * 0.04,
            d: 0.06,
            x: side * (0.16 + i * 0.11),
            y: 0.1 - i * 0.05,
            z: -0.04,
            rz: side * (0.2 + i * 0.12),
          });
        }
      }
      const wing = mergedBoxes(feathers, a);
      if (wing) g.add(wing);
      const tips = mergedBoxes(
        [
          { w: 0.08, h: 0.1, d: 0.05, x: -0.52, y: -0.1, z: -0.04 },
          { w: 0.08, h: 0.1, d: 0.05, x: 0.52, y: -0.1, z: -0.04 },
        ],
        b,
      );
      if (tips) g.add(tips);
      break;
    }
    case 'backpack': {
      const pack = mergedBoxes([{ w: 0.34, h: 0.32, d: 0.2, y: -0.02, z: -0.12 }], a);
      if (pack) g.add(pack);
      const strapsAndFlap = mergedBoxes(
        [
          { w: 0.36, h: 0.1, d: 0.06, y: 0.1, z: -0.2 },
          { w: 0.06, h: 0.3, d: 0.16, x: -0.14, y: 0.02, z: -0.02 },
          { w: 0.06, h: 0.3, d: 0.16, x: 0.14, y: 0.02, z: -0.02 },
        ],
        b,
      );
      if (strapsAndFlap) g.add(strapsAndFlap);
      break;
    }
    case 'blanket': {
      const cloth = mergedBoxes(
        [
          { w: 0.62, h: 0.06, d: 0.5, y: 0.04, z: -0.1 },
          { w: 0.56, h: 0.06, d: 0.14, y: -0.06, z: -0.34 },
        ],
        a,
      );
      if (cloth) g.add(cloth);
      const trim = mergedBoxes([{ w: 0.64, h: 0.03, d: 0.08, y: 0.02, z: 0.14 }], b);
      if (trim) g.add(trim);
      break;
    }
    case 'cape':
    default: {
      const cloth = new THREE.Group();
      cloth.name = 'capeCloth';
      const panel = mergedBoxes(
        [
          { w: 0.56, h: 0.3, d: 0.06, y: -0.14, z: -0.14 },
          { w: 0.48, h: 0.22, d: 0.06, y: -0.38, z: -0.2 },
          { w: 0.36, h: 0.14, d: 0.06, y: -0.55, z: -0.26 },
        ],
        a,
      );
      if (panel) cloth.add(panel);
      g.add(cloth);
      const clasp = mergedBoxes([{ w: 0.5, h: 0.08, d: 0.12, y: 0.02, z: -0.02 }], b);
      if (clasp) g.add(clasp);
      break;
    }
  }
  return g;
}

function buildCharm(shape: string, a: number, b: number): THREE.Group {
  const g = new THREE.Group();
  switch (shape) {
    case 'halo': {
      const ring: BoxSpec[] = [];
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * TAU;
        ring.push({ w: 0.06, h: 0.04, d: 0.06, x: Math.sin(angle) * 0.19, z: Math.cos(angle) * 0.19, ry: angle });
      }
      const halo = mergedBoxes(ring, a);
      if (halo) {
        // Unlit, so it glows rather than being shaded like a solid object.
        halo.material = flat(a);
        halo.castShadow = false;
        g.add(halo);
      }
      break;
    }
    case 'balloon': {
      const string = box({ w: 0.02, h: 0.42, d: 0.02, y: -0.22 }, b);
      string.castShadow = false;
      g.add(string);
      const balloon = mergedBoxes(
        [
          { w: 0.24, h: 0.28, d: 0.24, y: 0.16 },
          { w: 0.08, h: 0.06, d: 0.08, y: -0.01 },
        ],
        a,
      );
      if (balloon) {
        balloon.castShadow = false;
        g.add(balloon);
      }
      break;
    }
    case 'sparkle':
    default: {
      const sparkGeo = boxGeo(0.07, 0.07, 0.07);
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU;
        const spark = new THREE.Mesh(sparkGeo, flat(i % 2 === 0 ? a : b));
        spark.position.set(Math.sin(angle) * 0.2, Math.cos(angle * 1.7) * 0.08, Math.cos(angle) * 0.2);
        spark.castShadow = false;
        spark.name = `spark${i}`;
        g.add(spark);
      }
      break;
    }
  }
  return g;
}

/** Build one cosmetic, positioned at its mount point. Returns null for an unknown id. */
export function buildCosmetic(id: string): WornItem | null {
  const def = COSMETICS[id];
  if (!def) return null;

  const a = hex(def.colorA);
  const b = hex(def.colorB);
  let group: THREE.Group;
  switch (def.slot) {
    case 'hat':
      group = buildHat(def.shape, a, b);
      break;
    case 'collar':
      group = buildCollar(def.shape, a, b);
      break;
    case 'cape':
      group = buildCape(def.shape, a, b);
      break;
    case 'charm':
    default:
      group = buildCharm(def.shape, a, b);
      break;
  }

  const mount = MOUNT[def.slot];
  group.position.set(mount.x, mount.y, mount.z);
  group.name = `worn:${def.slot}:${id}`;

  // Charms float and glow; they must not drop a shadow onto the cat wearing them.
  const casts = def.slot !== 'charm';
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = casts && mesh.castShadow;
      mesh.receiveShadow = casts;
    }
  });

  return { id, slot: def.slot, group, animated: Boolean(def.animated) };
}

/** Which joint a slot hangs from, given the cat's parts. */
export function mountFor(slot: CosmeticSlot, parts: { root: THREE.Object3D; headPivot: THREE.Object3D }): THREE.Object3D {
  return slot === 'hat' || slot === 'charm' ? parts.headPivot : parts.root;
}

/** Every slot id in a stable order, for iteration. */
export function outfitEntries(outfit: Outfit): Array<[CosmeticSlot, string]> {
  const out: Array<[CosmeticSlot, string]> = [];
  for (const slot of ['hat', 'collar', 'cape', 'charm'] as CosmeticSlot[]) {
    const id = outfit[slot];
    if (id) out.push([slot, id]);
  }
  return out;
}
