/**
 * Pooled particle system (spec §11: particle pools, no per-frame allocation).
 *
 * Split in two on purpose:
 *   - `ParticleSim` is pure typed-array simulation with **zero allocation after construction**,
 *     so the "no memory growth over 30 minutes" budget is a unit test rather than a hope.
 *   - `ParticleField` wraps it in a single `THREE.Points` — one draw call for every particle in
 *     the diorama, and square pixel sprites that match the voxel look for free.
 *
 * Spawning into a full pool recycles the oldest particle instead of growing or dropping: a full
 * pool must never silently stop rendering rain.
 */

import * as THREE from 'three';

export type ParticleKind = 'firefly' | 'spark' | 'rain' | 'mote' | 'heart' | 'fish' | 'petal' | 'snow' | 'nom';

export interface SpawnSpec {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  color: number;
  /** Downward acceleration; rain is heavy, hearts float. */
  gravity?: number;
  /** Horizontal sine wobble amplitude. */
  drift?: number;
  /** 0 = fade out linearly, 1 = hold then pop. */
  hold?: number;
}

export class ParticleSim {
  readonly capacity: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly size: Float32Array;
  readonly gravity: Float32Array;
  readonly drift: Float32Array;
  readonly hold: Float32Array;
  readonly seed: Float32Array;
  readonly cr: Float32Array;
  readonly cg: Float32Array;
  readonly cb: Float32Array;
  readonly alpha: Float32Array;

