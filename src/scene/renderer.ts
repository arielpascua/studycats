/**
 * Renderer + post-processing chain. This is where the "HD-pixel" look is manufactured:
 *
 *   scene ──▶ PixelPass ──▶ UnrealBloomPass ──▶ OutputPass ──▶ canvas
 *
 * The pixelated pass renders at 1/pixelSize resolution with nearest-neighbour upscaling, which
 * is also why the whole thing is cheap: fill rate scales with 1/pixelSize².
 *
 * Reduced motion and the "Crisp ↔ Chunky" slider both land here rather than being sprinkled
 * through the scene code.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { PixelPass } from './fx/pixelPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export type FilterId = 'none' | 'warm' | 'night' | 'grain';

/**
 * Photo-mode filters, as one small shader rather than four passes. Kept intentionally gentle:
 * a filter should look like film stock, not like an Instagram preset from 2011.
 */
const FilterShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uWarm: { value: 0 },
    uNight: { value: 0 },
    uGrain: { value: 0 },
    uTime: { value: 0 },
    uVignette: { value: 0.18 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uWarm;
    uniform float uNight;
    uniform float uGrain;
    uniform float uTime;
    uniform float uVignette;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);

      // Warm: lift reds, pull a little blue, raise the black point (paper, not print).
      vec3 warm = col.rgb * vec3(1.06, 1.00, 0.92) + vec3(0.035, 0.012, 0.0);
      col.rgb = mix(col.rgb, warm, uWarm);

      // Night: cool desaturate toward the deep plum in the palette.
      float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
      vec3 night = mix(vec3(luma), col.rgb, 0.55) * vec3(0.78, 0.80, 1.05) + vec3(0.02, 0.01, 0.05);
      col.rgb = mix(col.rgb, night, uNight);

      // Grain, quantised so it stays on the pixel grid rather than shimmering.
      if (uGrain > 0.001) {
        vec2 cell = floor(vUv * 220.0);
        float n = hash(cell + floor(uTime * 8.0));
        col.rgb += (n - 0.5) * 0.09 * uGrain;
      }

      // A whisper of vignette so the diorama reads as an object with edges.
      float d = distance(vUv, vec2(0.5));
      col.rgb *= 1.0 - uVignette * smoothstep(0.35, 0.95, d);

      gl_FragColor = col;
    }
  `,
};

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pixelScale?: number;
  bloom?: number;
  shadows?: boolean;
}

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  private pixelPass: PixelPass;
  private bloomPass: UnrealBloomPass;
  private filterPass: ShaderPass;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private pixelScale: number;
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(opts: RendererOptions) {
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.pixelScale = Math.max(1, Math.round(opts.pixelScale ?? 3));

    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // antialiasing fights the pixel grid — never enable this
      alpha: false,
      // Photo mode reads pixels back out of the buffer, which requires this at construction.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    // Render at the display's true pixel density (capped at 2 so a 3x phone doesn't pay 9x
    // fill rate). Combined with pixelScale 1 this is the sharpest the scene can be.
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = opts.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // `info` resets itself per render() by default, which means a composer chain reports only
    // its LAST pass — one fullscreen quad — and the perf budget becomes unmeasurable. Reset it
    // manually per frame instead so `calls` accumulates across every pass.
    this.renderer.info.autoReset = false;

    this.composer = new EffectComposer(this.renderer);

    this.pixelPass = new PixelPass(this.pixelScale, this.scene, this.camera, 0.42, 4);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), opts.bloom ?? 0.35, 0.7, 0.82);

    this.filterPass = new ShaderPass(FilterShader);

    this.composer.addPass(this.pixelPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.filterPass);
    this.composer.addPass(new OutputPass());
  }

  /**
   * 1 (crisp / high definition) … 6 (chunky). The pixel pass stays in the chain at every level:
   * at 1 it renders 1:1 with MSAA and contributes only the depth-derived outline, which is the
   * part of the HD-2D look worth keeping when the pixels go away.
   */
  setPixelScale(scale: number): void {
    const next = Math.max(1, Math.min(6, Math.round(scale)));
    if (next === this.pixelScale) return;
    this.pixelScale = next;
    this.pixelPass.setPixelSize(next);
    this.pixelPass.setEdgeStrength(next === 1 ? 0.3 : 0.42);
    this.resize(this.width, this.height);
  }

  getPixelScale(): number {
    return this.pixelScale;
  }

  setBloom(strength: number): void {
    this.bloomPass.strength = Math.max(0, Math.min(1.2, strength));
    this.bloomPass.enabled = this.bloomPass.strength > 0.001;
  }

  setShadows(enabled: boolean): void {
    if (this.renderer.shadowMap.enabled === enabled) return;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && Array.isArray(mesh.material) === false && mesh.material) {
        (mesh.material as THREE.Material).needsUpdate = true;
      }
    });
  }

  setFilter(filter: FilterId): void {
    const u = this.filterPass.uniforms;
    u.uWarm.value = filter === 'warm' ? 1 : 0;
    u.uNight.value = filter === 'night' ? 1 : 0;
    u.uGrain.value = filter === 'grain' ? 1 : 0;
  }

  setVignette(amount: number): void {
    this.filterPass.uniforms.uVignette.value = Math.max(0, Math.min(0.6, amount));
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    // EffectComposer multiplies by the renderer's pixel ratio and forwards DEVICE pixels to
    // every pass, so passing CSS pixels to a pass again here would halve its resolution.
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(elapsed: number): void {
    if (this.disposed) return;
    this.renderer.info.reset();
    this.filterPass.uniforms.uTime.value = elapsed;
    this.composer.render();
  }

  /** Draw-call count for the perf budget assertion. */
  stats(): { calls: number; triangles: number; textures: number; geometries: number } {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  }

  /** PNG data URL of the current frame — photo mode. */
  snapshot(): string {
    this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pixelPass.dispose?.();
    this.bloomPass.dispose?.();
    this.filterPass.dispose?.();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

/** Is WebGL actually available? A refusal to boot must explain itself, not show a black box. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      globalThis.WebGL2RenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')),
    );
  } catch {
    return false;
  }
}
