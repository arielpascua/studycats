/**
 * Builds a placed furniture item. Slots decide *where*; this decides *what*.
 * Items that offer a perch report it so the drag system can drop a cat onto them.
 */

import * as THREE from 'three';
import { FURNITURE, type FurnitureDef, type SlotId } from '../../data/furniture';
import { hex, PALETTE } from '../../data/palette';
import { box, canvasTexture, flat, mergedBoxes, type BoxSpec } from '../voxel';

export interface PlacedFurniture {
  id: string;
  slot: SlotId;
  group: THREE.Group;
  def: FurnitureDef;
  /** World-space perch a cat can be dropped onto, if any. */
  perch: { x: number; y: number; z: number; r: number } | null;
  /** Obstacle circle for cat pathing (null for flat rugs and wall art). */
  obstacle: { x: number; z: number; r: number } | null;
  update?(dt: number, elapsed: number, night: boolean): void;
}

/** Slot → transform. Kept per-environment-agnostic: worlds place the slot anchors themselves. */
export const SLOT_ANCHORS: Record<SlotId, { x: number; y: number; z: number; ry: number }> = {
  'floor-a': { x: 0.4, y: 0.02, z: 1.4, ry: 0 },
  'floor-b': { x: -3.4, y: 0, z: 1.0, ry: 0.3 },
  'floor-c': { x: 3.4, y: 0, z: 0.4, ry: -0.4 },
  'wall-a': { x: -2.6, y: 2.5, z: -3.70, ry: 0 },
  'wall-b': { x: -0.2, y: 2.6, z: -3.70, ry: 0 },
  corner: { x: -4.1, y: 0, z: -2.6, ry: 0.5 },
  desk: { x: 1.35, y: 1.06, z: -1.5, ry: -0.2 },
  window: { x: 2.0, y: 0, z: -3.72, ry: 0 },
};

function rug(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const base = box({ w: 3.4, h: 0.04, d: 2.4, y: 0.02 }, hex(def.colorA));
  base.castShadow = false;
  g.add(base);
  const specs: BoxSpec[] = [];
  if (def.id === 'rug-checker') {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 6; c++) {
        if ((r + c) % 2 === 0) continue;
        specs.push({ w: 0.5, h: 0.01, d: 0.5, x: -1.4 + c * 0.56, y: 0.045, z: -0.85 + r * 0.56 });
      }
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      specs.push({ w: 0.42, h: 0.01, d: 0.42, x: Math.sin(a) * 0.75, y: 0.045, z: Math.cos(a) * 0.5, ry: a });
    }
  }
  const pattern = mergedBoxes(specs, hex(def.colorB));
  if (pattern) {
    pattern.castShadow = false;
    g.add(pattern);
  }
  return g;
}

function wallArt(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const frame = box({ w: 0.92, h: 0.72, d: 0.06 }, hex(PALETTE.ink));
  g.add(frame);
  const tex = canvasTexture(48, 36, (ctx) => {
    ctx.fillStyle = def.colorB;
    ctx.fillRect(0, 0, 48, 36);
    ctx.fillStyle = def.colorA;
    if (def.id === 'art-moon') {
      ctx.fillRect(28, 6, 12, 12);
      ctx.fillStyle = def.colorB;
      ctx.fillRect(24, 4, 10, 10);
      ctx.fillStyle = def.colorA;
      for (let i = 0; i < 7; i++) ctx.fillRect((i * 11) % 44, (i * 7) % 30, 2, 2);
    } else {
      ctx.fillRect(10, 14, 22, 7);
      ctx.fillRect(6, 15, 5, 5);
      ctx.fillRect(32, 12, 4, 11);
    }
  });
  const canvasPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.58),
    new THREE.MeshBasicMaterial({ map: tex }),
  );
  canvasPlane.position.z = 0.035;
  g.add(canvasPlane);
  return g;
}

function catTower(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const wood = mergedBoxes(
    [
      { w: 0.9, h: 0.14, d: 0.9, y: 0.07 },
      { w: 0.22, h: 0.9, d: 0.22, y: 0.6 },
      { w: 0.8, h: 0.12, d: 0.8, y: 1.1 },
      { w: 0.2, h: 0.7, d: 0.2, y: 1.5, x: 0.14 },
      { w: 0.86, h: 0.14, d: 0.86, y: 1.9, x: 0.14 },
    ],
    hex(def.colorA),
  )!;
  g.add(wood);
  const cushion = box({ w: 0.7, h: 0.1, d: 0.7, x: 0.14, y: 2.02 }, hex(def.colorB));
  g.add(cushion);
  return g;
}

function cushion(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const pad = mergedBoxes(
    [
      { w: 0.86, h: 0.16, d: 0.86, y: 0.08 },
      { w: 0.7, h: 0.08, d: 0.7, y: 0.19 },
    ],
    hex(def.colorA),
  )!;
  g.add(pad);
  const trim = box({ w: 0.9, h: 0.05, d: 0.9, y: 0.03 }, hex(def.colorB));
  g.add(trim);
  return g;
}

