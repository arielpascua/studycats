/**
 * Pointer interaction on the canvas: pet, drag a cat, and orbit/zoom the diorama itself.
 *
 * The whole design rests on one decision made at `pointerdown`: **did the pointer land on a
 * cat?** If it did, the gesture belongs to that cat (tap = pet, drag = pick up). If it landed on
 * empty scene, the gesture belongs to the camera (drag = orbit, two fingers = pinch). Resolving
 * it once, up front, is what stops "I tried to spin the room and threw a cat across it".
 *
 * Pointer events only — a trackpad, a finger and a stylus all take the same path.
 */

import * as THREE from 'three';

export interface PickTarget {
  /** Object registered as pickable. */
  root: THREE.Object3D;
  id: string;
  kind: 'cat' | 'visitor' | 'prop';
}

export interface DropSurface {
  x: number;
  y: number;
  z: number;
  r: number;
  label: string;
}

export interface PickingCallbacks {
  onPet(id: string): void;
  onDoubleClick(id: string): void;
  onDragStart(id: string): void;
  onDrag(id: string, x: number, y: number, z: number): void;
  onDragEnd(id: string, x: number, z: number, surface: DropSurface | null): void;
  onVisitorClick(id: string): void;
  onBackground(): void;
  /** Orbit the camera. Deltas already converted to degrees. */
  onOrbit(deltaAzimuthDeg: number, deltaElevationDeg: number): void;
  /** Zoom. Positive = out, negative = in. */
  onZoom(delta: number): void;
}

const DRAG_THRESHOLD_PX = 6;
const DOUBLE_CLICK_MS = 320;
/** A full-width drag should sweep the entire legal 90° arc, and no more. */
const ORBIT_DEG_PER_PX = 0.22;
const ELEVATION_DEG_PER_PX = 0.16;
/** One notch of a typical wheel is ~100px of deltaY, so this is ~0.08 zoom per notch — about
 *  nine notches to cross the whole range, which reads as deliberate rather than twitchy. */
const WHEEL_ZOOM_PER_PX = 0.0008;
const PINCH_ZOOM_PER_PX = 0.004;

export class PickingController {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private camera: THREE.Camera;
  private element: HTMLElement;
  private targets: PickTarget[] = [];
  private surfaces: DropSurface[] = [];
  private callbacks: PickingCallbacks;

  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private hit = new THREE.Vector3();

  private downAt: { x: number; y: number; time: number } | null = null;
  private lastMove = { x: 0, y: 0 };
  private activeId: string | null = null;
  private dragging = false;
  private orbiting = false;
  private lastClick = { id: '', time: 0 };
  private hovered: string | null = null;
  private disposed = false;
  private enabled = true;

  /** Live pointers, for pinch detection. */
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;

  constructor(element: HTMLElement, camera: THREE.Camera, callbacks: PickingCallbacks) {
    this.element = element;
    this.camera = camera;
    this.callbacks = callbacks;

    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerCancel);
    element.addEventListener('pointerleave', this.onPointerCancel);
    // Backstop: a release anywhere ends the gesture. Pointer capture usually delivers the up to
    // the canvas even outside it, but capture can fail — and a gesture that never ends turns
    // every later hover into an orbit.
    globalThis.addEventListener('pointerup', this.onWindowPointerUp);
    // passive:false — zooming the diorama must not also scroll/zoom the page.
    element.addEventListener('wheel', this.onWheel, { passive: false });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  setTargets(targets: PickTarget[]): void {
    this.targets = targets;
  }

  setSurfaces(surfaces: DropSurface[]): void {
    this.surfaces = surfaces;
  }

