/**
 * The desk cluster: laptop (hinged lid + live screen), mug, plant.
 *
 * The laptop is the emotional centre of the diorama — it closes when you take a break and boots
 * back up with a flicker when focus resumes (spec §7). Its screen is a `CanvasTexture` redrawn
 * in place, so the task text and the "cat sat on the keyboard" gag cost no allocations.
 */

import * as THREE from 'three';
import { C, hex, PALETTE } from '../../data/palette';
import { box, boxGeo, canvasTexture, flat, mat, mergedBoxes, redrawCanvasTexture, TAU, type BoxSpec } from '../voxel';

export type ScreenMode = 'off' | 'idle' | 'focus' | 'break' | 'gibberish' | 'boot';

const SCREEN_W = 256;
const SCREEN_H = 160;

export interface Laptop {
  group: THREE.Group;
  lid: THREE.Group;
  screen: THREE.Mesh;
  screenTexture: THREE.CanvasTexture;
  light: THREE.PointLight;
  setLidOpen(open: boolean): void;
  update(dt: number, elapsed: number, reducedMotion: boolean): void;
  draw(mode: ScreenMode, task: string, clock: string): void;
  isOpen(): boolean;
}

function drawScreen(ctx: CanvasRenderingContext2D, mode: ScreenMode, task: string, clock: string, frame: number): void {
  // Author at the original 128x80 grid and scale up, so the art is unchanged but the texture is
  // twice the resolution — crisp when the camera zooms right in on the desk.
  ctx.save();
  ctx.scale(SCREEN_W / 128, SCREEN_H / 80);
  drawScreenArt(ctx, mode, task, clock, frame);
  ctx.restore();
}

function drawScreenArt(ctx: CanvasRenderingContext2D, mode: ScreenMode, task: string, clock: string, frame: number): void {
  const SCREEN_W = 128;
  const SCREEN_H = 80;
  ctx.fillStyle = mode === 'off' ? '#1B1528' : '#2A2340';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  if (mode === 'off') return;

  if (mode === 'boot') {
    // A few scanlines sweeping down — the boot-up flicker.
    ctx.fillStyle = PALETTE.mint;
    const y = (frame * 7) % SCREEN_H;
    ctx.fillRect(0, y, SCREEN_W, 3);
    ctx.fillStyle = PALETTE.lav;
    ctx.font = '10px "Silkscreen", monospace';
    ctx.fillText('hello', 8, 20);
    return;
  }

  // Window chrome — three dots, because it reads as "a computer" at 8 pixels tall.
  ctx.fillStyle = '#3B2A44';
  ctx.fillRect(0, 0, SCREEN_W, 12);
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = [PALETTE.pink, PALETTE.butter, PALETTE.mint][i];
    ctx.fillRect(6 + i * 8, 4, 4, 4);
  }

  ctx.font = '10px "Silkscreen", monospace';
  ctx.textBaseline = 'top';

  if (mode === 'gibberish') {
    ctx.fillStyle = PALETTE.mint;
    const chars = 'asdfjkl;qwerty1234[]\\';
    for (let row = 0; row < 5; row++) {
      let line = '';
      const len = 6 + ((frame + row * 3) % 10);
      for (let i = 0; i < len; i++) line += chars[(frame * 3 + row * 7 + i * 5) % chars.length];
      ctx.fillText(line, 6, 18 + row * 12);
    }
    return;
  }

  if (mode === 'break') {
    ctx.fillStyle = PALETTE.peach;
    ctx.fillText('brb', 6, 20);
    ctx.fillStyle = PALETTE.lav;
    ctx.fillText('snack time', 6, 36);
    return;
  }

  // idle / focus: the task, then the clock, then a progress-ish caret.
  ctx.fillStyle = PALETTE.lav;
  const label = (task || 'what are we studying?').slice(0, 15);
  ctx.fillText(label, 6, 18);

  ctx.fillStyle = mode === 'focus' ? PALETTE.pink : PALETTE.inkFaint;
  ctx.font = '16px "Silkscreen", monospace';
  ctx.fillText(clock, 6, 36);

  if (mode === 'focus' && frame % 2 === 0) {
    ctx.fillStyle = PALETTE.mint;
    ctx.fillRect(6, 62, 4, 8);
  }
}

