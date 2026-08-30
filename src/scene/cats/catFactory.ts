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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BREEDS, type BreedDef, type BreedId } from '../../data/breeds';
import { hex } from '../../data/palette';
import { box, boxGeo, canvasTexture, disposeTree, flat, mat, mergedBoxes, mergedRounded, redrawCanvasTexture, roundedBox, toonGradient, type BoxSpec } from '../voxel';
import type { CosmeticSlot, Outfit } from '../../data/cosmetics';
import { buildCosmetic, mountFor, outfitEntries, type WornItem } from './wardrobe';

export type CatEmotion = 'neutral' | 'happy' | 'sleep' | 'eat' | 'love' | 'surprised' | 'blink';

export interface CatParts {
  root: THREE.Group;
  body: THREE.Mesh;
  headPivot: THREE.Group;
  head: THREE.Mesh;
  earL: THREE.Group;
  earR: THREE.Group;
  face: THREE.Mesh;
  /** Both eyeballs as one textured mesh. Emotions squash it; the canvas draws the lids over it. */
  eyes: THREE.Mesh;
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

  const eyeL = 3;
  const eyeR = 10;
  const eyeY = 4;

  // The EYES ARE NO LONGER PAINTED HERE — they are real geometry (see buildEyes). A painted eye
  // on a flat plane is the single biggest reason these cats read as boxes: at any distance the
  // face is a sticker, and a sticker has no highlight that moves when the head turns.
  //
  // What survives on the canvas is everything that genuinely IS flat on a cat's face: the
  // closed-eye line, the brow shape for a squint, the nose, the mouth and the blush.
  switch (emotion) {
    case 'sleep':
    case 'blink':
    case 'eat':
      // ‾‾ closed lids, drawn over the eyeballs which shrink to nothing underneath.
      P(eyeL, eyeY + 1, 3, 1);
      P(eyeR, eyeY + 1, 3, 1);
      break;
    case 'happy':
    case 'love':
      // ^‿^ — two carets, again over shrunken eyeballs.
      P(eyeL, eyeY + 1, 1, 1);
      P(eyeL + 1, eyeY, 1, 1);
      P(eyeL + 2, eyeY + 1, 1, 1);
      P(eyeR, eyeY + 1, 1, 1);
      P(eyeR + 1, eyeY, 1, 1);
      P(eyeR + 2, eyeY + 1, 1, 1);
      break;
    default:
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
 * The eyes, as actual volume.
 *
 * Both eyes are ONE mesh: two spheres merged, sharing a single tiny canvas texture that carries
 * the sclera, the iris, the pupil and the specular dot. That is what buys the whole effect for
 * one extra draw call per cat instead of four — and the highlight now sits on a curved surface,
 * so it slides as the head turns, which a painted dot cannot do.
 */
function eyeTexture(breed: BreedDef): THREE.CanvasTexture {
  return canvasTexture(32, 32, (ctx) => {
    ctx.fillStyle = '#FBF6EE';
    ctx.fillRect(0, 0, 32, 32);
    // Iris, then pupil, then the highlight — concentric and offset up-left, which is where the
    // key light is in every room.
    const disc = (cx: number, cy: number, r: number, colour: string) => {
      ctx.fillStyle = colour;
      for (let y = -r; y <= r; y++) {
        const span = Math.round(Math.sqrt(Math.max(0, r * r - y * y)));
        ctx.fillRect(cx - span, cy + y, span * 2, 1);
      }
    };
    disc(16, 16, 12, breed.eye);
    disc(16, 17, 7, '#2A1F33');
    // One small specular dot, up and to the left, where the key light is in every room. It is
    // the whole difference between an eye and a bead.
    disc(12, 11, 2, '#FFFFFF');
  });
}

function buildEyes(breed: BreedDef): { mesh: THREE.Mesh; texture: THREE.CanvasTexture } {
  const texture = eyeTexture(breed);
  const geos: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    // Big, and set wide apart. Eye size relative to head is most of what makes a character read
    // as appealing rather than as a model of an animal.
    //
    // phiStart is -90 degrees on purpose. A sphere's UVs wrap equirectangularly and u=0.25 lands
    // on +z by default, so an iris drawn at the middle of the texture ends up on the SIDE of the
    // eyeball, facing the cat's ear. Starting phi a quarter-turn back puts u=0.5 — the middle of
    // the canvas, where the iris is — squarely on the front of the eye.
    const g = new THREE.SphereGeometry(0.125, 14, 12, -Math.PI / 2, Math.PI * 2);
    g.translate(sx * 0.155, 0, 0);
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  // Toon-shaded, not unlit: an unlit eye is at full brightness in every room, so in the café at
  // night the cats read as headlights. A faint emissive keeps them alive in the dark without
  // making them lamps.
  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshToonMaterial({
      map: texture,
      gradientMap: toonGradient(),
      emissive: 0xffffff,
      emissiveIntensity: 0.18,
      emissiveMap: texture,
    }),
  );
  mesh.name = 'eyes';
  mesh.castShadow = false;
  return { mesh, texture };
}

/** Patch boxes layered over the body, per breed style. */
function patchSpecs(breed: BreedDef): BoxSpec[] {
  switch (breed.style) {
    case 'patch':
      return [
        { w: 0.5, h: 0.34, d: 0.62, x: 0.16, y: 0.06, z: -0.02 },
        { w: 0.3, h: 0.26, d: 0.3, x: -0.3, y: 0.12, z: 0.2 },
      ];
    case 'spots':
      return [
        { w: 0.22, h: 0.2, d: 0.22, x: 0.24, y: 0.2, z: 0.1 },
        { w: 0.18, h: 0.16, d: 0.18, x: -0.12, y: 0.24, z: -0.18 },
        { w: 0.2, h: 0.18, d: 0.2, x: 0.05, y: 0.05, z: 0.26 },
        { w: 0.16, h: 0.14, d: 0.16, x: -0.3, y: 0.1, z: 0.05 },
      ];
    case 'tabby':
      return [
        { w: 0.62, h: 0.08, d: 0.14, x: 0, y: 0.28, z: -0.18 },
        { w: 0.62, h: 0.08, d: 0.14, x: 0, y: 0.28, z: 0.06 },
        { w: 0.5, h: 0.08, d: 0.12, x: 0, y: 0.26, z: 0.28 },
      ];
    case 'tuxedo':
      return [
        { w: 0.34, h: 0.4, d: 0.3, x: 0, y: -0.02, z: 0.34 },
        { w: 0.2, h: 0.16, d: 0.2, x: 0, y: -0.2, z: 0.24 },
      ];
    case 'petals':
      return [
        { w: 0.14, h: 0.06, d: 0.14, x: 0.2, y: 0.3, z: 0.1, ry: 0.6 },
        { w: 0.12, h: 0.06, d: 0.12, x: -0.18, y: 0.3, z: -0.12, ry: -0.4 },
        { w: 0.1, h: 0.05, d: 0.1, x: 0.05, y: 0.32, z: 0.3, ry: 1.1 },
      ];
    default:
      return [];
  }
}

/**
 * Two stacked, narrowing boxes read convincingly as a triangular ear at this scale — and cost
 * two boxes instead of a custom prism geometry. Merged into ONE mesh: a cat is drawn three
 * times a frame (beauty + normals prepass + shadow), so every part saved is three draw calls.
 */
function buildEar(color: number): THREE.Group {
  const g = new THREE.Group();
  // Four narrowing slabs read as a cone at this scale and keep the voxel family, where an
  // actual ConeGeometry would be the only smooth-sided thing on the whole cat.
  const specs: BoxSpec[] = [];
  for (let i = 0; i < 4; i++) {
    const w = 0.2 - i * 0.042;
    specs.push({ w, h: 0.075, d: Math.max(0.05, 0.09 - i * 0.012), y: 0.037 + i * 0.072 });
  }
  const mesh = mergedRounded(specs, color, 0.022);
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
  // Proportions are the whole game here. A cat reads as appealing when the head is the big
  // shape and the body is the small one; the old loaf was 0.72 x 0.46 x 0.90 under a 0.66 head,
  // which is a realistic animal and therefore a forgettable one. The body has come DOWN and the
  // head has gone UP so the head is now decisively the larger mass.
  const bodySpecs: BoxSpec[] = [
    { w: 0.62, h: 0.42, d: 0.74, y: 0.3 },
    { w: 0.54, h: 0.34, d: 0.26, y: 0.27, z: 0.36 }, // chest
    { w: 0.56, h: 0.36, d: 0.24, y: 0.31, z: -0.35 }, // haunches
  ];
  const body = mergedRounded(bodySpecs, bodyColor, 0.19)!;
  body.name = 'body';
  root.add(body);

  const patches = mergedBoxes(patchSpecs(breed), patchColor);
  if (patches) {
    patches.position.y = 0.34;
    patches.name = 'patches';
    root.add(patches);
  }

  /* ---- head ---- */
  const headPivot = new THREE.Group();
  headPivot.name = 'headPivot';
  headPivot.position.set(0, 0.46, 0.42);
  root.add(headPivot);

  const head = mergedRounded(
    [
      { w: 0.82, h: 0.74, d: 0.72, y: 0.3 }, // the big shape
      { w: 0.3, h: 0.17, d: 0.12, y: 0.19, z: 0.38 }, // muzzle
    ],
    bodyColor,
    0.27,
  )!;
  head.name = 'head';
  headPivot.add(head);

  const earL = buildEar(earColor);
  earL.position.set(-0.24, 0.6, 0.0);
  earL.name = 'earL';
  const earR = buildEar(breed.style === 'patch' ? patchColor : earColor);
  earR.position.set(0.24, 0.6, 0.0);
  earR.name = 'earR';
  headPivot.add(earL, earR);

  const faceTexture = canvasTexture(FACE_W, FACE_H, (ctx) => drawFace(ctx, breed, 'neutral'));
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.64, 0.48),
    new THREE.MeshBasicMaterial({ map: faceTexture, transparent: true }),
  );
  face.name = 'face';
  face.position.set(0, 0.34, 0.366);
  headPivot.add(face);

  // Real eyes, standing proud of the face decal so the highlight catches at a grazing angle.
  const { mesh: eyes } = buildEyes(breed);
  eyes.position.set(0, 0.37, 0.35);
  headPivot.add(eyes);

  /* ---- legs: hip joints at the top, box hanging below ---- */
  const legOffsets: Array<[number, number]> = [
    [-0.22, 0.3],
    [0.22, 0.3],
    [-0.24, -0.3],
    [0.24, -0.3],
  ];
  const pawColor = breed.style === 'tuxedo' ? patchColor : bodyColor;
  const legs = legOffsets.map(([x, z], i) => {
    const pivot = new THREE.Group();
    pivot.name = `leg${i}`;
    pivot.position.set(x, 0.24, z);
    // Shin and paw merge into one mesh unless the paw is a different colour (tuxedo socks).
    if (pawColor === bodyColor) {
      const leg = mergedRounded(
        [
          { w: 0.17, h: 0.26, d: 0.17, y: -0.13 },
          { w: 0.19, h: 0.08, d: 0.19, y: -0.26 },
        ],
        bodyColor,
        0.075,
      );
      if (leg) pivot.add(leg);
    } else {
      pivot.add(box({ w: 0.17, h: 0.26, d: 0.17, y: -0.13 }, bodyColor));
      pivot.add(box({ w: 0.19, h: 0.08, d: 0.19, y: -0.26 }, pawColor));
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
      seg.position.set(0, 0.4, -0.42);
    } else {
      seg.position.set(0, 0, -0.16);
    }
    const last = i === SEGMENTS - 1;
    const w = 0.145 - i * 0.016;
    const segMesh = roundedBox({ w, h: w, d: 0.17, z: -0.08 }, last ? patchColor : tailColor, 0.055);
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
    eyes,
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
/**
 * How wide the eyes are open, per emotion. The canvas draws the lid shape on top; this is the
 * eyeball underneath, so a blink actually closes something rather than swapping a sticker.
 */
const EYE_OPENNESS: Record<CatEmotion, { x: number; y: number }> = {
  neutral: { x: 1, y: 1 },
  happy: { x: 1, y: 0.18 },
  love: { x: 1, y: 0.18 },
  sleep: { x: 1, y: 0.06 },
  blink: { x: 1, y: 0.06 },
  eat: { x: 1, y: 0.35 },
  surprised: { x: 1.18, y: 1.18 },
};

export function setEmotion(parts: CatParts, emotion: CatEmotion): void {
  redrawCanvasTexture(parts.faceTexture, (ctx) => drawFace(ctx, parts.breed, emotion));
  const open = EYE_OPENNESS[emotion] ?? EYE_OPENNESS.neutral;
  parts.eyes.scale.set(open.x, open.y, 1);
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