  getHovered(): string | null {
    return this.hovered;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  isOrbiting(): boolean {
    return this.orbiting;
  }

  private updatePointer(event: PointerEvent): void {
    const rect = this.element.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Nearest pickable under the pointer, or null. */
  private pick(): PickTarget | null {
    if (this.targets.length === 0) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots = this.targets.map((t) => t.root);
    const hits = this.raycaster.intersectObjects(roots, true);
    if (hits.length === 0) return null;
    let node: THREE.Object3D | null = hits[0].object;
    while (node) {
      const found = this.targets.find((t) => t.root === node);
      if (found) return found;
      node = node.parent;
    }
    return null;
  }

  /** Where the pointer meets the floor plane — the drag destination. */
  private floorPoint(): { x: number; z: number } | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const point = this.raycaster.ray.intersectPlane(this.floorPlane, this.hit);
    if (!point) return null;
    return { x: point.x, z: point.z };
  }

  private nearestSurface(x: number, z: number): DropSurface | null {
    let best: DropSurface | null = null;
    let bestDist = Infinity;
    for (const s of this.surfaces) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= s.r && d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  private pinchSpan(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // A second finger converts the gesture into a pinch and abandons whatever was in flight.
    if (this.pointers.size === 2) {
      this.pinchDistance = this.pinchSpan();
      this.orbiting = false;
      if (this.dragging && this.activeId) {
        this.callbacks.onDragEnd(this.activeId, NaN, NaN, null);
      }
      this.dragging = false;
      this.activeId = null;
      this.downAt = null;
      return;
    }
    if (this.pointers.size > 2) return;

    this.updatePointer(event);
    const target = this.pick();
    this.downAt = { x: event.clientX, y: event.clientY, time: performance.now() };
    this.lastMove = { x: event.clientX, y: event.clientY };

    if (target && target.kind === 'visitor') {
      this.activeId = null;
      this.downAt = null;
      this.callbacks.onVisitorClick(target.id);
      return;
    }

    this.activeId = target ? target.id : null;
    // Capture keeps the gesture alive when the pointer leaves the canvas mid-drag. It throws
    // NotFoundError for a pointer id the element does not actually hold, so it must never be
    // allowed to abort the rest of this handler.
    try {
      this.element.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
    if (!target) this.element.style.cursor = 'grabbing';
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;

    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    // Pinch to zoom.
    if (this.pointers.size === 2) {
      const span = this.pinchSpan();
      if (this.pinchDistance > 0 && span > 0) {
        this.callbacks.onZoom((this.pinchDistance - span) * PINCH_ZOOM_PER_PX);
      }
      this.pinchDistance = span;
      return;
    }

    // A mouse move with no button held means the press ended somewhere we did not see it (a
    // release over the HUD, a dropped capture). Treat it as the missing pointerup rather than
    // spinning the room on hover.
    if (this.downAt && event.pointerType === 'mouse' && event.buttons === 0) {
      this.cancel();
      return;
    }

    this.updatePointer(event);

    if (!this.downAt) {
      const target = this.pick();
      const id = target && target.kind === 'cat' ? target.id : null;
      if (id !== this.hovered) {
        this.hovered = id;
        this.element.style.cursor = id ? 'grab' : 'default';
      }
      return;
    }

    const moved = Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y);

    // Empty scene → the gesture belongs to the camera.
    if (this.activeId === null) {
      if (!this.orbiting && moved > DRAG_THRESHOLD_PX) this.orbiting = true;
      if (this.orbiting) {
        const dx = event.clientX - this.lastMove.x;
        const dy = event.clientY - this.lastMove.y;
        // Dragging right turns the room to the right, which means the camera goes the other way.
        this.callbacks.onOrbit(-dx * ORBIT_DEG_PER_PX, dy * ELEVATION_DEG_PER_PX);
      }
      this.lastMove = { x: event.clientX, y: event.clientY };
      return;
    }

    if (!this.dragging && moved > DRAG_THRESHOLD_PX) {
      this.dragging = true;
      this.element.style.cursor = 'grabbing';
      this.callbacks.onDragStart(this.activeId);
    }

    if (this.dragging) {
      const floor = this.floorPoint();
      if (floor) {
        const surface = this.nearestSurface(floor.x, floor.z);
        this.callbacks.onDrag(this.activeId, floor.x, surface ? surface.y + 0.35 : 0.55, floor.z);
      }
    }
    this.lastMove = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;

    const id = this.activeId;
    const wasDragging = this.dragging;
    const wasOrbiting = this.orbiting;
    this.updatePointer(event);
    try {
      this.element.releasePointerCapture?.(event.pointerId);
    } catch {
      /* nothing was captured */
    }

    if (id && wasDragging) {
      const floor = this.floorPoint();
      const surface = floor ? this.nearestSurface(floor.x, floor.z) : null;
      this.callbacks.onDragEnd(id, floor?.x ?? 0, floor?.z ?? 0, surface);
    } else if (id) {
      const now = performance.now();
      if (this.lastClick.id === id && now - this.lastClick.time < DOUBLE_CLICK_MS) {
        this.lastClick = { id: '', time: 0 };
        this.callbacks.onDoubleClick(id);
      } else {
        this.lastClick = { id, time: now };
        this.callbacks.onPet(id);
      }
    } else if (this.downAt && !wasOrbiting) {
      const moved = Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y);
      if (moved <= DRAG_THRESHOLD_PX) this.callbacks.onBackground();
    }

    this.activeId = null;
    this.dragging = false;
    this.orbiting = false;
    this.downAt = null;
    this.element.style.cursor = this.hovered ? 'grab' : 'default';
  };

  private onWindowPointerUp = (event: PointerEvent): void => {
    // Only needed when the canvas itself did not receive the up.
    if (event.target === this.element) return;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (this.downAt || this.dragging || this.orbiting) this.cancel();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    this.cancel();
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.enabled || this.disposed) return;
    event.preventDefault();
    // deltaMode 1 is lines, 2 is pages — normalise both to something pixel-ish.
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    this.callbacks.onZoom(event.deltaY * scale * WHEEL_ZOOM_PER_PX);
  };

  /** Abort any in-flight gesture — the world must still release the cat's claims. */
  private cancel(): void {
    if (this.dragging && this.activeId) {
      this.callbacks.onDragEnd(this.activeId, NaN, NaN, null);
    }
    this.activeId = null;
    this.dragging = false;
    this.orbiting = false;
    this.downAt = null;
    this.element.style.cursor = 'default';
  }

  dispose(): void {
    this.disposed = true;
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerCancel);
    this.element.removeEventListener('pointerleave', this.onPointerCancel);
    this.element.removeEventListener('wheel', this.onWheel);
    globalThis.removeEventListener('pointerup', this.onWindowPointerUp);
  }
}