export function createLaptop(): Laptop {
  const group = new THREE.Group();
  group.name = 'laptop';

  /*
   * Laptop geometry, laid out so the lid actually CLOSES over the keyboard.
   *
   * The first version hinged the lid at the top of the base slab (y 0.09) while the keys sat
   * above it at y 0.105-0.125, so the folded lid passed *underneath* the keyboard and the keys
   * stayed visible on top of a closed laptop. The hinge now sits on a barrel above the key
   * tops, and the closed angle is exactly 90 degrees, so the shut lid is a flat slab whose
   * underside clears the keys with room to spare.
   *
   *   key tops      0.106
   *   lid underside 0.120   (pivot 0.150 - half the 0.06 shell thickness)
   */
  const DECK_TOP = 0.09;
  const KEY_TOP = 0.106;
  const HINGE_Y = 0.15;
  const LID_THICKNESS = 0.06;
  const HINGE_Z = -0.47;

  // Base slab + the hinge barrel that carries the lid up above the keys.
  const base = mergedBoxes(
    [
      { w: 1.5, h: DECK_TOP, d: 1.05, y: DECK_TOP / 2 },
      { w: 1.5, h: 0.12, d: 0.15, y: 0.11, z: HINGE_Z },
    ],
    hex(PALETTE.lavDeep),
  )!;
  group.add(base);

  // Recessed keyboard well.
  const deck = box({ w: 1.34, h: 0.012, d: 0.62, y: DECK_TOP + 0.004, z: -0.06 }, hex(PALETTE.lavDusk));
  group.add(deck);

  // Key rows, batched into one mesh.
  const keys: BoxSpec[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 10; c++) {
      keys.push({ w: 0.1, h: 0.012, d: 0.1, x: -0.6 + c * 0.132, y: KEY_TOP - 0.006, z: -0.28 + r * 0.13 });
    }
  }
  const keyMesh = mergedBoxes(keys, hex(PALETTE.paper2));
  if (keyMesh) group.add(keyMesh);

  const lid = new THREE.Group();
  lid.name = 'laptopLid';
  lid.position.set(0, HINGE_Y, HINGE_Z);
  group.add(lid);

  const lidShell = box({ w: 1.5, h: 1.0, d: LID_THICKNESS, y: 0.5 }, hex(PALETTE.lavDeep));
  lid.add(lidShell);

  const screenTexture = canvasTexture(SCREEN_W, SCREEN_H, (ctx) => drawScreen(ctx, 'idle', '', '25:00', 0));
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 0.82),
    new THREE.MeshBasicMaterial({ map: screenTexture }),
  );
  screen.position.set(0, 0.5, LID_THICKNESS / 2 + 0.003);
  screen.name = 'screen';
  lid.add(screen);

  // The glow the screen throws onto the desk — small radius, warm-cool depending on mode.
  const light = new THREE.PointLight(hex(PALETTE.lav), 1.6, 3.4, 2);
  light.position.set(0, 0.7, 0.35);
  group.add(light);

  let open = true;
  let lidAngle = 0;
  let frame = 0;
  let frameAccum = 0;
  let currentMode: ScreenMode = 'idle';
  let currentTask = '';
  let currentClock = '25:00';

  return {
    group,
    lid,
    screen,
    screenTexture,
    light,
    isOpen: () => open,
    setLidOpen(next) {
      open = next;
    },
    update(dt, _elapsed, reducedMotion) {
      const target = open ? 0 : Math.PI * 0.5;
      if (reducedMotion) {
        lidAngle = target;
      } else {
        lidAngle += (target - lidAngle) * Math.min(1, dt * 5.5);
      }
      lid.rotation.x = lidAngle;

      const lit = open && currentMode !== 'off';
      light.intensity = lit ? (currentMode === 'focus' ? 1.9 : 1.3) * Math.max(0, 1 - lidAngle / (Math.PI * 0.5)) : 0;
      light.color.set(currentMode === 'focus' ? hex(PALETTE.pink) : hex(PALETTE.lav));

      // The screen only needs ~4 fps — it is 128px wide and mostly static.
      frameAccum += dt;
      if (frameAccum >= 0.25) {
        frameAccum = 0;
        frame++;
        redrawCanvasTexture(screenTexture, (ctx) =>
          drawScreen(ctx, open ? currentMode : 'off', currentTask, currentClock, frame),
        );
      }
    },
    draw(mode, task, clock) {
      const changed = mode !== currentMode || task !== currentTask || clock !== currentClock;
      currentMode = mode;
      currentTask = task;
      currentClock = clock;
      if (changed) {
        redrawCanvasTexture(screenTexture, (ctx) =>
          drawScreen(ctx, open ? mode : 'off', task, clock, frame),
        );
      }
    },
  };
}

/** A mug that can be knocked over and rights itself (spec §8.9). */
export interface Mug {
  group: THREE.Group;
  knock(): void;
  update(dt: number, reducedMotion: boolean): void;
}

