/**
 * Builds a voxel cat from a breed definition (spec §6.1).
 *
 * Structure matters as much as looks: the animator needs named, correctly-pivoted joints, so
 * every limb is a Group whose origin sits where the joint would be (hip, shoulder, tail base)
 * and whose mesh hangs *below* that origin. Rotating the group then swings the limb instead of
 * spinning it about its own middle.
 *
 * Head is deliberately oversized — poster proportions, not anatomy.
 *
 *   root
 *   ├ body            (merged torso boxes, one mesh)
 *   ├ headPivot       (neck joint)
 *   │  ├ head         (merged skull + muzzle)
 *   │  ├ earL / earR  (tapered prisms, one patch-coloured)
 *   │  └ face         (CanvasTexture plane — swaps per emotion)
 *   ├ legFL/FR/BL/BR  (hip joints)
 *   └ tail0..3        (nested chain, sine-driven)
 */

import * as THREE from 'three';
import { BREEDS, type BreedDef, type BreedId } from '../../data/breeds';
import { hex } from '../../data/palette';
import { box, boxGeo, canvasTexture, disposeTree, flat, mat, mergedBoxes, redrawCanvasTexture, type BoxSpec } from '../voxel';
import type { CosmeticSlot, Outfit } from '../../data/cosmetics';
import { buildCosmetic, mountFor, outfitEntries, type WornItem } from './wardrobe';

/**
 * The body box, in one place.
 *
 * The cat's proportions are encoded in FOUR files — this factory, the animator's rest heights,
 * and the wardrobe's mount points — and every time the body has moved, something has been left
 * behind. The markings shipped hanging off the side of the cat because `catAnimator` hardcoded
 * the OLD body height and re-applied it every frame, which beat whatever the factory placed.
 * Anything that needs to know where the body is imports this instead of restating it.
 */
export const CAT_BODY = { w: 0.4, h: 0.38, d: 0.86, y: 0.55 } as const;

export type CatEmotion = 'neutral' | 'happy' | 'sleep' | 'eat' | 'love' | 'surprised' | 'blink';

export interface CatParts {
  root: THREE.Group;
  body: THREE.Mesh;
  headPivot: THREE.Group;
  head: THREE.Mesh;
  earL: THREE.Group;
  earR: THREE.Group;
  face: THREE.Mesh;
  legs: [THREE.Group, THREE.Group, THREE.Group, THREE.Group];
  tail: THREE.Group[];
  /** Optional flourish holder (antenna, eye glow). */
  extras: THREE.Group;
  faceTexture: THREE.CanvasTexture;
  breed: BreedDef;
  /** Bounding radius on the floor, for path avoidance. */
  radius: number;
  /** What this cat is currently wearing, by slot. */
  worn: Map<CosmeticSlot, WornItem>;
}

const FACE_W = 128;
const FACE_H = 96;

