/**
 * The world: everything that lives in 3D, wired to the store and the event bus.
 *
 * Responsibilities, in the order the update loop runs them:
 *   1. keep the cat roster in sync with `state.cats` (adopt / send home)
 *   2. run each cat's brain, feed its intents into the pure feeding model, animate
 *   3. run the break choreography (bowls in, snacks drop, laptop lid, cleanup)
 *   4. drive day/night lighting, seasonal particles and the visitor at the edge
 *
 * The feeding model is authoritative: meshes are a *projection* of it. Cleanup therefore can't
 * leak, because `end()` hands back the exact id set to remove (spec §13).
 */

import * as THREE from 'three';
import { bus } from '../core/events';
import { dayPhase, season, type DayPhase } from '../core/time';
import { makeRng, rand } from '../core/rng';
import {
  begin as beginFeeding,
  bite as takeBite,
  claimNearest,
  claimOf,
  createFeeding,
  end as endFeeding,
  release as releaseClaim,
  sip as sipBowl,
  type FeedingState,
} from '../core/feeding';
import type { Game } from '../store';
import { bondTint, resolveReducedMotion } from '../store';
import type { EnvironmentId } from '../data/environments';
import { BREEDS } from '../data/breeds';
import { VISITORS } from '../data/visitors';
import { hex, mixHex, PALETTE } from '../data/palette';
import { buildEnvironment, type BuiltEnvironment } from './environments';
import { createFurniture, type PlacedFurniture } from './props/furnitureProps';
import { createBowl, createSnackMesh, type BowlMesh, type SnackMesh } from './props/edibles';
import { createCat, createNameTag, type CatParts } from './cats/catFactory';
import { CatAnimator, trickForBond, TRICK_NAMES } from './cats/catAnimator';
import { CatBrain, type BrainMode, type Obstacle } from './cats/catBrain';
import { ParticleField, RECIPES } from './fx/particles';
import { PickingController, type DropSurface, type PickTarget } from './picking';
import type { ShellBox } from './camera';
import { boxGeo, disposeTree, flat, mergedBoxes, damp } from './voxel';
import { audio } from '../audio/engine';
import type { SlotId } from '../data/furniture';

/** The bits of the camera rig the input layer drives. */
export interface CameraControls {
  orbitBy(deltaAzimuthDeg: number, deltaElevationDeg: number): void;
  zoomBy(delta: number): void;
}

interface CatAgent {
  id: string;
  parts: CatParts;
  animator: CatAnimator;
  brain: CatBrain;
  tag: THREE.Sprite;
  /** Non-null while the user is dragging it. */
  held: { x: number; y: number; z: number } | null;
  /** Seconds left of the "just petted" pose. */
  petLeft: number;
  purring: boolean;
}

export interface World {
  scene: THREE.Scene;
  update(dt: number, elapsed: number, now: number): void;
  setEnvironment(id: EnvironmentId): void;
  attachPicking(element: HTMLElement, camera: THREE.Camera, controls: CameraControls): PickingController;
  /** The room interior the camera rig must keep the eye inside. */
  getShell(): ShellBox;
  /** Tell the world where the eye is, so cats keep out of it. Call after the rig updates. */
  setCameraPosition(position: THREE.Vector3): void;
  setReducedMotion(reduced: boolean): void;
  setTimerDisplay(mode: 'idle' | 'focus' | 'break', clock: string, task: string): void;
  beginBreak(): void;
  endBreak(): void;
  celebrate(): void;
  /** Idle nudge: a cat wanders to the front of the slab and paws at the screen. */
  nudge(): void;
  setPaused(paused: boolean): void;
  getStats(): { cats: number; snacks: number; particles: number };
  dispose(): void;
}

const CAT_BASE_Y = 0;