export function createMug(colorA: string = PALETTE.paper, colorB: string = PALETTE.pink): Mug {
  const group = new THREE.Group();
  group.name = 'mug';
  const body = mergedBoxes(
    [
      { w: 0.24, h: 0.28, d: 0.24, y: 0.14 },
      { w: 0.06, h: 0.14, d: 0.06, x: 0.15, y: 0.16 },
    ],
    hex(colorA),
  )!;
  const stripe = box({ w: 0.25, h: 0.06, d: 0.25, y: 0.22 }, hex(colorB));
  group.add(body, stripe);

  let tipped = 0;
  let target = 0;
  let recover = 0;

  return {
    group,
    knock() {
      target = 1;
      recover = 1.6;
    },
    update(dt, reducedMotion) {
      if (recover > 0) {
        recover -= dt;
        if (recover <= 0) target = 0;
      }
      if (reducedMotion) {
        tipped = target;
      } else {
        tipped += (target - tipped) * Math.min(1, dt * 7);
      }
      group.rotation.z = tipped * 1.35;
      group.position.y = tipped * 0.09;
    },
  };
}

/** A chewed but surviving houseplant. */
export function createPlant(leafColor: string = PALETTE.leaf, potColor: string = PALETTE.wood): THREE.Group {
  const group = new THREE.Group();
  group.name = 'plant';

  const pot = mergedBoxes(
    [
      { w: 0.46, h: 0.36, d: 0.46, y: 0.18 },
      { w: 0.52, h: 0.08, d: 0.52, y: 0.38 },
    ],
    hex(potColor),
  )!;
  group.add(pot);

  const leaves: Array<{ w: number; h: number; d: number; x: number; y: number; z: number; rz: number; ry: number }> = [];
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU;
    leaves.push({
      w: 0.1,
      h: 0.52 + (i % 3) * 0.12,
      d: 0.1,
      x: Math.sin(a) * 0.14,
      y: 0.68 + (i % 3) * 0.06,
      z: Math.cos(a) * 0.14,
      rz: Math.sin(a) * 0.4,
      ry: a,
    });
  }
  const foliage = mergedBoxes(leaves, hex(leafColor));
  if (foliage) group.add(foliage);

  return group;
}

/** A window that changes what it shows with the clock. */
export interface Window {
  group: THREE.Group;
  setSky(color: string, night: boolean): void;
}

export function createWindow(view: 'city' | 'hills' | 'plain' = 'plain'): Window {
  const group = new THREE.Group();
  group.name = 'window';

  const frame = mergedBoxes(
    [
      { w: 2.5, h: 0.14, d: 0.14, y: 1.0 },
      { w: 2.5, h: 0.14, d: 0.14, y: 2.5 },
      { w: 0.14, h: 1.5, d: 0.14, x: -1.18, y: 1.75 },
      { w: 0.14, h: 1.5, d: 0.14, x: 1.18, y: 1.75 },
      { w: 0.12, h: 1.5, d: 0.1, y: 1.75 },
    ],
    hex(PALETTE.paper),
  )!;
  group.add(frame);

  const skyMat = mat(hex(PALETTE.lav));
  const sky = new THREE.Mesh(boxGeo(2.36, 1.44, 0.05), skyMat.clone());
  sky.position.set(0, 1.75, -0.03);
  sky.castShadow = false;
  group.add(sky);

  if (view === 'city') {
    const towers: Array<{ w: number; h: number; d: number; x: number; y: number; z: number }> = [];
    for (let i = 0; i < 6; i++) {
      const h = 0.3 + ((i * 7) % 5) * 0.12;
      towers.push({ w: 0.22, h, d: 0.04, x: -0.95 + i * 0.38, y: 1.12 + h / 2, z: 0.01 });
    }
    const city = mergedBoxes(towers, hex(PALETTE.lavDusk));
    if (city) {
      city.castShadow = false;
      group.add(city);
    }
  } else if (view === 'hills') {
    const hills = mergedBoxes(
      [
        { w: 1.3, h: 0.36, d: 0.04, x: -0.5, y: 1.2, z: 0.01 },
        { w: 1.1, h: 0.26, d: 0.04, x: 0.55, y: 1.15, z: 0.01 },
      ],
      C.grass,
    );
    if (hills) {
      hills.castShadow = false;
      group.add(hills);
    }
  }

  const moon = new THREE.Mesh(boxGeo(0.22, 0.22, 0.03), flat(hex(PALETTE.butter)));
  moon.position.set(0.62, 2.16, 0.01);
  moon.visible = false;
  group.add(moon);

  return {
    group,
    setSky(color, night) {
      (sky.material as THREE.MeshToonMaterial).color.set(color);
      moon.visible = night;
    },
  };
}