/** Draw one emotion into the face canvas. Chunky pixels only — no anti-aliasing anywhere. */
function drawFace(ctx: CanvasRenderingContext2D, breed: BreedDef, emotion: CatEmotion): void {
  const px = 8; // one "pixel" of the face is 8 canvas px (2x for zoom crispness)
  const P = (x: number, y: number, w = 1, h = 1, color = breed.eye) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * px, y * px, w * px, h * px);
  };

  const eyeL = 2;
  const eyeR = 11;
  const eyeY = 3;

  // Painted, not modelled. A Minecraft cat's eyes are pixels on the head texture — big flat
  // slabs of colour with a dark pupil and one bright glint — and modelling them as spheres,
  // however nice on its own, is the single most un-Minecraft thing you can do to this face.
  const eye = (col: number) => {
    P(col, eyeY, 3, 4); // iris
    P(col + 1, eyeY + 1, 2, 2, '#1A1420'); // pupil
    P(col, eyeY, 1, 1, '#FFFFFF'); // glint
  };

  switch (emotion) {
    case 'sleep':
    case 'blink':
      P(eyeL, eyeY + 2, 3, 1);
      P(eyeR, eyeY + 2, 3, 1);
      break;
    case 'eat':
      P(eyeL, eyeY + 1, 3, 2);
      P(eyeR, eyeY + 1, 3, 2);
      break;
    case 'happy':
    case 'love':
      P(eyeL, eyeY + 2, 1, 1);
      P(eyeL + 1, eyeY + 1, 1, 1);
      P(eyeL + 2, eyeY + 2, 1, 1);
      P(eyeR, eyeY + 2, 1, 1);
      P(eyeR + 1, eyeY + 1, 1, 1);
      P(eyeR + 2, eyeY + 2, 1, 1);
      break;
    case 'surprised':
      P(eyeL, eyeY - 1, 3, 5);
      P(eyeR, eyeY - 1, 3, 5);
      P(eyeL + 1, eyeY + 1, 2, 2, '#1A1420');
      P(eyeR + 1, eyeY + 1, 2, 2, '#1A1420');
      break;
    default:
      eye(eyeL);
      eye(eyeR);
      break;
  }

  // Nose + mouth
  P(7, 8, 2, 1, breed.patch);
  if (emotion === 'happy' || emotion === 'love') {
    P(6, 9, 1, 1, breed.eye);
    P(9, 9, 1, 1, breed.eye);
    P(7, 10, 2, 1, breed.eye);
  } else if (emotion === 'eat') {
    P(6, 9, 4, 2, breed.eye);
  } else {
    P(6, 9, 1, 1, breed.eye);
    P(9, 9, 1, 1, breed.eye);
  }

  // Blush — only when it means something.
  if (emotion === 'happy' || emotion === 'love') {
    ctx.fillStyle = 'rgba(240, 183, 201, 0.85)';
    ctx.fillRect(0 * px, 7 * px, 3 * px, 2 * px);
    ctx.fillRect(13 * px, 7 * px, 3 * px, 2 * px);
  }

  if (emotion === 'love') {
    P(1, 1, 1, 1, '#E8788E');
    P(2, 0, 1, 1, '#E8788E');
    P(3, 1, 1, 1, '#E8788E');
    P(2, 2, 1, 1, '#E8788E');
  }
}

/**
 * How much a wrapping band is inflated past the body, so it does not z-fight with the surface it
 * lies on. Purely visual relief.
 */
export const PATCH_RELIEF = 0.02;

/**
 * The most a marking may protrude from the body, in any axis.
 *
 * Deliberately larger than PATCH_RELIEF: a spot is *allowed* to straddle the top edge and break
 * the silhouette, which is what makes a leopard read as a leopard. What is not allowed is a
 * marking that leaves the cat. For scale, the markings that shipped hanging off the flank
 * overhung by 0.15 to 0.21 — three to four times this — so this catches the real failure while
 * still leaving room for deliberate surface relief.
 */
export const PATCH_MAX_PROUD = 0.05;

/**
 * Coat markings, laid over the body.
 *
 * These are deliberately BOLD — whole bands wrapping the barrel, a rear half in another colour,
 * a sash across the shoulders — rather than the timid scatter of small dots they used to be. At
 * the distance the game is actually played from, a subtle marking is no marking; you get one
 * silhouette and one strong shape per cat, and it should be legible across the room.
 *
 * Every spec here is expressed against CAT_BODY, so when the body changes shape the markings
 * either follow or the test fails. They used to be authored against a body that was 0.72 wide
 * and stayed that way after it shrank to 0.40, which is how a cat shipped wearing a pink slab
 * bigger than itself.
 */
