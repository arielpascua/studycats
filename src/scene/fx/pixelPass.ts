/**
 * Single-pass pixelation with a depth-derived outline.
 *
 * Why not `RenderPixelatedPass` from three/examples: it renders the **entire scene twice** —
 * once for beauty, once through an override MeshNormalMaterial for edge detection. With eight
 * cats in the room that measured 400 draw calls against a 300 budget, and the second traversal
 * buys only a slightly crisper outline.
 *
 * This pass renders the scene **once** into a low-resolution target that carries a depth
 * texture, then reconstructs the outline from depth discontinuities in the fullscreen shader.
 * Same chunky look, roughly half the draw calls, one fewer render target.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec4 resolution;      // x, y, 1/x, 1/y  (low-res render size)
  uniform float edgeStrength;
  uniform vec2 cameraRange;     // near, far
  varying vec2 vUv;

  // Linearise the perspective depth buffer so a fixed threshold means the same thing at any
  // distance — raw depth is wildly non-linear and an outline built on it flickers with the dolly.
  float linearDepth(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    float z = d * 2.0 - 1.0;
    float near = cameraRange.x;
    float far = cameraRange.y;
    return (2.0 * near * far) / (far + near - z * (far - near));
  }

  void main() {
    vec4 color = texture2D(tDiffuse, vUv);

    if (edgeStrength > 0.001) {
      vec2 texel = resolution.zw;
      float c = linearDepth(vUv);
      float l = linearDepth(vUv - vec2(texel.x, 0.0));
      float r = linearDepth(vUv + vec2(texel.x, 0.0));
      float u = linearDepth(vUv + vec2(0.0, texel.y));
      float d = linearDepth(vUv - vec2(0.0, texel.y));

      // Only the *nearer* side of a discontinuity gets the line, so silhouettes are outlined
      // once rather than doubled into a fat band.
      float diff = max(max(l - c, r - c), max(u - c, d - c));

      // Scale the threshold with distance: at the far edge of the slab, a 0.06-unit step is
      // sub-pixel and must not register as an edge.
      float threshold = 0.045 + c * 0.02;
      float edge = smoothstep(threshold, threshold * 2.6, diff);
      color.rgb *= 1.0 - edge * edgeStrength;
    }

    gl_FragColor = color;
  }
`;

export class PixelPass extends Pass {
  pixelSize: number;
  edgeStrength: number;
  /** MSAA samples on the scene target. Only meaningful at pixelSize 1 (the HD path). */
  private samples: number;

  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private target: THREE.WebGLRenderTarget;
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;
  private resolution = new THREE.Vector2(1, 1);

  constructor(
    pixelSize: number,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    edgeStrength = 0.42,
    samples = 4,
  ) {
    super();
    this.samples = samples;
    this.pixelSize = Math.max(1, Math.round(pixelSize));
    this.edgeStrength = edgeStrength;
    this.scene = scene;
    this.camera = camera;

    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedShortType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      // Nearest on both filters is the whole point at pixelSize > 1 — it is what makes the
      // upscale chunky rather than smeared. At pixelSize 1 the target is already 1:1 with the
      // canvas, so `applyQuality` switches to linear + MSAA for the high-definition path.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
      depthBuffer: true,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        tDepth: { value: depthTexture },
        resolution: { value: new THREE.Vector4(1, 1, 1, 1) },
        edgeStrength: { value: edgeStrength },
        cameraRange: { value: new THREE.Vector2(camera.near, camera.far) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.quad = new FullScreenQuad(this.material);
    this.applyQuality();
  }

  setPixelSize(pixelSize: number): void {
    this.pixelSize = Math.max(1, Math.round(pixelSize));
    this.applyQuality();
    this.setSize(this.resolution.x, this.resolution.y);
  }

  /**
   * At 1:1 the nearest-neighbour filter buys nothing and MSAA is worth paying for; above 1:1
   * the opposite is true — MSAA would soften the very pixel edges the look depends on.
   */
  private applyQuality(): void {
    const hd = this.pixelSize === 1;
    const filter = hd ? THREE.LinearFilter : THREE.NearestFilter;
    if (this.target.texture.minFilter !== filter) {
      this.target.texture.minFilter = filter;
      this.target.texture.magFilter = filter;
      this.target.texture.needsUpdate = true;
    }
    const wantSamples = hd ? this.samples : 0;
    if (this.target.samples !== wantSamples) {
      this.target.samples = wantSamples;
      this.target.dispose();
    }
  }

  setEdgeStrength(strength: number): void {
    this.edgeStrength = Math.max(0, Math.min(1, strength));
    this.material.uniforms.edgeStrength.value = this.edgeStrength;
  }

  override setSize(width: number, height: number): void {
    this.resolution.set(width, height);
    const w = Math.max(1, Math.floor(width / this.pixelSize));
    const h = Math.max(1, Math.floor(height / this.pixelSize));
    this.target.setSize(w, h);
    this.material.uniforms.resolution.value.set(w, h, 1 / w, 1 / h);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    this.material.uniforms.cameraRange.value.set(this.camera.near, this.camera.far);

    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