export function createWorld(game: Game): World {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(hex(PALETTE.lav));

  /* ---------------------------------------------------------------- lights */

  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(6, 11, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  const shadowCam = key.shadow.camera;
  // Tight to the caster volume (the play rect and the props on it), not to the room. The shell
  // casts nothing, so widening this for the new walls would only cost texel density.
  shadowCam.left = -8;
  shadowCam.right = 8;
  shadowCam.top = 8;
  shadowCam.bottom = -8;
  shadowCam.updateProjectionMatrix();
  // Without a bias, a low-res shadow map stripes every flat surface with acne.
  key.shadow.bias = -0.0018;
  key.shadow.normalBias = 0.03;
  // A DirectionalLight aims at its target's world position, and an unparented target never
  // gets one computed. It happens to sit at the origin, which is why this worked — but it is
  // luck, not design, and it breaks the moment anything moves the target.
  scene.add(key);
  scene.add(key.target);

  const ambient = new THREE.AmbientLight(hex(PALETTE.lav), 0.6);
  scene.add(ambient);

  // A dim fill from the opposite side stops the shadowed faces going flat black.
  const fill = new THREE.DirectionalLight(hex(PALETTE.pink), 0.35);
  fill.position.set(-7, 4, -5);
  scene.add(fill);

  const particles = new ParticleField(720);
  scene.add(particles.points);

  /* ------------------------------------------------------------ environment */

  let env: BuiltEnvironment = buildEnvironment(game.getState().settings.environment);
  scene.add(env.group);

  const furnitureGroup = new THREE.Group();
  furnitureGroup.name = 'furniture';
  scene.add(furnitureGroup);
  let placed: PlacedFurniture[] = [];

  /* ------------------------------------------------------------------ cats */

  const catGroup = new THREE.Group();
  catGroup.name = 'cats';
  scene.add(catGroup);
  const agents = new Map<string, CatAgent>();

  /* --------------------------------------------------------------- feeding */

  let feeding: FeedingState = createFeeding();
  const snackMeshes = new Map<string, SnackMesh>();
  const bowlMeshes = new Map<string, BowlMesh>();
  const feedingGroup = new THREE.Group();
  feedingGroup.name = 'feeding';
  scene.add(feedingGroup);
  let breakActive = false;

  /* --------------------------------------------------------------- visitor */

  let visitorMesh: THREE.Group | null = null;
  let visitorId: string | null = null;

  /* ----------------------------------------------------------------- state */

  let reduced = resolveReducedMotion(game.getState().settings.motion);
  let paused = false;
  let mode: BrainMode = 'idle';
  let picking: PickingController | null = null;
  let ambientAccumulator = 0;
  /** The live camera position, so cats can be kept off the lens. Set by the app each frame. */
  let cameraPosition: THREE.Vector3 | null = null;
  let currentPhase: DayPhase = dayPhase();
  const rng = makeRng(Date.now() & 0xffff);

  particles.setEnabled(!reduced);

  /* ------------------------------------------------------------- furniture */

  function rebuildFurniture(): void {
    for (const item of placed) disposeTree(item.group);
    placed = [];
    furnitureGroup.clear();

    const state = game.getState();
    const slots = state.unlocks.placements[state.settings.environment] ?? {};
    for (const [slot, id] of Object.entries(slots)) {
      if (!id) continue;
      const item = createFurniture(id, slot as SlotId);
      if (!item) continue;
      placed.push(item);
      furnitureGroup.add(item.group);
    }
  }

  function obstacles(): Obstacle[] {
    const list = [...env.obstacles];
    for (const item of placed) {
      if (item.obstacle) list.push(item.obstacle);
    }
    return list;
  }

  function dropSurfaces(): DropSurface[] {
    const list: DropSurface[] = [];
    for (const item of placed) {
      if (item.perch) {
        list.push({ x: item.perch.x, y: item.perch.y, z: item.perch.z, r: item.perch.r, label: item.def.name });
      }
    }
    // The chair is always a legal landing spot — cats love it and it needs no purchase.
    list.push({ x: 0.4, y: 0.68, z: -0.1, r: 0.55, label: 'the chair' });
    return list;
  }

  /* ------------------------------------------------------------------ cats */

  function syncCats(): void {
    const state = game.getState();
    const wanted = new Set(state.cats.map((c) => c.id));

    for (const [id, agent] of agents) {
      if (wanted.has(id)) continue;
      disposeTree(agent.parts.root);
      agent.tag.material.map?.dispose();
      agent.tag.material.dispose();
      feeding = releaseClaim(feeding, id);
      agents.delete(id);
    }

    for (const cat of state.cats) {
      let agent = agents.get(cat.id);
      if (!agent) {
        const parts = createCat(cat.breed, { scale: 0.98 + rng() * 0.14 });
        const brain = new CatBrain(
          cat.id,
          BREEDS[cat.breed],
          spawnPoint(agents.size),
          rng.range(-Math.PI, Math.PI),
        );
        const animator = new CatAnimator(parts, { phase: rng() * 6.28, reducedMotion: reduced });
        const tag = createNameTag(cat.name, bondTint(cat.bondXp));
        tag.visible = false;
        parts.root.add(tag);
        catGroup.add(parts.root);
        agent = { id: cat.id, parts, animator, brain, tag, held: null, petLeft: 0, purring: false };
        agents.set(cat.id, agent);
      }
      // Keep the tag's text/tint honest after a rename or a bond level-up.
      const tint = bondTint(cat.bondXp);
      if (agent.tag.userData.tint !== tint || agent.tag.userData.name !== cat.name) {
        agent.parts.root.remove(agent.tag);
        agent.tag.material.map?.dispose();
        agent.tag.material.dispose();
        const tag = createNameTag(cat.name, tint);
        tag.visible = agent.tag.visible;
        tag.userData.tint = tint;
        tag.userData.name = cat.name;
        agent.parts.root.add(tag);
        agent.tag = tag;
      }
    }

    refreshPickTargets();
  }

  /**
   * Golden-angle spiral rather than uniform randoms: eight uniform draws in an 11×8 room clump
   * visibly, and a room of cats stacked in one corner reads as a bug even though each individual
   * position is legal.
   */
  function spawnPoint(index: number): { x: number; z: number } {
    const floor = env.def.floor;
    const golden = 2.399963;
    const t = index * golden;
    const radius = 0.9 + Math.sqrt(index + 0.6) * 0.95;
    const x = Math.cos(t) * radius;
    // Slightly biased *back* into the room: the front of the slab is the frame's bottom edge,
    // and a cat parked there is half-cropped.
    const z = Math.sin(t) * radius * 0.7 - 0.3;
    const halfW = floor.w / 2 - 1.1;
    const halfD = floor.d / 2 - 1.4;
    return { x: Math.max(-halfW, Math.min(halfW, x)), z: Math.max(-halfD, Math.min(halfD, z)) };
  }

  /**
   * Keep cats out of each other. The brain avoids *props*, but two sleeping cats have no reason
   * to move and will happily occupy the same square — which renders as one clipped lump. A
   * symmetric positional push, run after the brains, separates them without fighting the
   * pathfinding: it never changes where a cat is *going*, only where it currently is.
   */
  function separateCats(): void {
    const list = [...agents.values()].filter((a) => !a.held);
    const floor = env.def.floor;
    const halfW = floor.w / 2 - 0.4;
    const halfD = floor.d / 2 - 0.4;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const min = a.parts.radius + b.parts.radius;
        let dx = b.brain.x - a.brain.x;
        let dz = b.brain.z - a.brain.z;
        let dist = Math.hypot(dx, dz);
        if (dist >= min) continue;
        if (dist < 0.0001) {
          // Exactly coincident: pick a deterministic direction so they don't jitter forever.
          dx = Math.cos(i * 2.4);
          dz = Math.sin(i * 2.4);
          dist = 1;
        }
        const push = (min - dist) / 2;
        const nx = (dx / dist) * push;
        const nz = (dz / dist) * push;
        a.brain.x = Math.max(-halfW, Math.min(halfW, a.brain.x - nx));
        a.brain.z = Math.max(-halfD, Math.min(halfD, a.brain.z - nz));
        b.brain.x = Math.max(-halfW, Math.min(halfW, b.brain.x + nx));
        b.brain.z = Math.max(-halfD, Math.min(halfD, b.brain.z + nz));
      }
    }
  }

  function refreshPickTargets(): void {
    if (!picking) return;
    const targets: PickTarget[] = [];
    for (const agent of agents.values()) {
      targets.push({ root: agent.parts.root, id: agent.id, kind: 'cat' });
    }
    if (visitorMesh && visitorId) {
      targets.push({ root: visitorMesh, id: visitorId, kind: 'visitor' });
    }
    picking.setTargets(targets);
    picking.setSurfaces(dropSurfaces());
  }

  /* --------------------------------------------------------------- feeding */

  function spawnFeedingMeshes(): void {
    for (const snack of feeding.snacks) {
      const mesh = createSnackMesh(snack.id, snack.def, snack.x, snack.z, 3.4 + rand() * 0.8);
      snackMeshes.set(snack.id, mesh);
      feedingGroup.add(mesh.group);
    }
    for (const bowl of feeding.bowls) {
      const mesh = createBowl(bowl.id, bowl.kind, bowl.x, bowl.z);
      bowlMeshes.set(bowl.id, mesh);
      feedingGroup.add(mesh.group);
    }
  }

  function beginBreak(): void {
    if (breakActive) return;
    breakActive = true;
    mode = 'break';

    const state = game.getState();
    env.laptop.setLidOpen(false);
    env.laptop.draw('break', '', '');

    feeding = beginFeeding({
      unlocked: state.unlocks.snacks,
      pool: env.def.snacks,
      floor: env.def.floor,
      rng: makeRng((Date.now() ^ 0x9e3779b9) >>> 0),
    });
    spawnFeedingMeshes();
    bus.emit('snacks:begin', { environment: env.id });
  }

  /**
   * Deterministic teardown. `endFeeding` returns exactly the ids that existed, so nothing can be
   * orphaned — and any mesh not in that set (there should be none) is swept anyway.
   */
  function endBreak(): void {
    if (!breakActive) {
      // Still sweep: a skip during the *first* frame of a break can land here.
      sweepFeedingMeshes([]);
      return;
    }
    breakActive = false;

    const { state, removed } = endFeeding(feeding);
    feeding = state;
    sweepFeedingMeshes(removed);

    for (const agent of agents.values()) {
      agent.brain.setFoodTarget(null, 'food');
    }

    env.laptop.setLidOpen(true);
    env.laptop.draw('boot', '', '');
    bus.emit('snacks:end');
  }

  function sweepFeedingMeshes(removed: readonly string[]): void {
    for (const id of removed) {
      snackMeshes.get(id)?.pop();
      bowlMeshes.get(id)?.leave();
    }
    // Anything the model no longer knows about goes too — belt and braces, and it makes the
    // "no orphaned meshes" property hold even if a future edit forgets to report an id.
    for (const [id, mesh] of snackMeshes) {
      if (!feeding.snacks.some((s) => s.id === id)) mesh.pop();
    }
    for (const [, mesh] of bowlMeshes) {
      if (!feeding.active) mesh.leave();
    }
  }

  function reapFinishedMeshes(): void {
    for (const [id, mesh] of snackMeshes) {
      if (mesh.phase === 'done') {
        mesh.dispose();
        snackMeshes.delete(id);
      }
    }
    for (const [id, mesh] of bowlMeshes) {
      if (mesh.isGone()) {
        mesh.dispose();
        bowlMeshes.delete(id);
      }
    }
  }

  /* --------------------------------------------------------------- visitor */

  function buildVisitor(id: string): THREE.Group | null {
    const def = VISITORS[id];
    if (!def) return null;
    const g = new THREE.Group();
    g.name = `visitor:${id}`;

    const a = hex(def.colorA);
    const b = hex(def.colorB);
    switch (def.shape) {
      case 'bird':
        g.add(mergedBoxes([{ w: 0.34, h: 0.26, d: 0.24, y: 0.2 }, { w: 0.2, h: 0.2, d: 0.2, y: 0.4, z: 0.12 }], a)!);
        g.add(mergedBoxes([{ w: 0.1, h: 0.06, d: 0.06, y: 0.4, z: 0.26 }], b)!);
        break;
      case 'hedgehog':
        g.add(mergedBoxes([{ w: 0.4, h: 0.24, d: 0.32, y: 0.14 }], b)!);
        g.add(mergedBoxes([{ w: 0.34, h: 0.2, d: 0.28, y: 0.26 }], a)!);
        break;
      case 'cat':
        g.add(mergedBoxes([{ w: 0.4, h: 0.3, d: 0.52, y: 0.24 }, { w: 0.34, h: 0.3, d: 0.3, y: 0.5, z: 0.24 }], a)!);
        g.add(mergedBoxes([{ w: 0.08, h: 0.06, d: 0.04, x: -0.08, y: 0.52, z: 0.4 }, { w: 0.08, h: 0.06, d: 0.04, x: 0.08, y: 0.52, z: 0.4 }], b)!);
        break;
      case 'frog':
        g.add(mergedBoxes([{ w: 0.34, h: 0.2, d: 0.3, y: 0.12 }], a)!);
        g.add(mergedBoxes([{ w: 0.1, h: 0.1, d: 0.1, x: -0.1, y: 0.26 }, { w: 0.1, h: 0.1, d: 0.1, x: 0.1, y: 0.26 }], b)!);
        break;
      default: {
        const bug = new THREE.Mesh(boxGeo(0.14, 0.14, 0.14), flat(a));
        bug.position.y = 0.9;
        g.add(bug);
        break;
      }
    }
    return g;
  }

  function showVisitor(id: string): void {
    hideVisitor();
    const built = buildVisitor(id);
    if (!built) return;
    visitorId = id;
    visitorMesh = built;
    const floor = env.def.floor;
    const edge = rng() < 0.5 ? -1 : 1;
    built.position.set(edge * (floor.w / 2 - 0.5), 0, rng.range(-floor.d / 3, floor.d / 3));
    built.rotation.y = edge > 0 ? -Math.PI / 2 : Math.PI / 2;
    scene.add(built);
    refreshPickTargets();
  }

  function hideVisitor(): void {
    if (visitorMesh) {
      disposeTree(visitorMesh);
      visitorMesh = null;
    }
    visitorId = null;
    refreshPickTargets();
  }

  /* ---------------------------------------------------------------- events */

  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('env:changed', ({ environment }) => {
      if (environment !== env.id) setEnvironment(environment);
      else rebuildFurniture();
    }),
  );

  unsubs.push(
    bus.on('visitor:appeared', ({ id }) => showVisitor(id)),
  );
  unsubs.push(bus.on('visitor:logged', () => hideVisitor()));

  unsubs.push(
    bus.on('cat:adopted', () => {
      syncCats();
    }),
  );

  /* ------------------------------------------------------------------ core */

  function setEnvironment(id: EnvironmentId): void {
    if (env.id === id) return;
    endBreak();
    scene.remove(env.group);
    env.dispose();
    env = buildEnvironment(id);
    scene.add(env.group);
    rebuildFurniture();
    particles.clear();
    // Re-seed cats inside the new floor plan.
    let index = 0;
    for (const agent of agents.values()) {
      const spot = spawnPoint(index++);
      agent.brain.placeAt(spot.x, spot.z);
    }
    refreshPickTargets();
  }

  function applyDayNight(): void {
    const phase = dayPhase();
    currentPhase = phase;
    const def = env.def;
    const skyHex = def.sky[phase];
    (scene.background as THREE.Color).set(skyHex);

    const keyDef = def.key[phase];
    key.color.set(keyDef.color);
    key.intensity = keyDef.intensity;

    const ambDef = def.ambient[phase];
    ambient.color.set(ambDef.color);
    // Daylight ambient is pulled down a little: with it at full strength the shadow terminator
    // washes out and the toon ramp never reaches its lower step.
    ambient.intensity = ambDef.intensity * (phase === 'night' ? 1 : 0.82);

    // The key light is pinned to the +x/+z quadrant so it can reach past the far walls, which
    // means it can never light the inner faces of the two NEAR walls. The fill is the only lamp
    // that reaches them, so interiors need more of it or those walls read as a dark band.
    const walled = env.def.shell.kind === 'walls';
    fill.intensity = (phase === 'night' ? 0.18 : 0.35) * (walled ? 1.55 : 1);
    fill.color.set(mixHex(PALETTE.pink, PALETTE.lavDusk, phase === 'night' ? 0.7 : 0.1));

    // The sun's path.
    //
    // Two constraints, both learned from looking at the render rather than from the maths:
    //  - it must stay in the room's OPEN quadrant (+x / +z). The back and left walls are solid,
    //    so a sun behind them puts the entire floor in shadow.
    //  - it must sit ~45° around from the camera (which is at azimuth 225°) and low enough to
    //    rake. The first version peaked near 60° almost directly overhead on the camera's own
    //    side, so every shadow fell hidden behind the object casting it and the diorama read
    //    completely flat.
    const t = { dawn: 0.1, morning: 0.3, afternoon: 0.55, golden: 0.78, dusk: 0.9, night: 0.5 }[phase];
    const sunAzimuth = (285 - t * 40) * (Math.PI / 180);
    const sunElevation = (22 + Math.sin(Math.PI * t) * 24) * (Math.PI / 180);
    const radius = 18;
    const cosE = Math.cos(sunElevation);
    key.position.set(
      -Math.sin(sunAzimuth) * cosE * radius,
      Math.sin(sunElevation) * radius,
      -Math.cos(sunAzimuth) * cosE * radius,
    );
  }
  applyDayNight();

  function emitAmbientParticles(dt: number): void {
    if (reduced) return;
    ambientAccumulator += dt;
    const floor = env.def.floor;
    const s = season();
    const night = currentPhase === 'night' || currentPhase === 'dusk';
    // Weather is an outdoor event. Now that the interiors have a ceiling, rain and snow would
    // spawn above it and appear to fall through — so indoors they stay in the soundtrack, where
    // the café's "rain doing all the talking" was always the better half of the effect anyway.
    const indoors = env.def.shell.kind === 'walls';

    if (env.id === 'cafe' && ambientAccumulator > 0.02) {
      ambientAccumulator = 0;
      // Dust in the lamplight instead of rain on the tables.
      particles.spawn(RECIPES.mote(floor.w, floor.d));
      return;
    }

    if (env.id === 'bonfire' && ambientAccumulator > 0.08) {
      ambientAccumulator = 0;
      if (env.firePoint) particles.spawn(RECIPES.spark(env.firePoint.x, env.firePoint.y, env.firePoint.z));
      return;
    }

    if (ambientAccumulator < 0.5) return;
    ambientAccumulator = 0;

    if (!indoors) {
      if (s === 'sakura') {
        particles.spawn(RECIPES.petal(floor.w, floor.d));
        return;
      }
      if (s === 'winter') {
        particles.spawn(RECIPES.snow(floor.w, floor.d));
        return;
      }
      if (s === 'summer' && night && env.id === 'picnic') {
        particles.spawn(RECIPES.firefly(floor.w, floor.d));
        return;
      }
      if (s === 'rain') {
        particles.spawn(RECIPES.rain(floor.w, floor.d));
        return;
      }
    }
    particles.spawn(RECIPES.mote(floor.w, floor.d));
  }

  /* ------------------------------------------------------------ interaction */

  function petAgent(agent: CatAgent): void {
    const result = game.petCat(agent.id);
    if (!result) return;
    agent.animator.setPose('pet');
    agent.brain.freeze('pet', 2.2);
    agent.petLeft = 2.2;
    agent.tag.visible = true;
    if (!agent.purring) {
      agent.purring = true;
      audio.startPurr();
    }
    const p = agent.parts.root.position;
    particles.burst(7, (i) => RECIPES.heart(p.x, p.y + 0.9, p.z, i));
  }

  function doTrick(agent: CatAgent): void {
    const cat = game.getState().cats.find((c) => c.id === agent.id);
    if (!cat) return;
    const trick = trickForBond(bondLevelOf(cat.bondXp));
    if (!trick) {
      agent.animator.flashEmotion('surprised', 1);
      bus.emit('toast', { title: 'NOT YET', body: `${cat.name} needs a stronger bond first`, icon: '🐾', tone: 'gentle' });
      return;
    }
    agent.animator.setPose(trick);
    agent.brain.freeze(trick, 1.6);
    game.recordTrick(agent.id, TRICK_NAMES[trick] ?? trick);
    audio.blip();
    const p = agent.parts.root.position;
    particles.burst(5, (i) => RECIPES.heart(p.x, p.y + 1, p.z, i));
  }

  function bondLevelOf(xp: number): number {
    // Local copy to avoid importing the economy module into the render layer for one call.
    const thresholds = [0, 20, 55, 110, 190, 300, 450, 650, 900, 1250];
    let level = 1;
    for (let i = 0; i < thresholds.length; i++) if (xp >= thresholds[i]) level = i + 1;
    return Math.min(10, level);
  }

  /**
   * The shell is DECLARED, never measured.
   *
   * It used to be `Box3().setFromObject(env.group)`, which quietly made the camera a function of
   * the geometry: every wall added pushed the eye further away, so the room could never grow
   * around the viewer. Reading it from the environment definition instead means the room and the
   * camera are two independent decisions, which is the whole point.
   */
  function computeShell(): ShellBox {
    const { minX, maxX, minZ, maxZ, ceiling } = env.def.shell;
    return { minX, maxX, minZ, maxZ, height: ceiling };
  }

  function attachPicking(element: HTMLElement, camera: THREE.Camera, controls: CameraControls): PickingController {
    picking = new PickingController(element, camera, {
      onOrbit(dAz, dEl) {
        controls.orbitBy(dAz, dEl);
      },
      onZoom(delta) {
        controls.zoomBy(delta);
      },
      onPet(id) {
        const agent = agents.get(id);
        if (agent) petAgent(agent);
      },
      onDoubleClick(id) {
        const agent = agents.get(id);
        if (agent) doTrick(agent);
      },
      onDragStart(id) {
        const agent = agents.get(id);
        if (!agent) return;
        agent.brain.held = true;
        agent.held = { x: agent.parts.root.position.x, y: 0.6, z: agent.parts.root.position.z };
        agent.tag.visible = true;
        // AC-12: a lifted cat gives up its snack immediately, not when it lands.
        feeding = releaseClaim(feeding, id);
        agent.brain.setFoodTarget(null, 'food');
        agent.animator.setPose('play');
      },
      onDrag(id, x, y, z) {
        const agent = agents.get(id);
        if (agent?.held) {
          agent.held.x = x;
          agent.held.y = y;
          agent.held.z = z;
        }
      },
      onDragEnd(id, x, z, surface) {
        const agent = agents.get(id);
        if (!agent) return;
        agent.brain.held = false;
        agent.held = null;
        agent.tag.visible = false;
        const floor = env.def.floor;
        const safeX = Number.isFinite(x) ? x : agent.brain.x;
        const safeZ = Number.isFinite(z) ? z : agent.brain.z;
        if (surface) {
          agent.brain.placeAt(surface.x, surface.z);
          agent.parts.root.position.set(surface.x, surface.y, surface.z);
          agent.animator.setPose('sit');
          agent.brain.freeze('sit', 3);
        } else {
          const clampedX = Math.max(-floor.w / 2 + 0.5, Math.min(floor.w / 2 - 0.5, safeX));
          const clampedZ = Math.max(-floor.d / 2 + 0.5, Math.min(floor.d / 2 - 0.5, safeZ));
          agent.brain.placeAt(clampedX, clampedZ);
          agent.animator.setPose('stand');
        }
        audio.blip();
      },
      onVisitorClick(id) {
        game.logVisitor(id);
      },
      onBackground() {
        for (const agent of agents.values()) agent.tag.visible = false;
      },
    });
    refreshPickTargets();
    return picking;
  }

  /* ------------------------------------------------------------------ loop */

  function updateCats(dt: number, elapsed: number): void {
    const ctxObstacles = obstacles();
    const bounds = env.def.floor;

    // The eye now sits low and inside the room, and at the closest zoom it can end up *within*
    // the cat play rect. Without this a cat walks up to the lens and fills the entire frame.
    // Built from the camera's damped position, so cats dodge where it actually is.
    if (cameraPosition) {
      ctxObstacles.push({ x: cameraPosition.x, z: cameraPosition.z, r: 1.3 });
    }

    separateCats();

    for (const agent of agents.values()) {
      if (agent.petLeft > 0) {
        agent.petLeft -= dt;
        if (agent.petLeft <= 0 && agent.purring) {
          agent.purring = false;
          audio.stopPurr();
        }
      }

      const intent = agent.brain.update(dt, {
        mode,
        bounds,
        obstacles: ctxObstacles,
        feedingActive: feeding.active,
        rng: rand,
        reducedMotion: reduced,
      });

      if (intent.releaseFood) {
        feeding = releaseClaim(feeding, agent.id);
      }

      if (intent.wantFood && feeding.active) {
        const result = claimNearest(feeding, agent.id, { x: agent.brain.x, z: agent.brain.z });
        feeding = result.state;
        if (result.target) {
          agent.brain.setFoodTarget(result.target, result.target.kind === 'bowl' ? 'bowl' : 'food');
        }
      }

      if (intent.bite) {
        const held = claimOf(feeding, agent.id);
        if (held) {
          const result = takeBite(feeding, agent.id, held);
          feeding = result.state;
          if (result.accepted) {
            const mesh = snackMeshes.get(held);
            if (mesh) {
              mesh.takeBite();
              const p = mesh.group.position;
              particles.burst(4, () => RECIPES.nom(p.x, p.y + 0.2, p.z, hex(mesh.def.colorA)));
            }
            audio.nom();
            const def = mesh?.def.id ?? 'onigiri';
            if (result.finished) {
              game.recordSnackEaten(agent.id, def);
              agent.brain.setFoodTarget(null, 'food');
              agent.animator.flashEmotion('happy', 1.4);
            }
          }
        }
      }

      if (intent.sip) {
        const held = claimOf(feeding, agent.id);
        if (held && sipBowl(feeding, agent.id, held)) {
          audio.nom();
          const bowl = bowlMeshes.get(held);
          if (bowl) {
            const p = bowl.group.position;
            particles.burst(2, () => RECIPES.nom(p.x, p.y + 0.3, p.z, hex(PALETTE.cream)));
          }
        }
      }

      // Project brain state onto the mesh.
      const snap = agent.brain.snapshot();
      const root = agent.parts.root;
      if (agent.held) {
        root.position.x = damp(root.position.x, agent.held.x, 18, dt);
        root.position.y = damp(root.position.y, agent.held.y, 18, dt);
        root.position.z = damp(root.position.z, agent.held.z, 18, dt);
        root.rotation.z = Math.sin(elapsed * 8) * 0.08;
      } else {
        root.position.x = snap.x;
        root.position.z = snap.z;
        root.position.y = damp(root.position.y, CAT_BASE_Y, 10, dt);
        root.rotation.z = 0;
        root.rotation.y = snap.facing;
      }

      if (agent.petLeft <= 0 && agent.animator.getPose() !== snap.pose && !agent.animator.trickBusy) {
        agent.animator.setPose(snap.pose);
      }
      agent.animator.setSpeed(snap.speed);
      agent.animator.update(dt, elapsed);
    }
  }

  function updateFeedingMeshes(dt: number, elapsed: number): void {
    for (const mesh of snackMeshes.values()) mesh.update(dt, elapsed, reduced);
    for (const mesh of bowlMeshes.values()) mesh.update(dt, elapsed, reduced);
    reapFinishedMeshes();
  }

  let phaseCheck = 0;

  const world: World = {
    scene,

    update(dt, elapsed) {
      if (paused) {
        // Photo mode: freeze the brains but keep the render alive.
        for (const agent of agents.values()) agent.animator.update(dt * 0.15, elapsed);
        particles.update(dt, elapsed);
        return;
      }

      phaseCheck += dt;
      if (phaseCheck > 20) {
        phaseCheck = 0;
        applyDayNight();
      }

      env.update(dt, elapsed, currentPhase, reduced);
      for (const item of placed) item.update?.(dt, elapsed, currentPhase === 'night');

      updateCats(dt, elapsed);
      updateFeedingMeshes(dt, elapsed);
      emitAmbientParticles(dt);
      particles.update(dt, elapsed);
    },

    setEnvironment,

    attachPicking,

    getShell: computeShell,

    setCameraPosition(position) {
      cameraPosition = position;
    },

    setReducedMotion(next) {
      reduced = next;
      particles.setEnabled(!next);
      for (const agent of agents.values()) agent.animator.setReducedMotion(next);
    },

    setTimerDisplay(nextMode, clock, task) {
      const brainMode: BrainMode = nextMode === 'break' ? 'break' : nextMode === 'focus' ? 'focus' : 'idle';
      if (brainMode !== mode && !breakActive) mode = brainMode;
      else if (brainMode === 'break') mode = 'break';
      else if (!breakActive) mode = brainMode;

      env.laptop.draw(
        breakActive ? 'break' : nextMode === 'focus' ? 'focus' : 'idle',
        task,
        clock,
      );
    },

    beginBreak,
    endBreak,

    celebrate() {
      if (reduced) return;
      particles.burst(26, () => RECIPES.fish(0, 1, 0));
      for (const agent of agents.values()) agent.animator.flashEmotion('happy', 2.2);
    },

    nudge() {
      const list = [...agents.values()];
      if (list.length === 0) return;
      const agent = list[Math.floor(rand() * list.length)];
      // Front-centre of the slab, facing the camera.
      agent.brain.placeAt(rand.range(-1.2, 1.2), env.def.floor.d / 2 - 1.2);
      agent.brain.freeze('play', 3.4);
      agent.animator.setPose('play');
      agent.animator.flashEmotion('surprised', 2.4);
      agent.parts.root.rotation.y = Math.PI;
      if (!reduced) {
        const p = agent.parts.root.position;
        particles.burst(4, (i) => RECIPES.heart(p.x, p.y + 0.8, p.z, i));
      }
    },

    setPaused(next) {
      paused = next;
      picking?.setEnabled(!next);
    },

    getStats() {
      return { cats: agents.size, snacks: snackMeshes.size, particles: particles.sim.count };
    },

    dispose() {
      for (const un of unsubs) un();
      picking?.dispose();
      for (const agent of agents.values()) disposeTree(agent.parts.root);
      agents.clear();
      for (const mesh of snackMeshes.values()) mesh.dispose();
      for (const mesh of bowlMeshes.values()) mesh.dispose();
      snackMeshes.clear();
      bowlMeshes.clear();
      hideVisitor();
      env.dispose();
      particles.dispose();
      scene.clear();
    },
  };

  rebuildFurniture();
  syncCats();
  game.subscribe((state, prev) => {
    if (state.cats !== prev.cats) syncCats();
    if (state.unlocks.placements !== prev.unlocks.placements) rebuildFurniture();
  });

  const pending = game.getState().pendingVisitor;
  if (pending) showVisitor(pending);

  return world;
}