function patchSpecs(breed: BreedDef): BoxSpec[] {
  const { w, h, d } = CAT_BODY;
  // A band that wraps right around the barrel: proud on all four sides, thin along the length.
  const band = (z: number, thickness: number): BoxSpec => ({
    w: w + PATCH_RELIEF,
    h: h + PATCH_RELIEF,
    d: thickness,
    y: 0,
    z,
  });

  switch (breed.style) {
    case 'tabby':
      // Five hard rings of uneven width. Reads as a tiger rather than a tabby, on purpose.
      return [band(-d * 0.36, 0.09), band(-d * 0.16, 0.14), band(d * 0.04, 0.07), band(d * 0.22, 0.12), band(d * 0.4, 0.08)];

    case 'patch':
      // Split the cat. The whole back half is the other colour, with one slab riding up over the
      // shoulder — asymmetric on purpose, so no two sides of the cat agree.
      return [
        { w: w + PATCH_RELIEF, h: h + PATCH_RELIEF, d: d * 0.42, y: 0, z: -d * 0.27 },
        { w: w * 0.55, h: h + PATCH_RELIEF, d: d * 0.26, x: w * 0.26, y: 0, z: d * 0.2 },
      ];

    case 'spots':
      // Big blocks straddling the top edge, so they break the silhouette instead of decorating
      // a flat side.
      return [
        { w: 0.17, h: 0.17, d: 0.17, x: w * 0.34, y: h * 0.34, z: -d * 0.28 },
        { w: 0.13, h: 0.13, d: 0.13, x: -w * 0.38, y: h * 0.22, z: -d * 0.04 },
        { w: 0.15, h: 0.15, d: 0.15, x: w * 0.28, y: -h * 0.2, z: d * 0.24 },
        { w: 0.12, h: 0.12, d: 0.12, x: -w * 0.3, y: h * 0.38, z: d * 0.36 },
        { w: 0.14, h: 0.14, d: 0.14, x: w * 0.2, y: h * 0.42, z: d * 0.06 },
      ];

    case 'tuxedo':
      // A crisp bib and a belly that runs the whole length — the one marking that should read as
      // tidy rather than wild.
      return [
        { w: w * 0.62, h: h * 0.8, d: 0.16, y: -h * 0.1, z: d * 0.44 },
        { w: w + PATCH_RELIEF, h: h * 0.34, d: d * 0.78, y: -h * 0.4, z: -d * 0.04 },
      ];

    case 'petals':
      // A sash of blocks laid diagonally across the back, each turned a different way.
      return [
        { w: 0.15, h: 0.07, d: 0.15, x: w * 0.3, y: h * 0.5, z: d * 0.2, ry: 0.6 },
        { w: 0.17, h: 0.07, d: 0.17, x: 0, y: h * 0.52, z: 0, ry: -0.35 },
        { w: 0.14, h: 0.07, d: 0.14, x: -w * 0.3, y: h * 0.5, z: -d * 0.2, ry: 1.0 },
        { w: 0.12, h: 0.06, d: 0.12, x: w * 0.15, y: h * 0.52, z: -d * 0.38, ry: -0.8 },
      ];

    default:
      return [];
  }
}

/** Exported for the test that stops a marking ever hanging off the cat again. */
export const patchSpecsFor = patchSpecs;

/**
 * Two stacked, narrowing boxes read convincingly as a triangular ear at this scale — and cost
 * two boxes instead of a custom prism geometry. Merged into ONE mesh: a cat is drawn three
 * times a frame (beauty + normals prepass + shadow), so every part saved is three draw calls.
 */
function buildEar(color: number): THREE.Group {
  const g = new THREE.Group();
  // Two blocks, stepped in — the whole ear. Minecraft ears are a couple of pixels on the corner
  // of the skull, and anything more elaborate immediately stops looking like Minecraft.
  const mesh = mergedBoxes(
    [
      { w: 0.12, h: 0.08, d: 0.06, y: 0.04 },
      { w: 0.06, h: 0.06, d: 0.05, y: 0.11 },
    ],
    color,
  );
  if (mesh) g.add(mesh);
  return g;
}

export interface CatFactoryOptions {
  /** Slight per-cat size variation so a room of eight doesn't look cloned. */
  scale?: number;
}

