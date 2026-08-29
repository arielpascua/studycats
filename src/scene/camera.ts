/**
 * Camera rig — a spherical orbit *inside* the room (spec §4.1, §4.6).
 *
 * The rig answers to two volumes with deliberately opposite guarantees. Confusing them is the
 * easiest way to break the scene, so they are named and typed separately:
 *
 *   FOCUS  — a small box around the desk cluster. The camera must CONTAIN it: every corner
 *            stays inside the frustum, so the laptop and the cats beside it are never cropped.
 *            It is a declared constant, never measured off the scene graph.
 *
 *   SHELL  — the interior of the room. The eye must never ESCAPE it. This is what makes the
 *            scene read as somewhere you are standing rather than an object on a table: the
 *            walls, floor and ceiling sit outside the frustum because the eye is between them.
 *
 * Distance is therefore `min(containFit(FOCUS), interiorLimit(SHELL))` — fitted to the small
 * volume, capped by the big one. The previous version fitted the whole world bounding box, so
 * every extra unit of wall bought another unit of standoff: the room grew and the camera
 * politely backed away from it. Measured at the time, 100% of the frame's edge was empty sky at
 * every angle.
 *
 * Orbit stays bounded to 180°–270°, the quadrant the room opens toward.
 */

import * as THREE from 'three';
import { clamp, damp, TAU } from './voxel';

export type CameraMood = 'idle' | 'focus' | 'break' | 'photo';

/** The small volume the camera must keep entirely in shot. */
export interface FocusVolume {
  center: THREE.Vector3;
  half: THREE.Vector3;
}

/** The room interior the eye must stay inside. */
export interface ShellBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

/**
 * The composition target. The desk cluster sits at identical coordinates in all four worlds, so
 * this is shared rather than per-environment: laptop (0.35, 1.07, -1.55), chair (0.4, ~0.6,
 * -0.1), rug (0.4, 0, 1.4).
 */
export const FOCUS_WIDE: FocusVolume = {
  center: new THREE.Vector3(0.4, 1.05, -0.5),
  half: new THREE.Vector3(3.0, 1.25, 2.3),
};

/**
 * Portrait phones are narrow, so containing the wide box would shove the eye back through the
 * wall. Narrow the box instead of backing off: the desk stays framed, the room stays around you.
 */
export const FOCUS_TALL: FocusVolume = {
  center: new THREE.Vector3(0.4, 1.1, -0.7),
  half: new THREE.Vector3(2.0, 1.4, 1.7),
};

/**
 * Threshold is 1.25, not 1.0: a square-ish window has a narrow horizontal field even though it
 * is not "portrait", and the wide box cropped the desk by up to 24% there. Chosen from the
 * measured failure band in tests/framing.test.ts rather than by eye.
 */
export function focusFor(aspect: number): FocusVolume {
  return aspect < 1.25 ? FOCUS_TALL : FOCUS_WIDE;
}

/** Minimum clearance kept between the eye and any shell surface. */
const SHELL_MARGIN = 0.7;

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  setMood(mood: CameraMood): void;
  update(dt: number, elapsed: number): void;
  setReducedMotion(reduced: boolean): void;

  /** Drag to orbit. Deltas are in degrees; both axes are clamped to their legal arc. */
  orbitBy(deltaAzimuthDeg: number, deltaElevationDeg: number): void;
  /** Scroll / pinch. Positive zooms out, negative zooms in. */
  zoomBy(delta: number): void;
  /** Back to the framing the app opened with. */
  resetView(): void;

  getAzimuth(): number;
  getElevation(): number;
  getZoom(): number;

  /** The volume that must stay fully in shot. */
  setFocus(focus: FocusVolume): void;
  /** The room interior the eye must never leave. */
  setShell(shell: ShellBox): void;
  /** True when the interior cap, not the focus fit, decided the current distance. */
  isInteriorLimited(): boolean;

  setPhotoControls(orbit: number, elevation: number, zoom: number): void;
  resetPhotoControls(): void;
  frame(width: number, height: number): void;
  getMood(): CameraMood;
}

/** The legal orbit arc, in degrees. 225° is the 3/4 view the diorama is designed around. */
export const AZIMUTH_MIN = 180;
export const AZIMUTH_MAX = 270;
export const AZIMUTH_DEFAULT = 225;

