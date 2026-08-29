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
import { box, boxGeo, canvasTexture, flat, mat, mergedBoxes, redrawCanvasTexture, type BoxSpec } from '../voxel';

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

  switch (emotion) {
    case 'sleep':
    case 'blink':
      // ‾‾ closed eyes
      P(eyeL, eyeY + 1, 3, 1);
      P(eyeR, eyeY + 1, 3, 1);
      break;
    case 'happy':
    case 'love':
      // ^‿^ — two carets
      P(eyeL, eyeY + 1, 1, 1);
      P(eyeL + 1, eyeY, 1, 1);
      P(eyeL + 2, eyeY + 1, 1, 1);
      P(eyeR, eyeY + 1, 1, 1);
      P(eyeR + 1, eyeY, 1, 1);
      P(eyeR + 2, eyeY + 1, 1, 1);
      break;
    case 'surprised':
      P(eyeL, eyeY - 1, 3, 4);
      P(eyeR, eyeY - 1, 3, 4);
      P(eyeL + 1, eyeY, 1, 1, '#FFFFFF');
      P(eyeR + 1, eyeY, 1, 1, '#FFFFFF');
      break;
    case 'eat':
      P(eyeL, eyeY + 1, 3, 1);
      P(eyeR, eyeY + 1, 3, 1);
      break;
    default:
      P(eyeL, eyeY, 3, 3);
      P(eyeR, eyeY, 3, 3);
      // A single specular pixel is what makes them read as alive.
      P(eyeL + 2, eyeY, 1, 1, '#FFFFFF');
      P(eyeR + 2, eyeY, 1, 1, '#FFFFFF');
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
  const mesh = mergedBoxes(
    [
      { w: 0.18, h: 0.12, d: 0.07, y: 0.06 },
      { w: 0.1, h: 0.1, d: 0.06, y: 0.17 },
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
  const bodySpecs: BoxSpec[] = [
    { w: 0.72, h: 0.46, d: 0.9, y: 0.34 },
    { w: 0.6, h: 0.36, d: 0.3, y: 0.3, z: 0.44 }, // chest
    { w: 0.64, h: 0.4, d: 0.28, y: 0.36, z: -0.42 }, // haunches
  ];
  const body = mergedBoxes(bodySpecs, bodyColor)!;
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
  headPivot.position.set(0, 0.52, 0.5);
  root.add(headPivot);

  const head = mergedBoxes(
    [
      { w: 0.66, h: 0.56, d: 0.56, y: 0.2 }, // oversized skull
      { w: 0.3, h: 0.18, d: 0.14, y: 0.12, z: 0.31 }, // muzzle
    ],
    bodyColor,
  )!;
  head.name = 'head';
  headPivot.add(head);

  const earL = buildEar(earColor);
  earL.position.set(-0.2, 0.44, 0.02);
  earL.name = 'earL';
  const earR = buildEar(breed.style === 'patch' ? patchColor : earColor);
  earR.position.set(0.2, 0.44, 0.02);
  earR.name = 'earR';
  headPivot.add(earL, earR);

  const faceTexture = canvasTexture(FACE_W, FACE_H, (ctx) => drawFace(ctx, breed, 'neutral'));
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.42),
    new THREE.MeshBasicMaterial({ map: faceTexture, transparent: true }),
  );
  face.name = 'face';
  face.position.set(0, 0.22, 0.286);
  headPivot.add(face);

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
      const leg = mergedBoxes(
        [
          { w: 0.17, h: 0.26, d: 0.17, y: -0.13 },
          { w: 0.19, h: 0.08, d: 0.19, y: -0.26 },
        ],
        bodyColor,
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
      seg.position.set(0, 0.46, -0.5);
    } else {
      seg.position.set(0, 0, -0.16);
    }
    const last = i === SEGMENTS - 1;
    const w = 0.145 - i * 0.016;
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

  return { root, body, headPivot, head, earL, earR, face, legs, tail, extras, faceTexture, breed, radius: 0.55 * scale };
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
  const tex = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = 'rgba(59, 42, 68, 0.86)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, 256, 6);
    ctx.font = '28px "Silkscreen", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FBF2F4';
    ctx.fillText(name.slice(0, 12).toUpperCase(), 128, 38);
  });
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(0.9, 0.22, 1);
  sprite.position.y = 1.5;
  sprite.renderOrder = 10;
  return sprite;
}