export function createCat(breedId: BreedId, opts: CatFactoryOptions = {}): CatParts {
  const breed = BREEDS[breedId];
  const bodyColor = hex(breed.body);
  const patchColor = hex(breed.patch);
  const earColor = hex(breed.ear);
  const tailColor = hex(breed.tail);

  const root = new THREE.Group();
  root.name = `cat:${breedId}`;
  const scale = opts.scale ?? 1;
  root.scale.setScalar(scale);

  /* ---- body: a loaf of boxes, merged into one mesh ---- */
  // A Minecraft cat is a LONG, NARROW box held well clear of the ground on four tall thin legs,
  // with a small head out front. That daylight under the belly is most of the read: the previous
  // pass had a big round head on a squat body sitting almost on the floor, which is a different
  // animal entirely.
  const bodySpecs: BoxSpec[] = [
    { w: CAT_BODY.w, h: CAT_BODY.h, d: CAT_BODY.d, y: CAT_BODY.y },
    { w: 0.34, h: 0.3, d: 0.16, y: CAT_BODY.y - 0.02, z: 0.46 }, // shoulders
  ];
  const body = mergedBoxes(bodySpecs, bodyColor)!;
  body.name = 'body';
  root.add(body);

  const patches = mergedBoxes(patchSpecs(breed), patchColor);
  if (patches) {
    patches.position.y = CAT_BODY.y;
    patches.name = 'patches';
    root.add(patches);
  }

  /* ---- head ---- */
  const headPivot = new THREE.Group();
  headPivot.name = 'headPivot';
  headPivot.position.set(0, 0.6, 0.5);
  root.add(headPivot);

  const head = mergedBoxes(
    [
      { w: 0.42, h: 0.4, d: 0.4, y: 0.04 }, // a cube, near enough
      { w: 0.2, h: 0.12, d: 0.08, y: -0.06, z: 0.23 }, // stubby muzzle
    ],
    bodyColor,
  )!;
  head.name = 'head';
  headPivot.add(head);

  const earL = buildEar(earColor);
  earL.position.set(-0.13, 0.22, -0.02);
  earL.name = 'earL';
  const earR = buildEar(breed.style === 'patch' ? patchColor : earColor);
  earR.position.set(0.13, 0.22, -0.02);
  earR.name = 'earR';
  headPivot.add(earL, earR);

  const faceTexture = canvasTexture(FACE_W, FACE_H, (ctx) => drawFace(ctx, breed, 'neutral'));
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.36),
    new THREE.MeshBasicMaterial({ map: faceTexture, transparent: true }),
  );
  face.name = 'face';
  face.position.set(0, 0.06, 0.201);
  headPivot.add(face);

  /* ---- legs: hip joints at the top, box hanging below ---- */
  const legOffsets: Array<[number, number]> = [
    [-0.13, 0.3],
    [0.13, 0.3],
    [-0.13, -0.3],
    [0.13, -0.3],
  ];
  const pawColor = breed.style === 'tuxedo' ? patchColor : bodyColor;
  const legs = legOffsets.map(([x, z], i) => {
    const pivot = new THREE.Group();
    pivot.name = `leg${i}`;
    pivot.position.set(x, 0.36, z);
    // Shin and paw merge into one mesh unless the paw is a different colour (tuxedo socks).
    if (pawColor === bodyColor) {
      const leg = mergedBoxes(
        [
          { w: 0.13, h: 0.3, d: 0.13, y: -0.15 },
          { w: 0.15, h: 0.06, d: 0.15, y: -0.33 },
        ],
        bodyColor,
      );
      if (leg) pivot.add(leg);
    } else {
      pivot.add(box({ w: 0.13, h: 0.3, d: 0.13, y: -0.15 }, bodyColor));
      pivot.add(box({ w: 0.15, h: 0.06, d: 0.15, y: -0.33 }, pawColor));
    }
    return pivot;
  }) as CatParts['legs'];
  root.add(...legs);

  /* ---- tail: nested chain so a sine on each joint compounds into a curve ---- */
  const tail: THREE.Group[] = [];
  const SEGMENTS = 4;
  let parent: THREE.Object3D = root;
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = new THREE.Group();
    seg.name = `tail${i}`;
    if (i === 0) {
      seg.position.set(0, 0.62, -0.44);
    } else {
      seg.position.set(0, 0, -0.16);
    }
    const last = i === SEGMENTS - 1;
    const w = 0.1 - i * 0.008;
    const segMesh = box({ w, h: w, d: 0.17, z: -0.08 }, last ? patchColor : tailColor);
    seg.add(segMesh);
    parent.add(seg);
    parent = seg;
    tail.push(seg);
  }

  /* ---- breed flourishes ---- */
  const extras = new THREE.Group();
  extras.name = 'extras';
  root.add(extras);

  if (breed.quirk === 'glow-eyes') {
    const glowGeo = boxGeo(0.1, 0.08, 0.04);
    const glowMat = flat(hex(breed.eye));
    for (const x of [-0.14, 0.14]) {
      const g = new THREE.Mesh(glowGeo, glowMat);
      g.position.set(x, 0.24, 0.3);
      headPivot.add(g);
    }
  }

  if (breed.quirk === 'antenna') {
    const stalk = box({ w: 0.04, h: 0.22, d: 0.04, y: 0.6 }, hex(breed.patch));
    const bulb = new THREE.Mesh(boxGeo(0.11, 0.11, 0.11), flat(hex(breed.eye)));
    bulb.position.set(0, 0.74, 0);
    bulb.name = 'antennaBulb';
    headPivot.add(stalk, bulb);
  }

  if (breed.quirk === 'metallic') {
    body.material = mat(bodyColor, { emissive: bodyColor, emissiveIntensity: 0.15 });
  }

  // Shadows: only the body and head cast. At diorama scale the legs and tail contribute nothing
  // a viewer can see, and the shadow map is a third full scene traversal — this keeps a room of
  // eight cats inside the draw-call budget. The face decal never casts (it would bleed a dark
  // square onto the floor).
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const casts = mesh === body || mesh === head;
    mesh.castShadow = casts;
    mesh.receiveShadow = mesh.name !== 'face';
  });

  return {
    root,
    body,
    headPivot,
    head,
    earL,
    earR,
    face,
    legs,
    tail,
    extras,
    faceTexture,
    breed,
    radius: 0.55 * scale,
    worn: new Map(),
  };
}

