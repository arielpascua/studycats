import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  AZIMUTH_DEFAULT,
  AZIMUTH_MAX,
  AZIMUTH_MIN,
  ELEVATION_DEFAULT,
  ELEVATION_MAX,
  ELEVATION_MIN,
  FOCUS_TALL,
  FOCUS_WIDE,
  ZOOM_MAX,
  ZOOM_MIN,
  createCameraRig,
  focusFor,
  type CameraMood,
} from '../src/scene/camera';
import { ENVIRONMENTS, ENVIRONMENT_ORDER } from '../src/data/environments';
import { SLOT_ANCHORS } from '../src/scene/props/furnitureProps';

/**
 * The camera rig is pure geometry — no WebGL — so the whole framing contract is testable
 * headlessly. These are the two guarantees the interior view rests on, and they pull in
 * opposite directions, which is exactly why they need pinning:
 *
 *   CONTAIN the focus volume  — the desk is never cropped.
 *   STAY INSIDE the shell     — the eye never leaves the room.
 *
 * A regression in either one is invisible in a diff and obvious on screen.
 */

const MOODS: CameraMood[] = ['idle', 'focus', 'break', 'photo'];
const ASPECTS = [32 / 9, 21 / 9, 16 / 9, 4 / 3, 1, 3 / 4, 390 / 844];

function settle(rig: ReturnType<typeof createCameraRig>): void {
  // Large dt collapses the damping, so the rig lands on its target pose immediately.
  for (let i = 0; i < 6; i++) rig.update(5, 0);
}

function shellOf(id: (typeof ENVIRONMENT_ORDER)[number]) {
  const { minX, maxX, minZ, maxZ, ceiling } = ENVIRONMENTS[id].shell;
  return { minX, maxX, minZ, maxZ, height: ceiling };
}

describe('the eye stays inside the room', () => {
  it('never leaves the shell, at any pose, mood, zoom or aspect', () => {
    const escapes: string[] = [];
    let samples = 0;

    for (const id of ENVIRONMENT_ORDER) {
      const shell = shellOf(id);
      for (const aspect of ASPECTS) {
        const rig = createCameraRig(1000 * aspect, 1000);
        rig.frame(1000 * aspect, 1000);
        rig.setFocus(focusFor(aspect));
        rig.setShell(shell);
        rig.setReducedMotion(true);

        for (const mood of MOODS) {
          rig.setMood(mood);
          for (let az = AZIMUTH_MIN; az <= AZIMUTH_MAX; az += 10) {
            for (let el = ELEVATION_MIN; el <= ELEVATION_MAX; el += 6) {
              for (const zoom of [ZOOM_MIN, 0.75, 1, ZOOM_MAX]) {
                rig.resetView();
                rig.orbitBy(az - AZIMUTH_DEFAULT, el - ELEVATION_DEFAULT);
                rig.zoomBy(zoom - 1);
                settle(rig);

                const p = rig.camera.position;
                samples++;
                const inside =
                  p.x > shell.minX && p.x < shell.maxX &&
                  p.z > shell.minZ && p.z < shell.maxZ &&
                  p.y > 0 && p.y < shell.height;
                if (!inside) {
                  escapes.push(
                    `${id} ${mood} az${az} el${el} zoom${zoom} aspect${aspect.toFixed(2)} -> ` +
                      `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`,
                  );
                }
              }
            }
          }
        }
      }
    }

    expect(samples).toBeGreaterThan(2000);
    expect(escapes.slice(0, 5)).toEqual([]);
  });

  it('keeps the eye above the floor even at the lowest elevation and closest zoom', () => {
    const rig = createCameraRig(1440, 900);
    rig.frame(1440, 900);
    rig.setFocus(FOCUS_WIDE);
    rig.setShell(shellOf('room'));
    rig.setReducedMotion(true);
    rig.orbitBy(0, ELEVATION_MIN - ELEVATION_DEFAULT);
    rig.zoomBy(ZOOM_MIN - 1);
    settle(rig);
    expect(rig.camera.position.y).toBeGreaterThan(0.4);
  });
});