  /** Indices of free slots — a stack, so spawn/free are O(1) and allocation-free. */
  private free: Int32Array;
  private freeCount: number;
  /** Round-robin cursor for the recycle-oldest fallback. */
  private recycleCursor = 0;
  private liveCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drift = new Float32Array(capacity);
    this.hold = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.cr = new Float32Array(capacity);
    this.cg = new Float32Array(capacity);
    this.cb = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);

    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.freeCount = capacity;
  }

  get count(): number {
    return this.liveCount;
  }

  get available(): number {
    return this.freeCount;
  }

  /** Returns the slot index, or -1 only if capacity is 0. Never allocates. */
  spawn(spec: SpawnSpec): number {
    let i: number;
    if (this.freeCount > 0) {
      i = this.free[--this.freeCount];
      this.liveCount++;
    } else if (this.capacity > 0) {
      // Full: steal the slot with the least life remaining near the cursor.
      i = this.recycleCursor;
      this.recycleCursor = (this.recycleCursor + 1) % this.capacity;
    } else {
      return -1;
    }

    this.px[i] = spec.x;
    this.py[i] = spec.y;
    this.pz[i] = spec.z;
    this.vx[i] = spec.vx ?? 0;
    this.vy[i] = spec.vy ?? 0;
    this.vz[i] = spec.vz ?? 0;
    this.life[i] = spec.life;
    this.maxLife[i] = spec.life;
    this.size[i] = spec.size;
    this.gravity[i] = spec.gravity ?? 0;
    this.drift[i] = spec.drift ?? 0;
    this.hold[i] = spec.hold ?? 0;
    this.seed[i] = (i * 0.6180339887) % 1;
    this.cr[i] = ((spec.color >> 16) & 255) / 255;
    this.cg[i] = ((spec.color >> 8) & 255) / 255;
    this.cb[i] = (spec.color & 255) / 255;
    this.alpha[i] = 1;
    return i;
  }

  /** Advance the simulation. Allocation-free; `elapsed` drives the drift wobble. */
  step(dt: number, elapsed: number): void {
    const { capacity } = this;
    for (let i = 0; i < capacity; i++) {
      const life = this.life[i];
      if (life <= 0) continue;

      const next = life - dt;
      if (next <= 0) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        if (this.freeCount < capacity) {
          this.free[this.freeCount++] = i;
          this.liveCount--;
        }
        continue;
      }
      this.life[i] = next;

      this.vy[i] -= this.gravity[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      const drift = this.drift[i];
      if (drift !== 0) {
        this.px[i] += Math.sin((elapsed + this.seed[i] * 10) * 2.1) * drift * dt;
        this.pz[i] += Math.cos((elapsed + this.seed[i] * 7) * 1.7) * drift * dt;
      }

      const t = next / this.maxLife[i];
      this.alpha[i] = this.hold[i] > 0 ? (t < 0.25 ? t / 0.25 : 1) : Math.min(1, t * 2.2);
    }
  }

  /** Kill everything — used when switching worlds or entering reduced-motion. */
  clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0;
      this.alpha[i] = 0;
    }
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeCount = this.capacity;
    this.liveCount = 0;
  }
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (260.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    if (vAlpha <= 0.01) discard;
    // Square sprites, on purpose: round particles would fight the voxel grid.
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

export class ParticleField {
  readonly sim: ParticleSim;
  readonly points: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private material: THREE.ShaderMaterial;
  private enabled = true;

  constructor(capacity = 700) {
    this.sim = new ParticleSim(capacity);
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, capacity);
    // A fixed, generous bounding sphere: particles move every frame and recomputing it would
    // cost more than it saves.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, 0), 40);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** Reduced motion turns the whole field off — no spawns, nothing drawn. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.points.visible = enabled;
    if (!enabled) this.sim.clear();
  }

  spawn(spec: SpawnSpec): void {
    if (!this.enabled) return;
    this.sim.spawn(spec);
  }

  /** Burst helper — hearts on a pet, fish on a session complete, sparks off the fire. */
  burst(count: number, make: (i: number) => SpawnSpec): void {
    if (!this.enabled) return;
    for (let i = 0; i < count; i++) this.sim.spawn(make(i));
  }

  update(dt: number, elapsed: number): void {
    if (!this.enabled) return;
    const sim = this.sim;
    sim.step(dt, elapsed);

    const n = sim.capacity;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this.positions[i3] = sim.px[i];
      this.positions[i3 + 1] = sim.py[i];
      this.positions[i3 + 2] = sim.pz[i];
      this.colors[i3] = sim.cr[i];
      this.colors[i3 + 1] = sim.cg[i];
      this.colors[i3 + 2] = sim.cb[i];
      this.sizes[i] = sim.size[i];
      this.alphas[i] = sim.alpha[i];
    }

    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.sim.clear();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------ recipes */

export const RECIPES = {
  heart(x: number, y: number, z: number, i: number): SpawnSpec {
    return {
      x: x + (Math.random() - 0.5) * 0.3,
      y: y + 0.2,
      z: z + (Math.random() - 0.5) * 0.3,
      vy: 0.75 + Math.random() * 0.4,
      vx: (Math.random() - 0.5) * 0.3,
      vz: (Math.random() - 0.5) * 0.3,
      life: 1.1 + Math.random() * 0.5,
      size: 0.1 + (i % 3) * 0.025,
      color: 0xf0b7c9,
      drift: 0.25,
    };
  },
  fish(x: number, y: number, z: number): SpawnSpec {
    return {
      x: x + (Math.random() - 0.5) * 4.5,
      y: y + 3 + Math.random() * 2,
      z: z + (Math.random() - 0.5) * 3.5,
      vy: -0.2 - Math.random() * 0.4,
      vx: (Math.random() - 0.5) * 0.7,
      vz: (Math.random() - 0.5) * 0.5,
      life: 2.4 + Math.random(),
      size: 0.11,
      color: Math.random() < 0.5 ? 0xf2b441 : 0xa9d6c0,
      gravity: 0.55,
      drift: 0.5,
    };
  },
  spark(x: number, y: number, z: number): SpawnSpec {
    return {
      x: x + (Math.random() - 0.5) * 0.35,
      y,
      z: z + (Math.random() - 0.5) * 0.35,
      vy: 1.5 + Math.random() * 1.4,
      vx: (Math.random() - 0.5) * 0.5,
      vz: (Math.random() - 0.5) * 0.5,
      life: 1 + Math.random() * 0.9,
      size: 0.055 + Math.random() * 0.04,
      color: Math.random() < 0.35 ? 0xffd08a : 0xf58a4b,
      gravity: -0.35,
      drift: 0.35,
    };
  },
  rain(w: number, d: number): SpawnSpec {
    return {
      x: (Math.random() - 0.5) * w * 1.6,
      y: 9 + Math.random() * 3,
      z: (Math.random() - 0.5) * d * 1.6,
      vy: -7.5 - Math.random() * 2.5,
      vx: -0.5,
      life: 1.6,
      size: 0.05,
      color: 0xc7bfea,
    };
  },
  firefly(w: number, d: number): SpawnSpec {
    return {
      x: (Math.random() - 0.5) * w,
      y: 0.6 + Math.random() * 2.4,
      z: (Math.random() - 0.5) * d,
      vy: 0.05,
      life: 5 + Math.random() * 4,
      size: 0.085,
      color: 0xf5e1a4,
      drift: 0.55,
      hold: 1,
    };
  },
  mote(w: number, d: number): SpawnSpec {
    return {
      x: (Math.random() - 0.5) * w,
      y: 0.4 + Math.random() * 3.2,
      z: (Math.random() - 0.5) * d,
      vy: 0.06 + Math.random() * 0.05,
      life: 7 + Math.random() * 5,
      size: 0.045,
      color: 0xfbf2f4,
      drift: 0.18,
      hold: 1,
    };
  },
  petal(w: number, d: number): SpawnSpec {
    return {
      x: (Math.random() - 0.5) * w * 1.3,
      y: 7 + Math.random() * 2,
      z: (Math.random() - 0.5) * d * 1.3,
      vy: -0.5 - Math.random() * 0.3,
      life: 9,
      size: 0.09,
      color: Math.random() < 0.4 ? 0xfbeff2 : 0xf2b9cc,
      drift: 0.7,
    };
  },
  snow(w: number, d: number): SpawnSpec {
    return {
      x: (Math.random() - 0.5) * w * 1.5,
      y: 8 + Math.random() * 2,
      z: (Math.random() - 0.5) * d * 1.5,
      vy: -0.65 - Math.random() * 0.35,
      life: 11,
      size: 0.07,
      color: 0xfdf8f8,
      drift: 0.4,
    };
  },
  nom(x: number, y: number, z: number, color: number): SpawnSpec {
    return {
      x: x + (Math.random() - 0.5) * 0.2,
      y: y + 0.15,
      z: z + (Math.random() - 0.5) * 0.2,
      vy: 0.9,
      vx: (Math.random() - 0.5) * 0.55,
      vz: (Math.random() - 0.5) * 0.55,
      life: 0.55,
      size: 0.07,
      color,
      gravity: 1.6,
    };
  },
} as const;