function fairyLights(def: FurnitureDef): { group: THREE.Group; update: PlacedFurniture['update'] } {
  const g = new THREE.Group();
  const bulbs: THREE.Mesh[] = [];
  const wire: BoxSpec[] = [];
  const count = 9;
  for (let i = 0; i < count; i++) {
    const x = -1.6 + (i / (count - 1)) * 3.2;
    const y = Math.sin((i / (count - 1)) * Math.PI) * -0.26;
    wire.push({ w: 0.4, h: 0.03, d: 0.03, x: x + 0.2, y: y + 0.02 });
    const bulb = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      flat(hex(i % 2 === 0 ? def.colorA : def.colorB)),
    );
    bulb.position.set(x, y - 0.1, 0.06);
    bulb.castShadow = false;
    g.add(bulb);
    bulbs.push(bulb);
  }
  const wireMesh = mergedBoxes(wire, hex(PALETTE.ink));
  if (wireMesh) {
    wireMesh.castShadow = false;
    g.add(wireMesh);
  }
  return {
    group: g,
    update(_dt, elapsed, night) {
      for (let i = 0; i < bulbs.length; i++) {
        const twinkle = 0.55 + Math.sin(elapsed * 1.6 + i * 0.9) * 0.45;
        const m = bulbs[i].material as THREE.MeshBasicMaterial;
        m.opacity = night ? 1 : 0.35 * twinkle + 0.3;
        m.transparent = true;
      }
    },
  };
}

function mug(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const body = mergedBoxes(
    [
      { w: 0.24, h: 0.28, d: 0.24, y: 0.14 },
      { w: 0.06, h: 0.14, d: 0.06, x: 0.15, y: 0.16 },
    ],
    hex(def.colorA),
  )!;
  const stripe = box({ w: 0.25, h: 0.07, d: 0.25, y: 0.2 }, hex(def.colorB));
  g.add(body, stripe);
  return g;
}

function plant(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const pot = mergedBoxes(
    [
      { w: 0.4, h: 0.32, d: 0.4, y: 0.16 },
      { w: 0.46, h: 0.07, d: 0.46, y: 0.34 },
    ],
    hex(def.colorB),
  )!;
  g.add(pot);
  const specs: BoxSpec[] = [];
  if (def.kind === 'plant' && def.id === 'plant-cactus') {
    specs.push({ w: 0.24, h: 0.7, d: 0.24, y: 0.72 });
    specs.push({ w: 0.14, h: 0.3, d: 0.14, x: -0.2, y: 0.78 });
    specs.push({ w: 0.14, h: 0.22, d: 0.14, x: 0.2, y: 0.9 });
  } else {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      specs.push({ w: 0.09, h: 0.5 + (i % 3) * 0.1, d: 0.09, x: Math.sin(a) * 0.13, y: 0.62, z: Math.cos(a) * 0.13, rz: Math.sin(a) * 0.35 });
    }
  }
  const foliage = mergedBoxes(specs, hex(def.colorA));
  if (foliage) g.add(foliage);
  return g;
}

function windowView(def: FurnitureDef): THREE.Group {
  const g = new THREE.Group();
  const tex = canvasTexture(64, 40, (ctx) => {
    ctx.fillStyle = def.colorA;
    ctx.fillRect(0, 0, 64, 40);
    ctx.fillStyle = def.colorB;
    if (def.id === 'window-city') {
      for (let i = 0; i < 7; i++) {
        const h = 10 + ((i * 5) % 16);
        ctx.fillStyle = '#3B2A44';
        ctx.fillRect(i * 9, 40 - h, 8, h);
        ctx.fillStyle = def.colorB;
        for (let w = 0; w < 3; w++) ctx.fillRect(i * 9 + 2, 40 - h + 3 + w * 5, 2, 2);
      }
    } else {
      ctx.fillRect(0, 24, 64, 16);
      ctx.fillStyle = '#8FBF8A';
      ctx.fillRect(6, 18, 24, 10);
      ctx.fillRect(34, 20, 26, 8);
    }
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.4), new THREE.MeshBasicMaterial({ map: tex }));
  plane.position.set(0, 1.75, 0.04);
  g.add(plane);
  return g;
}

export function createFurniture(id: string, slot: SlotId): PlacedFurniture | null {
  const def = FURNITURE[id];
  if (!def) return null;

  let group: THREE.Group;
  let update: PlacedFurniture['update'];
  let perch: PlacedFurniture['perch'] = null;
  let obstacle: PlacedFurniture['obstacle'] = null;

  switch (def.kind) {
    case 'rug':
      group = rug(def);
      break;
    case 'art':
      group = wallArt(def);
      break;
    case 'tower': {
      group = catTower(def);
      break;
    }
    case 'cushion':
      group = cushion(def);
      break;
    case 'lights': {
      const built = fairyLights(def);
      group = built.group;
      update = built.update;
      break;
    }
    case 'mug':
      group = mug(def);
      break;
    case 'plant':
      group = plant(def);
      break;
    case 'window':
      group = windowView(def);
      break;
    default:
      group = new THREE.Group();
      break;
  }

  const anchor = SLOT_ANCHORS[slot];
  group.position.set(anchor.x, anchor.y, anchor.z);
  group.rotation.y = anchor.ry;
  group.name = `furniture:${id}`;

  if (def.perch) {
    // The tower's top platform is offset from its own origin; keep the two in sync here.
    const px = def.kind === 'tower' ? anchor.x + 0.14 : anchor.x;
    perch = { x: px, y: anchor.y + def.perch.height, z: anchor.z, r: def.perch.radius };
  }

  if (def.kind === 'tower' || def.kind === 'plant') {
    obstacle = { x: anchor.x, z: anchor.z, r: def.kind === 'tower' ? 0.6 : 0.35 };
  }

  return { id, slot, group, def, perch, obstacle, update };
}