/** Elevation: below ~14° you are inside the floor, above ~58° it stops reading as a diorama. */
export const ELEVATION_MIN = 14;
/** Above ~40 degrees you are looking down from the ceiling, which stops reading as being in the
 *  room at all — and the standoff it needs starts fighting the ceiling. */
export const ELEVATION_MAX = 40;
export const ELEVATION_DEFAULT = 28;

/** 1.0 = exactly framed. Below 1 crops in; above 1 leaves margin. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.2;

interface Mood {
  /** Multiplier on the fitted distance. */
  distance: number;
  /** Added to the user's elevation, in degrees. */
  elevation: number;
  /** Look-at offset from the bounds centre. */
  target: THREE.Vector3;
  fov: number;
}

/**
 * Every `distance` is 1.0. Standing inside a room, "pull back" is not available — there is a
 * wall there — so mood is expressed through the LENS and the look-at instead. Focus takes a
 * longer 42° lens and drops its eyeline; break opens to 50° and lifts, which reads as looking
 * up and around without the eye travelling anywhere.
 *
 * The lens is wide (46° at rest, against 28° before). That is arithmetic rather than taste: at
 * 28° even a desk-sized box needs roughly 12 units of standoff, which is outside the room. An
 * interior view requires an interior lens.
 */
const MOODS: Record<CameraMood, Mood> = {
  idle: { distance: 1.0, elevation: 0, target: new THREE.Vector3(0, 0.2, 0.2), fov: 46 },
  focus: { distance: 1.0, elevation: -3, target: new THREE.Vector3(-0.35, 0.02, 0.1), fov: 42 },
  // Stretch and look around: a wider lens and a raised eyeline, not extra distance.
  break: { distance: 1.0, elevation: 5, target: new THREE.Vector3(0, 0.3, 0.3), fov: 50 },
  photo: { distance: 1.0, elevation: 0, target: new THREE.Vector3(0, 0.2, 0.2), fov: 46 },
};

const DEG = Math.PI / 180;

/**
 * Unit vector from the look-at point TOWARD the camera, for an azimuth/elevation in degrees.
 *
 * The negation matters: the diorama's open corner faces +x/+z, so azimuth 225° has to put the
 * camera there. Both the corner-fitting solver and the final pose read from this one function —
 * when they were written out separately, one of them ended up 180° out and the camera framed the
 * *backs* of the walls.
 */
function orbitDirection(out: THREE.Vector3, azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  const cosE = Math.cos(e);
  return out.set(-Math.sin(a) * cosE, Math.sin(e), -Math.cos(a) * cosE).normalize();
}
/** ±0.04 rad over a 24 s period (DESIGN.md §5). */
const SWAY_AMPLITUDE = 0.04;
const SWAY_PERIOD = 24;
/** A little air so the slab's edges aren't flush against the viewport. */
const FIT_MARGIN = 1.04;

