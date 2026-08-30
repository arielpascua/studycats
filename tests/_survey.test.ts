import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  AZIMUTH_MIN, AZIMUTH_MAX, AZIMUTH_DEFAULT,
  ELEVATION_MIN, ELEVATION_MAX, ELEVATION_DEFAULT,
  ZOOM_MIN, ZOOM_MAX, createCameraRig, FOCUS_WIDE,
  type CameraMood,
} from '../src/scene/camera';

const MOODS: CameraMood[] = ['idle', 'focus', 'break', 'photo'];
function settle(r: ReturnType<typeof createCameraRig>) { for (let i = 0; i < 6; i++) r.update(5, 0); }

function sweep(shell: any, focus: any, aspect: number) {
  const rig = createCameraRig(1000 * aspect, 1000);
  rig.frame(1000 * aspect, 1000);
  rig.setFocus(focus);
  rig.setShell(shell);
  rig.setReducedMotion(true);
  let maxY = -Infinity, maxX = -Infinity, maxZ = -Infinity, worstNdc = 0, escapes = 0, n = 0;
  for (const mood of MOODS) {
    rig.setMood(mood);
    for (let az = AZIMUTH_MIN; az <= AZIMUTH_MAX; az += 15)
      for (let el = ELEVATION_MIN; el <= ELEVATION_MAX; el += 6)
        for (const zoom of [ZOOM_MIN, 1, ZOOM_MAX]) {
          rig.resetView(); rig.orbitBy(az - AZIMUTH_DEFAULT, el - ELEVATION_DEFAULT); rig.zoomBy(zoom - 1); settle(rig);
          const p = rig.camera.position; n++;
          maxY = Math.max(maxY, p.y); maxX = Math.max(maxX, p.x); maxZ = Math.max(maxZ, p.z);
          const inside = p.x > shell.minX && p.x < shell.maxX && p.z > shell.minZ && p.z < shell.maxZ && p.y > 0 && p.y < shell.height;
          if (!inside) escapes++;
          const v = new THREE.Vector3();
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            v.set(focus.center.x + sx * focus.half.x, focus.center.y + sy * focus.half.y, focus.center.z + sz * focus.half.z).project(rig.camera);
            worstNdc = Math.max(worstNdc, Math.abs(v.x), Math.abs(v.y));
          }
        }
  }
  return { n, escapes, maxX: +maxX.toFixed(3), maxY: +maxY.toFixed(3), maxZ: +maxZ.toFixed(3), worstNdc: +worstNdc.toFixed(3) };
}

const F = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) =>
  ({ center: new THREE.Vector3(cx, cy, cz), half: new THREE.Vector3(hx, hy, hz) });

describe('survey', () => {
  it('numbers', () => {
    const cases: Array<[string, any, any, number]> = [
      ['solo room / FOCUS_WIDE / 16:9', { minX:-5.5,maxX:10,minZ:-4,maxZ:9.5,height:9.2 }, FOCUS_WIDE, 16/9],
      ['REALISTIC classroom ceiling 3.4, room 14x12', { minX:-7,maxX:7,minZ:-6,maxZ:6,height:3.4 }, F(0,1.0,0,4,1.25,3), 16/9],
      ['classroom ceiling 5.0, room 14x12', { minX:-7,maxX:7,minZ:-6,maxZ:6,height:5.0 }, F(0,1.0,0,4,1.25,3), 16/9],
      ['big room 22x22, ceiling 14, focus half 8', { minX:-8,maxX:14,minZ:-8,maxZ:14,height:14 }, F(0,0.9,0,8,1.25,8), 16/9],
      ['big room 22x22, ceiling 14, focus half 8, portrait', { minX:-8,maxX:14,minZ:-8,maxZ:14,height:14 }, F(0,0.9,0,8,1.25,8), 390/844],
      ['same but ceiling 26 / maxXZ 26', { minX:-8,maxX:26,minZ:-8,maxZ:26,height:26 }, F(0,0.9,0,8,1.25,8), 390/844],
    ];
    for (const [label, shell, focus, aspect] of cases) {
      // eslint-disable-next-line no-console
      console.log(label, JSON.stringify(sweep(shell, focus, aspect)));
    }
    expect(true).toBe(true);
  });
});
