/**
 * Boot, wiring, and the game loop.
 *
 * Ordering matters here:
 *   1. refuse to boot loudly (not blankly) if WebGL is missing
 *   2. build the store first — everything else reads from it
 *   3. build the scene, then the HUD, then attach input
 *   4. one rAF loop drives: timer tick → world update → render
 *
 * The timer is *not* driven by the loop's delta — it reads `Date.now()`, so a throttled tab, a
 * suspended laptop and a backgrounded phone all resolve to the same remaining time.
 */

import * as THREE from 'three';
import { bus } from './core/events';
import { formatClock } from './core/time';
import { isBreak, remainingAt } from './core/timer';
import { pushKonami } from './core/achievements';
import { createGame, resolveReducedMotion } from './store';
import { createCameraRig, focusFor } from './scene/camera';
import { SceneRenderer, webglAvailable } from './scene/renderer';
import { createWorld } from './scene/world';
import { mountHud } from './ui/hud';
import { mountPanels } from './ui/panels';
import { mountToasts } from './ui/toasts';
import { mountPhotoMode } from './ui/photo';
import { announce, qs } from './ui/dom';
import { audio, RADIO_STATIONS } from './audio/engine';
import { ENVIRONMENTS } from './data/environments';

const IDLE_NUDGE_MS = 120_000;