export function createCameraRig(width: number, height: number): CameraRig {
  // near 0.6 / far 80: the pixel pass reconstructs its outline from a 16-bit depth texture, and
  // a 0.1..220 range quantises it badly enough that the far wall stops producing an edge.
  const camera = new THREE.PerspectiveCamera(46, width / height, 0.6, 80);

  let mood: CameraMood = 'idle';
  let reduced = false;

  // User-controlled orbit state.
  let azimuth = AZIMUTH_DEFAULT;
  let elevation = ELEVATION_DEFAULT;
  let zoom = 1;

  // Damped values actually applied to the camera.
  let liveAzimuth = azimuth;
  let liveElevation = elevation;
  let liveDistance = 6.9;
  let liveFov = MOODS.idle.fov;
  const liveTarget = FOCUS_WIDE.center.clone();

  // What must stay in frame, and what the eye must stay inside. Both are seeded with interior
  // values: apply() runs once at construction, before anything calls setFocus/setShell, and if
  // these seeds describe the old exterior view the app opens on exactly the frame this change
  // exists to eliminate.
  const boundsCenter = FOCUS_WIDE.center.clone();
  const corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  let shell = { minX: -5.5, maxX: 10.0, minZ: -4.0, maxZ: 9.5, height: 9.2 };
  let interiorLimited = false;
  storeFocus(FOCUS_WIDE);

  /**
   * Portrait viewports are narrow, so the horizontal corner fit dominates and pushes the camera
   * a long way back — the diorama ends up a stamp in the middle of a tall frame. A wider lens
   * buys that distance back without cropping anything.
   */
  let aspectFovBoost = 0;

  // Photo-mode rail offsets (applied on top of the user's orbit).
  let photoOrbit = 0;
  let photoElevation = 0;
  let photoZoom = 0;

  const eye = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const upVec = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const rel = new THREE.Vector3();
  const wantTarget = new THREE.Vector3();

  function storeFocus(focus: FocusVolume): void {
    boundsCenter.copy(focus.center);
    const { center, half } = focus;
    let i = 0;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          corners[i++].set(center.x + sx * half.x, center.y + sy * half.y, center.z + sz * half.z);
        }
      }
    }
  }

  /**
   * The furthest the eye can travel along `dir` from `target` and still sit inside the shell,
   * with SHELL_MARGIN of clearance. Solved per axis and minimised — the first surface the ray
   * would hit is the one that caps the distance.
   *
   * This is what keeps the viewer *in* the room. Without it, a wide mood lens, a zoom-out and a
   * portrait aspect compose into a standoff that walks the eye straight out through a wall, and
   * the sky reappears at the frame edge mid-session with nothing to point at.
   */
  function interiorLimit(target: THREE.Vector3, direction: THREE.Vector3): number {
    let limit = Infinity;
    const axis = (originValue: number, d: number, lo: number, hi: number) => {
      if (Math.abs(d) < 1e-6) return;
      const bound = d > 0 ? hi - SHELL_MARGIN : lo + SHELL_MARGIN;
      const t = (bound - originValue) / d;
      if (t > 0) limit = Math.min(limit, t);
    };
    axis(target.x, direction.x, shell.minX, shell.maxX);
    axis(target.z, direction.z, shell.minZ, shell.maxZ);
    // Elevation is always positive, so only the ceiling can bind vertically.
    axis(target.y, direction.y, 0, shell.height);
    return Math.max(2.5, limit);
  }

  /**
   * Smallest distance from `target` along the view direction that keeps every bounding-box
   * corner inside the frustum. Per corner: a point `along` units toward the camera and `perp`
   * units off-axis needs `d >= along + perp / tan(halfFov)`.
   */
  function fitDistance(target: THREE.Vector3, azimuthDeg: number, elevationDeg: number, fovDeg: number): number {
    orbitDirection(dir, azimuthDeg, elevationDeg);
    right.crossVectors(dir, worldUp);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    upVec.crossVectors(right, dir).normalize();

    const tanV = Math.tan((fovDeg * DEG) / 2);
    const tanH = tanV * Math.max(0.2, camera.aspect);

    let needed = 0;
    for (const corner of corners) {
      rel.subVectors(corner, target);
      const along = rel.dot(dir);
      const perpV = Math.abs(rel.dot(upVec));
      const perpH = Math.abs(rel.dot(right));
      needed = Math.max(needed, along + perpV / tanV, along + perpH / tanH);
    }
    return Math.max(4, needed * FIT_MARGIN);
  }

  function apply(dt: number, elapsed: number): void {
    const m = MOODS[mood];
    const lambda = reduced ? Infinity : 4.5;

    const wantAzimuth = clamp(azimuth + (mood === 'photo' ? photoOrbit : 0), AZIMUTH_MIN, AZIMUTH_MAX);
    const wantElevation = clamp(
      elevation + m.elevation + (mood === 'photo' ? photoElevation : 0),
      ELEVATION_MIN,
      ELEVATION_MAX,
    );
    const wantZoom = clamp(zoom + (mood === 'photo' ? photoZoom : 0), ZOOM_MIN, ZOOM_MAX);

    const fov = m.fov + aspectFovBoost;
    wantTarget.copy(boundsCenter).add(m.target);
    const fitted = fitDistance(wantTarget, wantAzimuth, wantElevation, fov);
    // Fit to the focus volume, then cap so the eye cannot leave the room. The cap is applied
    // AFTER the mood and zoom multipliers, so no combination of them can escape.
    orbitDirection(dir, wantAzimuth, wantElevation);
    const cap = interiorLimit(wantTarget, dir);
    const requested = fitted * m.distance * wantZoom;
    interiorLimited = requested > cap;
    const wantDistance = Math.min(requested, cap);

    if (reduced) {
      liveAzimuth = wantAzimuth;
      liveElevation = wantElevation;
      liveDistance = wantDistance;
      liveFov = fov;
      liveTarget.copy(wantTarget);
    } else {
      // Orbit follows the pointer faster than the mood dolly — a drag that lags feels broken.
      liveAzimuth = damp(liveAzimuth, wantAzimuth, lambda * 3, dt);
      liveElevation = damp(liveElevation, wantElevation, lambda * 3, dt);
      liveDistance = damp(liveDistance, wantDistance, lambda * 1.6, dt);
      liveFov = damp(liveFov, fov, lambda, dt);
      liveTarget.x = damp(liveTarget.x, wantTarget.x, lambda, dt);
      liveTarget.y = damp(liveTarget.y, wantTarget.y, lambda, dt);
      liveTarget.z = damp(liveTarget.z, wantTarget.z, lambda, dt);
    }

    // Idle sway — a slow breath. Never while composing a photo, never under reduced motion.
    const sway = reduced || mood === 'photo' ? 0 : Math.sin((elapsed / SWAY_PERIOD) * TAU) * SWAY_AMPLITUDE;
    const bob = reduced || mood === 'photo' ? 0 : Math.sin((elapsed / (SWAY_PERIOD * 0.61)) * TAU) * 0.06;

    orbitDirection(dir, liveAzimuth + (sway * 180) / Math.PI, liveElevation);
    eye.copy(liveTarget).addScaledVector(dir, liveDistance);
    eye.y += bob;
    camera.position.copy(eye);
    camera.lookAt(liveTarget);

    if (Math.abs(camera.fov - liveFov) > 0.001) {
      camera.fov = liveFov;
      camera.updateProjectionMatrix();
    }
  }

  // Seed the pose so frame 0 is already correct rather than swinging in from the origin.
  apply(1000, 0);

  return {
    camera,
    getMood: () => mood,
    getAzimuth: () => azimuth,
    getElevation: () => elevation,
    getZoom: () => zoom,

    setFocus(focus) {
      storeFocus(focus);
      // Re-seed instantly so a world swap never shows a frame of the wrong framing.
      apply(1000, 0);
    },

    setShell(next) {
      shell = { ...next };
      apply(1000, 0);
    },

    isInteriorLimited: () => interiorLimited,

    setMood(next) {
      mood = next;
    },

    setReducedMotion(value) {
      reduced = value;
    },

    orbitBy(deltaAzimuthDeg, deltaElevationDeg) {
      azimuth = clamp(azimuth + deltaAzimuthDeg, AZIMUTH_MIN, AZIMUTH_MAX);
      elevation = clamp(elevation + deltaElevationDeg, ELEVATION_MIN, ELEVATION_MAX);
    },

    zoomBy(delta) {
      zoom = clamp(zoom + delta, ZOOM_MIN, ZOOM_MAX);
    },

    resetView() {
      azimuth = AZIMUTH_DEFAULT;
      elevation = ELEVATION_DEFAULT;
      zoom = 1;
    },

    setPhotoControls(orbitT, elevationT, zoomT) {
      // Photo mode drives the same legal arc, expressed as 0..1 rails, as an offset from
      // wherever the user has already orbited to.
      photoOrbit = AZIMUTH_MIN + clamp(orbitT, 0, 1) * (AZIMUTH_MAX - AZIMUTH_MIN) - azimuth;
      photoElevation = ELEVATION_MIN + clamp(elevationT, 0, 1) * (ELEVATION_MAX - ELEVATION_MIN) - elevation;
      photoZoom = ZOOM_MIN + clamp(zoomT, 0, 1) * (ZOOM_MAX - ZOOM_MIN) - zoom;
    },

    resetPhotoControls() {
      photoOrbit = 0;
      photoElevation = 0;
      photoZoom = 0;
    },

    update(dt, elapsed) {
      apply(Math.min(dt, 0.1), elapsed);
    },

    frame(w, h) {
      camera.aspect = w / h;
      aspectFovBoost = camera.aspect < 0.85 ? 12 : 0;
      // The focus box itself narrows in portrait; picking it here keeps the aspect, the boost
      // and the box changing together rather than in three separate places.
      storeFocus(focusFor(camera.aspect));
      camera.updateProjectionMatrix();
      // The corner fit already accounts for aspect, so a portrait phone re-frames on its own —
      // there is no separate "if portrait, pull back" branch to drift out of sync.
      apply(1000, 0);
    },
  };
}
