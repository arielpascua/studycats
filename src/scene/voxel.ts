/**
 * Voxel building blocks. Everything in the diorama is a box; the whole visual identity depends
 * on that staying true, so this module is the only place geometry is created.
 *
 * Two performance rules live here and nowhere else (spec §11, ≤300 draw calls):
 *  - **geometry is cached by size** — a thousand 1×1×1 boxes share one BufferGeometry;
 *  - **materials are cached by colour** — one MeshToonMaterial per hex across the whole app.
 * Static parts are merged into a single geometry per group before they ever reach the scene.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const geoCache = new Map<string, THREE.BoxGeometry>();
const matCache = new Map<string, THREE.MeshToonMaterial>();
const basicCache = new Map<string, THREE.MeshBasicMaterial>();
let gradientMap: THREE.DataTexture | null = null;

/** Two-step toon ramp: lit and shadowed, nothing in between. Sells the poster look. */
export function toonGradient(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const steps = new Uint8Array([120, 190, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientMap = tex;
  return tex;
}

export function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geoCache.set(key, g);
  }
  return g;
}

export interface MatOptions {
  transparent?: boolean;
  opacity?: number;
  emissive?: number;
  emissiveIntensity?: number;
}

/** Shared toon material for a colour. Never mutate the result — clone if you must. */
export function mat(color: number, opts: MatOptions = {}): THREE.MeshToonMaterial {
  const key = `${color}|${opts.transparent ? 1 : 0}|${opts.opacity ?? 1}|${opts.emissive ?? -1}|${opts.emissiveIntensity ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({
      color,
      gradientMap: toonGradient(),
      transparent: Boolean(opts.transparent),
      opacity: opts.opacity ?? 1,
    });
    if (opts.emissive !== undefined) {
      m.emissive = new THREE.Color(opts.emissive);
      m.emissiveIntensity = opts.emissiveIntensity ?? 1;
    }
    matCache.set(key, m);
  }
  return m;
}

/** Unlit material — for glowing eyes, fire cores, UI-ish decals. */
export function flat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}`;
  let m = basicCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
    basicCache.set(key, m);
  }
  return m;
}

export interface BoxSpec {
  w: number;
  h: number;
  d: number;
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
}

export function box(spec: BoxSpec, color: number, opts: MatOptions = {}): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo(spec.w, spec.h, spec.d), mat(color, opts));
  m.position.set(spec.x ?? 0, spec.y ?? 0, spec.z ?? 0);
  m.rotation.set(spec.rx ?? 0, spec.ry ?? 0, spec.rz ?? 0);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Merge a set of same-coloured boxes into one mesh — the workhorse for static scenery.
 * Returns null for an empty list so callers can skip adding anything.
 */
export function mergedBoxes(specs: readonly BoxSpec[], color: number, opts: MatOptions = {}): THREE.Mesh | null {
  if (specs.length === 0) return null;
  const geos: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const s of specs) {
    const g = boxGeo(s.w, s.h, s.d).clone();
    e.set(s.rx ?? 0, s.ry ?? 0, s.rz ?? 0);
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(s.x ?? 0, s.y ?? 0, s.z ?? 0), q, one);
    g.applyMatrix4(m);
    geos.push(g);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, mat(color, opts));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A group builder that batches by colour: hand it many boxes in many colours and it emits one
 * merged mesh per colour. This is how a whole room stays under a handful of draw calls.
 */
export class BoxBatch {
  private byColor = new Map<number, BoxSpec[]>();

  add(spec: BoxSpec, color: number): this {
    let list = this.byColor.get(color);
    if (!list) {
      list = [];
      this.byColor.set(color, list);
    }
    list.push(spec);
    return this;
  }

  /** Convenience for repeated rows/grids. */
  addMany(specs: readonly BoxSpec[], color: number): this {
    for (const s of specs) this.add(s, color);
    return this;
  }

  build(name = 'batch'): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [color, specs] of this.byColor) {
      const mesh = mergedBoxes(specs, color);
      if (mesh) {
        mesh.name = `${name}:${color.toString(16)}`;
        group.add(mesh);
      }
    }
    return group;
  }

  get drawCalls(): number {
    return this.byColor.size;
  }
}

/**
 * Recursively dispose a subtree's *non-shared* resources. Cached geometry and materials are
 * intentionally left alone — they're shared app-wide and disposing them would blank the scene.
 */
export function disposeTree(root: THREE.Object3D): void {
  const sharedGeos = new Set(geoCache.values());
  const sharedMats = new Set<THREE.Material>([...matCache.values(), ...basicCache.values()]);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry && !sharedGeos.has(mesh.geometry as THREE.BoxGeometry)) {
      mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m || sharedMats.has(m)) continue;
      const anyMat = m as THREE.Material & { map?: THREE.Texture | null };
      if (anyMat.map) anyMat.map.dispose();
      m.dispose();
    }
  });
  root.parent?.remove(root);
  root.clear();
}

/** Test/debug: how many cached objects are alive. */
export function cacheStats(): { geometries: number; materials: number } {
  return { geometries: geoCache.size, materials: matCache.size + basicCache.size };
}

/**
 * Nearest-neighbour canvas texture — pixel text on the laptop screen, cat faces, posters.
 * Always power-of-two-ish and never mipmapped, so it stays crisp under the pixelation pass.
 */
export function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    draw(ctx);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Redraw an existing canvas texture in place — avoids churning GPU allocations every second. */
export function redrawCanvasTexture(tex: THREE.CanvasTexture, draw: (ctx: CanvasRenderingContext2D) => void): void {
  const canvas = tex.image as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  draw(ctx);
  tex.needsUpdate = true;
}

export const TAU = Math.PI * 2;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent smoothing — `damp(x, target, lambda, dt)`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