function boot(): void {
  const bootBox = document.getElementById('boot');
  const bootText = document.getElementById('boot-text');
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');

  if (!canvas || !ui) return;

  if (!webglAvailable()) {
    if (bootBox && bootText) {
      bootBox.hidden = false;
      bootText.textContent =
        'This browser cannot open a 3D canvas, so the room will not load. Try a different browser, or switch hardware acceleration on.';
    }
    return;
  }

  if (bootBox) bootBox.hidden = true;
  ui.hidden = false;

  /* ------------------------------------------------------------- systems */

  const game = createGame();
  let reduced = resolveReducedMotion(game.getState().settings.motion);
  document.body.dataset.motion = reduced ? 'reduced' : 'full';

  const rig = createCameraRig(globalThis.innerWidth, globalThis.innerHeight);
  rig.setReducedMotion(reduced);

  const world = createWorld(game);

  const renderer = new SceneRenderer({
    canvas,
    scene: world.scene,
    camera: rig.camera,
    pixelScale: game.getState().settings.pixelScale,
    bloom: game.getState().settings.bloom,
    shadows: game.getState().settings.showShadows,
  });

  // Two volumes, two opposite jobs: contain the desk, stay inside the room. Both are set
  // before the first paint so the opening frame is already an interior one.
  rig.setFocus(focusFor(globalThis.innerWidth / Math.max(1, globalThis.innerHeight)));
  rig.setShell(world.getShell());
  world.attachPicking(canvas, rig.camera, {
    orbitBy: (dAz, dEl) => rig.orbitBy(dAz, dEl),
    zoomBy: (delta) => rig.zoomBy(delta),
  });
  world.setReducedMotion(reduced);

  const disposeToasts = mountToasts(qs('#toasts'));

  const photo = mountPhotoMode(qs('#photo'), game, rig, renderer, {
    onOpen: () => world.setPaused(true),
    onClose: () => {
      world.setPaused(false);
      syncCameraMood();
    },
  });

  const panels = mountPanels(qs('#panels'), {
    game,
    onMotionChange(next) {
      reduced = next;
      document.body.dataset.motion = next ? 'reduced' : 'full';
      rig.setReducedMotion(next);
      world.setReducedMotion(next);
    },
    onPixelScale: (v) => renderer.setPixelScale(v),
    onBloom: (v) => renderer.setBloom(v),
    onShadows: (v) => renderer.setShadows(v),
    onPhotoMode: () => {
      panels.close();
      photo.open();
    },
  });

  const hud = mountHud(game, (id) => panels.open(id));

  /* --------------------------------------------------------------- audio */

  function syncAudioToWorld(): void {
    const s = game.getState();
    audio.applySettings({ ...s.settings.volume, muted: s.settings.muted });
    const station = RADIO_STATIONS.find((r) => r.id === s.settings.radio) ?? RADIO_STATIONS[0];
    audio.setStation(station.id);
    const env = ENVIRONMENTS[s.settings.environment];
    audio.setAmbience(env.ambience);
    audio.setRain(env.id === 'cafe');
  }

  // The AudioContext can only start from a gesture — the first interaction anywhere does it.
  let audioStarted = false;
  async function startAudio(): Promise<void> {
    if (audioStarted) return;
    const ok = await audio.resume();
    if (!ok) return;
    audioStarted = true;
    syncAudioToWorld();
    audio.startMusic();
  }
  for (const event of ['pointerdown', 'keydown'] as const) {
    document.addEventListener(event, () => void startAudio(), { once: false, passive: true });
  }

  bus.on('settings:changed', syncAudioToWorld);
  bus.on('env:changed', () => {
    syncAudioToWorld();
    // A new world has a different shell — re-cap so the eye stays inside this one.
    rig.setShell(world.getShell());
  });

  /* --------------------------------------------------------------- camera */

  function syncCameraMood(): void {
    if (photo.isOpen()) return;
    const t = game.timer();
    if (t.mode === 'focus' && t.running) rig.setMood('focus');
    else if (isBreak(t.mode)) rig.setMood('break');
    else rig.setMood('idle');
  }

  /* ---------------------------------------------------------- transitions */

  bus.on('timer:transition', ({ from, to, natural }) => {
    if (isBreak(to)) {
      if (natural) {
        audio.chime();
        world.celebrate();
        bus.emit('toast', { title: 'SNACK TIME!', body: 'the cats heard the chime', icon: '🍙', tone: 'reward' });
      }
      world.beginBreak();
    } else if (isBreak(from)) {
      world.endBreak();
      if (natural) {
        audio.softChime();
        bus.emit('toast', { title: 'BACK TO IT', body: 'the laptop is booting up', icon: '💻', tone: 'gentle' });
      }
    }
    syncCameraMood();
    hud.refreshChips();
  });

  bus.on('timer:start', syncCameraMood);
  bus.on('timer:pause', syncCameraMood);
  bus.on('timer:reset', () => {
    world.endBreak();
    syncCameraMood();
  });
  bus.on('economy:coins', ({ delta }) => {
    if (delta > 0) audio.coin();
  });
  bus.on('achievement:unlocked', () => audio.fanfare());

  /* -------------------------------------------------------------- konami */

  let konamiBuffer: string[] = [];
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const result = pushKonami(konamiBuffer, event.key);
    konamiBuffer = result.buffer;
    if (result.complete) {
      game.unlockKonami();
      audio.fanfare();
    }
  });

  /* --------------------------------------------------------------- resize */

  function resize(): void {
    const w = globalThis.innerWidth;
    const h = globalThis.innerHeight;
    renderer.resize(w, h);
    rig.frame(w, h);
  }

  /**
   * Keyboard camera control. The canvas is focusable, so orbit and zoom are reachable without a
   * pointer — the same arc, the same limits (a11y contract, DESIGN.md §8).
   */
  canvas.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? 12 : 5;
    switch (event.key) {
      case 'ArrowLeft':
        rig.orbitBy(step, 0);
        break;
      case 'ArrowRight':
        rig.orbitBy(-step, 0);
        break;
      case 'ArrowUp':
        rig.orbitBy(0, step);
        break;
      case 'ArrowDown':
        rig.orbitBy(0, -step);
        break;
      case '+':
      case '=':
        rig.zoomBy(-0.06);
        break;
      case '-':
      case '_':
        rig.zoomBy(0.06);
        break;
      case '0':
        rig.resetView();
        announce('View reset');
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  resize();
  globalThis.addEventListener('resize', resize);
  globalThis.addEventListener('orientationchange', resize);

  // A change in the OS motion preference applies immediately when the setting is on "auto".
  try {
    const query = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    query.addEventListener('change', () => {
      if (game.getState().settings.motion !== 'auto') return;
      reduced = query.matches;
      document.body.dataset.motion = reduced ? 'reduced' : 'full';
      rig.setReducedMotion(reduced);
      world.setReducedMotion(reduced);
    });
  } catch {
    /* older browsers: the setting still works, it just doesn't live-update */
  }

  /* ----------------------------------------------------------- lifecycle */

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      game.persist();
      return;
    }
    // Catch up on anything that completed while we were away.
    game.tick(Date.now());
    hud.update(Date.now());
    syncCameraMood();
  });

  globalThis.addEventListener('beforeunload', () => game.persist());
  globalThis.addEventListener('pagehide', () => game.persist());

  /* ------------------------------------------------------------- the loop */

  let lastFrame = performance.now();
  let elapsed = 0;
  let lastInteraction = performance.now();
  let nudged = false;

  for (const event of ['pointerdown', 'keydown', 'pointermove'] as const) {
    document.addEventListener(
      event,
      () => {
        lastInteraction = performance.now();
        nudged = false;
      },
      { passive: true },
    );
  }

  function frame(now: number): void {
    // Clamp the delta: a tab restored after ten minutes must not integrate a 600 s step.
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    elapsed += dt;

    const wallNow = Date.now();
    game.tick(wallNow);

    const t = game.timer();
    const remaining = remainingAt(t, wallNow);
    hud.update(wallNow);

    world.setTimerDisplay(
      t.mode === 'focus' ? 'focus' : isBreak(t.mode) ? 'break' : 'idle',
      formatClock(remaining),
      t.task,
    );
    world.update(dt, elapsed, wallNow);
    // The camera rig must be stepped every frame or nothing it owns ever moves: the orbit drag,
    // the scroll zoom, the focus/break dolly and the idle sway are all damped toward targets
    // inside this call.
    rig.update(dt, elapsed);
    world.setCameraPosition(rig.camera.position);
    renderer.render(elapsed);

    // "Idle > 2 min with the timer off → a cat comes to the camera" (spec §8.9).
    if (!nudged && !t.running && !photo.isOpen() && now - lastInteraction > IDLE_NUDGE_MS) {
      nudged = true;
      world.nudge();
    }

    globalThis.requestAnimationFrame(frame);
  }

  globalThis.requestAnimationFrame(frame);

  /* ------------------------------------------------------------- greeting */

  const state = game.getState();
  if (game.loadStatus === 'recovered') {
    bus.emit('toast', {
      title: 'SAVE WAS UNREADABLE',
      body: 'we started a fresh room — your old save could not be parsed',
      icon: '💾',
      tone: 'gentle',
    });
  } else if (game.loadStatus === 'migrated') {
    bus.emit('toast', { title: 'WELCOME BACK', body: 'your save was updated to the new format', icon: '💾', tone: 'gentle' });
  } else if (game.loadStatus === 'fresh') {
    bus.emit('toast', {
      title: 'HELLO',
      body: 'set a task, press start. Mochi will keep you company.',
      icon: '🐈',
      tone: 'gentle',
    });
  } else {
    const n = state.cats.length;
    bus.emit('toast', {
      title: 'WELCOME BACK',
      body: `${n} cat${n === 1 ? '' : 's'} · ${state.economy.coins} 🐟`,
      icon: '🐈',
      tone: 'gentle',
    });
  }

  announce('Study With Cats is ready. Press space to start a focus session.');

  // Expose a tiny handle for the e2e/geometry probes — read-only, no game control.
  (globalThis as unknown as { __swc?: unknown }).__swc = {
    ready: true,
    stats: () => ({ ...world.getStats(), draw: renderer.stats() }),
    // Render diagnostics for the perf/quality gate: how many meshes actually participate in the
    // shadow pass, and whether the shadow map is switched on at all.
    shadows: () => {
      let casters = 0;
      let receivers = 0;
      let meshes = 0;
      world.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshes++;
        if (mesh.castShadow) casters++;
        if (mesh.receiveShadow) receivers++;
      });
      const light = world.scene.children.find(
        (c) => (c as THREE.DirectionalLight).isDirectionalLight && c.castShadow,
      ) as THREE.DirectionalLight | undefined;
      return {
        enabled: renderer.renderer.shadowMap.enabled,
        type: renderer.renderer.shadowMap.type,
        meshes,
        casters,
        receivers,
        light: light
          ? {
              intensity: light.intensity,
              position: light.position.toArray().map((n) => Math.round(n * 100) / 100),
              target: light.target.position.toArray(),
              targetInScene: Boolean(light.target.parent),
              mapSize: [light.shadow.mapSize.x, light.shadow.mapSize.y],
              cam: {
                left: light.shadow.camera.left,
                right: light.shadow.camera.right,
                top: light.shadow.camera.top,
                bottom: light.shadow.camera.bottom,
                near: light.shadow.camera.near,
                far: light.shadow.camera.far,
              },
              bias: light.shadow.bias,
              normalBias: light.shadow.normalBias,
            }
          : null,
      };
    },
    timer: () => ({ mode: game.timer().mode, running: game.timer().running, remaining: remainingAt(game.timer(), Date.now()) }),

    /**
     * How enclosed does the room feel — as a number rather than an opinion about a screenshot.
     *
     * Renders one throwaway frame with the sky swapped for a sentinel magenta, then samples the
     * result. Any sampled pixel that is still magenta is somewhere the viewer can see *past* the
     * room. A room you are standing inside shows none of it along the frame edges.
     *
     * Using a sentinel rather than comparing against the current sky colour keeps the check
     * honest across all four worlds and every day-night phase, where the sky is a different
     * colour each time and can legitimately resemble a wall.
     */
    enclosure: (grid = 48) => {
      const scene = world.scene;
      const previous = scene.background;
      scene.background = new THREE.Color(0xff00ff);
      renderer.render(0);

      const source = renderer.renderer.domElement;
      const probe = document.createElement('canvas');
      probe.width = source.width;
      probe.height = source.height;
      const ctx = probe.getContext('2d', { willReadFrequently: true });

      let total = 0;
      let open = 0;
      let edgeTotal = 0;
      let edgeOpen = 0;
      let topTotal = 0;
      let topOpen = 0;
      let bottomTotal = 0;
      let bottomOpen = 0;
      let leftTotal = 0;
      let leftOpen = 0;
      let rightTotal = 0;
      let rightOpen = 0;
      const corners: boolean[] = [];

      if (ctx) {
        ctx.drawImage(source, 0, 0);
        const { width: w, height: h } = probe;
        // Bloom and the vignette tint the sentinel slightly, so match a magenta *region*, not an
        // exact value: strong red and blue, little green.
        const isSky = (r: number, g: number, b: number) => r > 190 && b > 190 && g < 90;
        const at = (px: number, py: number) => {
          const d = ctx.getImageData(Math.min(w - 1, Math.max(0, px)), Math.min(h - 1, Math.max(0, py)), 1, 1).data;
          return isSky(d[0], d[1], d[2]);
        };

        const rows = Math.max(8, Math.round(grid * (h / w)));
        for (let iy = 0; iy < rows; iy++) {
          for (let ix = 0; ix < grid; ix++) {
            const px = Math.round(((ix + 0.5) / grid) * w);
            const py = Math.round(((iy + 0.5) / rows) * h);
            const sky = at(px, py);
            total++;
            if (sky) open++;
            // The outermost ring is what decides whether the room runs off-frame. Edges are
            // counted separately because they are not equivalent: outdoors, sky along the TOP
            // edge is correct, while sky along the bottom means you can see the edge of the world.
            if (ix === 0 || iy === 0 || ix === grid - 1 || iy === rows - 1) {
              edgeTotal++;
              if (sky) edgeOpen++;
              if (iy === 0) { topTotal++; if (sky) topOpen++; }
              if (iy === rows - 1) { bottomTotal++; if (sky) bottomOpen++; }
              if (ix === 0) { leftTotal++; if (sky) leftOpen++; }
              if (ix === grid - 1) { rightTotal++; if (sky) rightOpen++; }
            }
          }
        }

        const inset = Math.round(Math.min(w, h) * 0.01);
        for (const [px, py] of [
          [inset, inset],
          [w - inset, inset],
          [inset, h - inset],
          [w - inset, h - inset],
        ] as Array<[number, number]>) {
          corners.push(at(px, py));
        }
      }

      scene.background = previous;
      renderer.render(0);

      const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
      return {
        skyPercent: pct(open, total),
        edgeSkyPercent: pct(edgeOpen, edgeTotal),
        topSky: pct(topOpen, topTotal),
        bottomSky: pct(bottomOpen, bottomTotal),
        leftSky: pct(leftOpen, leftTotal),
        rightSky: pct(rightOpen, rightTotal),
        cornersOpen: corners.filter(Boolean).length,
        // Bottom corners only: outdoors the top two may legitimately be sky.
        bottomCornersOpen: (corners[2] ? 1 : 0) + (corners[3] ? 1 : 0),
        sampled: total,
      };
    },

    /**
     * Is the whole diorama inside the frame? Projects the eight corners of the world's bounding
     * box into normalised device coordinates: every |ndc| <= 1 means nothing is cropped. This is
     * the "rendered completely to the edges" guarantee, expressed as a number rather than a
     * judgement about a screenshot.
     */
    fitCheck: () => {
      // Projects the FOCUS volume, not the room: "is the desk fully in shot", which is the half
      // of the old contract that still applies now that the room deliberately overflows.
      const { center, half } = focusFor(rig.camera.aspect);
      let maxX = 0;
      let maxY = 0;
      const v = new THREE.Vector3();
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            v.set(center.x + sx * half.x, center.y + sy * half.y, center.z + sz * half.z).project(rig.camera);
            maxX = Math.max(maxX, Math.abs(v.x));
            maxY = Math.max(maxY, Math.abs(v.y));
          }
        }
      }
      return {
        maxNdcX: Math.round(maxX * 1000) / 1000,
        maxNdcY: Math.round(maxY * 1000) / 1000,
        // Which term set the distance. A cap that bites at the default pose crops the desk with
        // no other visible signal, so it must be reported rather than inferred.
        interiorLimited: rig.isInteriorLimited(),
        fullyVisible: maxX <= 1 && maxY <= 1,
      };
    },
    camera: () => ({
      azimuth: rig.getAzimuth(),
      elevation: rig.getElevation(),
      zoom: rig.getZoom(),
      mood: rig.getMood(),
      position: rig.camera.position.toArray().map((n) => Math.round(n * 100) / 100),
    }),
    dispose() {
      hud.dispose();
      panels.dispose();
      photo.dispose();
      disposeToasts();
      world.dispose();
      renderer.dispose();
      audio.dispose();
    },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