describe('the desk stays in shot', () => {
  it('contains the focus volume across the landscape band at zoom <= 1', () => {
    const crops: string[] = [];

    for (const aspect of ASPECTS.filter((a) => a >= 1)) {
      const rig = createCameraRig(1000 * aspect, 1000);
      rig.frame(1000 * aspect, 1000);
      rig.setFocus(focusFor(aspect));
      rig.setShell(shellOf('room'));
      rig.setReducedMotion(true);

      for (const mood of MOODS) {
        rig.setMood(mood);
        for (let az = AZIMUTH_MIN; az <= AZIMUTH_MAX; az += 15) {
          for (let el = ELEVATION_MIN; el <= ELEVATION_MAX; el += 8) {
            rig.resetView();
            rig.orbitBy(az - AZIMUTH_DEFAULT, el - ELEVATION_DEFAULT);
            settle(rig);

            const { center, half } = focusFor(aspect);
            let worst = 0;
            const v = new THREE.Vector3();
            for (const sx of [-1, 1]) {
              for (const sy of [-1, 1]) {
                for (const sz of [-1, 1]) {
                  v.set(center.x + sx * half.x, center.y + sy * half.y, center.z + sz * half.z);
                  v.project(rig.camera);
                  worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
                }
              }
            }
            if (worst > 1.02) {
              crops.push(`${mood} az${az} el${el} aspect${aspect.toFixed(2)} -> ndc ${worst.toFixed(3)}`);
            }
          }
        }
      }
    }

    expect(crops.slice(0, 5)).toEqual([]);
  });

  it('narrows the focus volume in portrait rather than backing the camera off', () => {
    expect(focusFor(16 / 9)).toBe(FOCUS_WIDE);
    expect(focusFor(390 / 844)).toBe(FOCUS_TALL);
    expect(FOCUS_TALL.half.x).toBeLessThan(FOCUS_WIDE.half.x);
  });
});

describe('what the shell must NOT have changed', () => {
  it('leaves the gameplay footprint exactly where it was', () => {
    // The room got bigger; the play area deliberately did not. Cats wandering across the new
    // floor would be a worse product, not a better one.
    expect(ENVIRONMENTS.room.floor).toEqual({ w: 11, d: 8 });
    expect(ENVIRONMENTS.picnic.floor).toEqual({ w: 12, d: 9 });
    expect(ENVIRONMENTS.bonfire.floor).toEqual({ w: 11, d: 9 });
    expect(ENVIRONMENTS.cafe.floor).toEqual({ w: 12, d: 8 });
  });

  it('keeps the far walls at their original planes, so wall-mounted furniture cannot drift', () => {
    // Every wall slot anchor, the window, the shelf and the skirting are positioned from these.
    for (const id of ['room', 'cafe'] as const) {
      expect(ENVIRONMENTS[id].shell.minZ).toBe(-4.0);
    }
    expect(ENVIRONMENTS.room.shell.minX).toBe(-5.5);
    expect(ENVIRONMENTS.cafe.shell.minX).toBe(-6.0);

    // And the anchors themselves are unmoved.
    expect(SLOT_ANCHORS['wall-a'].z).toBeCloseTo(-3.7, 5);
    expect(SLOT_ANCHORS['wall-b'].z).toBeCloseTo(-3.7, 5);
    expect(SLOT_ANCHORS.window.z).toBeCloseTo(-3.72, 5);
    expect(SLOT_ANCHORS.corner.x).toBeCloseTo(-4.1, 5);
  });

  it('grows the shell only toward the viewer', () => {
    for (const id of ['room', 'cafe'] as const) {
      const shell = ENVIRONMENTS[id].shell;
      expect(shell.maxX).toBeGreaterThan(6);
      expect(shell.maxZ).toBeGreaterThan(6);
      // Tall enough that the ceiling never caps the camera's standoff.
      expect(shell.ceiling).toBeGreaterThan(8);
    }
  });

  it('gives open worlds no ceiling and a real horizon', () => {
    for (const id of ['picnic', 'bonfire'] as const) {
      const shell = ENVIRONMENTS[id].shell;
      expect(shell.kind).toBe('open');
      // Outdoors the only thing overhead is sky; a low "ceiling" here pinned the camera to its
      // minimum distance and cropped the desk.
      expect(shell.ceiling).toBeGreaterThan(40);
      expect(shell.rimHeight).toBeGreaterThan(0);
      expect(shell.groundHalf).toBeGreaterThan(30);
    }
  });
});