/**
 * Dress a cat.
 *
 * Diffs against what is already worn rather than rebuilding: an outfit change in the wardrobe
 * fires on every click, and tearing down four groups per click would churn geometry for no
 * reason. Removed items are disposed, since cosmetic geometry is per-item and not shared.
 */
export function applyOutfit(parts: CatParts, outfit: Outfit): void {
  const wanted = new Map(outfitEntries(outfit));

  for (const [slot, item] of [...parts.worn]) {
    if (wanted.get(slot) === item.id) continue;
    disposeTree(item.group);
    parts.worn.delete(slot);
  }

  for (const [slot, id] of wanted) {
    if (parts.worn.get(slot)?.id === id) continue;
    const item = buildCosmetic(id);
    if (!item) continue;
    mountFor(slot, parts).add(item.group);
    parts.worn.set(slot, item);
  }
}

/** Swap the face decal. Cheap — redraws one 64×48 canvas, no new GPU allocation. */
export function setEmotion(parts: CatParts, emotion: CatEmotion): void {
  redrawCanvasTexture(parts.faceTexture, (ctx) => drawFace(ctx, parts.breed, emotion));
}

/**
 * A tiny name tag that floats over a bonded cat. Colour is earned: bond level tints it, which
 * is the only place in the product where a number becomes visible decoration.
 */
export function createNameTag(name: string, tint: string): THREE.Sprite {
  // Multiplayer labels read "Mochi (Alice)", so the tag is sized for a name plus an owner
  // rather than a name alone, and the texture width tracks the text so a short name does not
  // float in the middle of an oversized plaque.
  const label = name.slice(0, 22).toUpperCase();
  const width = Math.max(256, Math.min(640, 40 + label.length * 26));
  const tex = canvasTexture(width, 72, (ctx) => {
    ctx.fillStyle = 'rgba(59, 42, 68, 0.88)';
    ctx.fillRect(0, 0, width, 72);
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, width, 7);
    ctx.font = '26px "Silkscreen", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FBF2F4';
    ctx.fillText(label, width / 2, 42);
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set((width / 256) * 1.25, 0.36, 1);
  sprite.position.y = 1.62;
  sprite.renderOrder = 10;
  return sprite;
}
