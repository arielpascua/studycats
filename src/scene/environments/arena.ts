/**
 * THE ARENA — the multiplayer scene, in whichever venue the party picked.
 *
 * Deliberately unlike the four solo worlds. Those are interiors you sit inside; this is a place
 * you *went*, with everyone's cat facing something warm in the middle. There is one builder here
 * and five venues (data/venues.ts): the clearing, the library, the café, the rooftop and the
 * museum are the same skeleton with different values, which is the only way five scenes could
 * all stay party-scaled without five chances to get the scaling wrong.
 *
 * The whole thing is built around one number — the ring radius — which comes from the party
 * size. Add a player and the floor widens, the seats spread, the posts multiply and the camera
 * pulls back to hold it all. Nothing here is a fixed size except the surround, which is the
 * horizon rather than the furniture.
 *
 * The light is the point. A warm centre against a cool key is the oldest trick in night-scene
 * painting and it is why these read as beautiful rather than merely dark: every cat gets a warm
 * rim on one side and a cold one on the other, in all five venues.
 */

import * as THREE from 'three';
import { hex } from '../../data/palette';
import { BONFIRE_STAGES, seats as ringSeats } from '../../core/party';
import { DEFAULT_VENUE, venueDef, type HearthKind, type VenueId } from '../../data/venues';
import { BoxBatch, box, boxGeo, flat, mergedBoxes, TAU, type BoxSpec } from '../voxel';

export interface BuiltArena {
  group: THREE.Group;
  /** Which venue this was built for. */
  venue: VenueId;
  /** Warm light at the centre; its reach grows with the shared hearth. */
  fireLight: THREE.PointLight;
  /** Cool key — the moon in the clearing, the ceiling lights indoors. */
  moonLight: THREE.DirectionalLight;
  /** Where sparks are emitted from. */
  firePoint: THREE.Vector3;
  /** 0..BONFIRE_STAGES — how far the shared hearth has grown. */
  setStage(stage: number, into: number): void;
  update(dt: number, elapsed: number, reducedMotion: boolean): void;
  dispose(): void;
}

/** A circle the posts must keep out of — the laptop stump, mainly. */
export interface Keepout {
  x: number;
  z: number;
  r: number;
}

const BEYOND_HALF = 60;

/** Tier layout per hearth kind: box size and height above the floor. */
const TIER_LAYOUT: Record<HearthKind, Array<{ s: number; y: number; flat?: number }>> = {
  fire: [
    { s: 0.62, y: 0.5 },
    { s: 0.5, y: 0.95 },
    { s: 0.4, y: 1.35 },
    { s: 0.3, y: 1.7 },
    { s: 0.2, y: 2.0 },
  ],
  // Shades stacked up a pole, each one wider than the last is tall — a lamp, not a fire.
  lamp: [
    { s: 0.78, y: 1.0, flat: 0.42 },
    { s: 0.66, y: 1.42, flat: 0.42 },
    { s: 0.54, y: 1.78, flat: 0.42 },
    { s: 0.42, y: 2.08, flat: 0.42 },
    { s: 0.3, y: 2.32, flat: 0.5 },
  ],
  steam: [
    { s: 0.36, y: 1.25 },
    { s: 0.32, y: 1.62 },
    { s: 0.28, y: 1.98 },
    { s: 0.23, y: 2.3 },
    { s: 0.18, y: 2.58 },
  ],
  crystal: [
    { s: 0.58, y: 1.05 },
    { s: 0.48, y: 1.5 },
    { s: 0.39, y: 1.88 },
    { s: 0.3, y: 2.2 },
    { s: 0.22, y: 2.46 },
  ],
};

/** The pit / table / counter / plinth the tiers grow out of. */
function buildHearthBase(kind: HearthKind, base: number, accent: number): THREE.Group {
  const batch = new BoxBatch();
  const g = new THREE.Group();
  g.name = `hearth-base:${kind}`;

  switch (kind) {
    case 'fire': {
      const stones = 12;
      for (let i = 0; i < stones; i++) {
        const a = (i / stones) * TAU;
        batch.add(
          { w: 0.34, h: 0.26, d: 0.34, x: Math.sin(a) * 1.05, y: 0.13, z: Math.cos(a) * 1.05, ry: a },
          base,
        );
      }
      batch.addMany(
        [
          { w: 1.5, h: 0.18, d: 0.28, y: 0.16, rz: 0.06 },
          { w: 0.28, h: 0.18, d: 1.5, y: 0.16, rz: -0.06 },
          { w: 1.2, h: 0.16, d: 0.24, y: 0.3, ry: 0.8 },
        ],
        accent,
      );
      break;
    }
    case 'lamp': {
      // A round reading table, then the brass column the shades climb.
      const top = 16;
      for (let i = 0; i < top; i++) {
        const a = (i / top) * TAU;
        batch.add({ w: 0.5, h: 0.16, d: 0.5, x: Math.sin(a) * 0.78, y: 0.62, z: Math.cos(a) * 0.78, ry: a }, base);
      }
      batch.addMany(
        [
          { w: 1.1, h: 0.16, d: 1.1, y: 0.62 },
          { w: 0.34, h: 0.62, d: 0.34, y: 0.31 },
          { w: 0.7, h: 0.12, d: 0.7, y: 0.06 },
        ],
        base,
      );
      batch.add({ w: 0.12, h: 0.55, d: 0.12, y: 0.95 }, accent);
      break;
    }
    case 'steam': {
      // A counter with a chrome machine on it. The steam is what grows.
      batch.addMany(
        [
          { w: 2.0, h: 0.78, d: 1.1, y: 0.39 },
          { w: 2.2, h: 0.12, d: 1.3, y: 0.84 },
        ],
        base,
      );
      batch.addMany(
        [
          { w: 0.9, h: 0.62, d: 0.7, y: 1.21 },
          { w: 1.0, h: 0.1, d: 0.8, y: 1.57 },
          { w: 0.14, h: 0.26, d: 0.14, x: 0.52, y: 1.05, z: 0.3 },
          { w: 0.14, h: 0.26, d: 0.14, x: -0.52, y: 1.05, z: 0.3 },
        ],
        accent,
      );
      break;
    }
    case 'crystal':
    default: {
      // A marble plinth with a rope-line of posts, because it is a museum.
      batch.addMany(
        [
          { w: 1.5, h: 0.14, d: 1.5, y: 0.07 },
          { w: 1.1, h: 0.78, d: 1.1, y: 0.53 },
          { w: 1.35, h: 0.12, d: 1.35, y: 0.98 },
        ],
        base,
      );
      const posts = 8;
      for (let i = 0; i < posts; i++) {
        const a = (i / posts) * TAU;
        batch.add({ w: 0.1, h: 0.6, d: 0.1, x: Math.sin(a) * 1.9, y: 0.3, z: Math.cos(a) * 1.9 }, accent);
        batch.add({ w: 0.16, h: 0.1, d: 0.16, x: Math.sin(a) * 1.9, y: 0.63, z: Math.cos(a) * 1.9 }, accent);
      }
      break;
    }
  }

  const mesh = batch.build(`hearth-base-${kind}`);
  g.add(mesh);
  return g;
}

export function buildArena(
  radius: number,
  memberCount: number,
  venueId: VenueId | string = DEFAULT_VENUE,
  keepouts: readonly Keepout[] = [],
): BuiltArena {
  const venue = venueDef(venueId);
  const t = venue.theme;
  const group = new THREE.Group();
  group.name = `arena:${venue.id}`;

  const islandRadius = radius + 2.6;

  /* ----------------------------------------------------------- the beyond */

  // A single dark plane under everything. No real reflection or texture — at this art scale a
  // flat, very dark value reads as water (or carpet, or asphalt) the moment something bright
  // sits on it, and a reflection pass would cost a second scene render for something the
  // hearth and the key light already imply.
  const beyond = box({ w: BEYOND_HALF * 2, h: 0.3, d: BEYOND_HALF * 2, y: -0.9 }, hex(t.beyond));
  beyond.castShadow = false;
  beyond.receiveShadow = false;
  group.add(beyond);

  // A paler ring just off the edge: the hearth's light on the shallows / on the floor.
  let wash: THREE.Mesh | null = null;
  if (t.wash) {
    wash = new THREE.Mesh(
      new THREE.RingGeometry(islandRadius, islandRadius + 3.2, 48),
      new THREE.MeshBasicMaterial({ color: hex(t.wash), transparent: true, opacity: 0.55 }),
    );
    wash.rotation.x = -Math.PI / 2;
    wash.position.y = -0.72;
    group.add(wash);
  }

  /* ------------------------------------------------------------ the floor */

  const batch = new BoxBatch();

  // The floor disc, built as concentric rings of boxes so it stays voxel rather than becoming a
  // smooth cylinder that would fight every other shape in the game.
  const rings = Math.max(4, Math.round(islandRadius / 0.75));
  for (let r = 0; r < rings; r++) {
    const ringRadius = (r / rings) * islandRadius;
    const count = Math.max(1, Math.round((TAU * ringRadius) / 0.85));
    const colour = r % 2 === 0 ? hex(t.floorA) : hex(t.floorB);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + r * 0.31;
      batch.add(
        { w: 0.9, h: 0.5, d: 0.9, x: Math.sin(a) * ringRadius, y: -0.25, z: Math.cos(a) * ringRadius, ry: a },
        colour,
      );
    }
  }

  // A lip around the edge, so the floor does not end on a hard line.
  const lip: BoxSpec[] = [];
  const lipCount = Math.round((TAU * islandRadius) / 0.6);
  for (let i = 0; i < lipCount; i++) {
    const a = (i / lipCount) * TAU;
    lip.push({
      w: 0.55,
      h: 0.22 + ((i * 7) % 3) * 0.09,
      d: 0.55,
      x: Math.sin(a) * (islandRadius + 0.12),
      y: -0.1,
      z: Math.cos(a) * (islandRadius + 0.12),
      ry: a,
    });
  }
  batch.addMany(lip, hex(t.lip));

  /* ---------------------------------------------------------- seats + posts */

  const ring = ringSeats(memberCount, radius);

  // One cushion per player, at exactly the seat the party model computed — the scene never
  // invents its own positions, so what the tests assert is what you see.
  for (const seat of ring) {
    batch.add({ w: 0.92, h: 0.16, d: 0.92, x: seat.x, y: 0.08, z: seat.z, ry: seat.facing }, hex(t.seatA));
    batch.add({ w: 0.74, h: 0.08, d: 0.74, x: seat.x, y: 0.19, z: seat.z, ry: seat.facing }, hex(t.seatB));
  }

  // Posts sit *between* seats, so they light the gaps rather than the cats' faces.
  //
  // With an even number of players one of those gaps lands dead behind the ring, which is
  // exactly where the laptop stump goes — the post and the laptop were drawn inside each other.
  // The stump passes itself in as a keepout rather than the arena hardcoding where it is; the
  // gap that leaves is not a hole in the lighting, because the laptop's own screen lights it.
  const postTops: THREE.Vector3[] = [];
  const postR = radius + 1.5;
  const halfPost = t.postHeight / 2;
  for (let i = 0; i < ring.length; i++) {
    const a = ((i + 0.5) / ring.length) * TAU;
    const x = Math.sin(a) * postR;
    const z = Math.cos(a) * postR;
    if (keepouts.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
    batch.add({ w: 0.12, h: t.postHeight, d: 0.12, x, y: halfPost, z }, hex(t.post));
    postTops.push(new THREE.Vector3(x, t.postHeight + 0.12, z));
  }

  const statics = batch.build(`arena-floor:${venue.id}`);
  group.add(statics);

  // The glows are unlit boxes: they must not be shaded by the very light they represent.
  const lanterns: THREE.Mesh[] = [];
  const lanternGeo = boxGeo(0.26, 0.3, 0.26);
  for (const p of postTops) {
    const lamp = new THREE.Mesh(lanternGeo, flat(hex(t.glow)));
    lamp.position.copy(p);
    lamp.castShadow = false;
    group.add(lamp);
    lanterns.push(lamp);
  }

  /* ----------------------------------------------------------- the hearth */

  const kind = t.hearth.kind;
  const firePoint = new THREE.Vector3(0, kind === 'fire' ? 0.5 : 1.0, 0);

  group.add(buildHearthBase(kind, hex(t.hearth.base), hex(t.hearth.baseAccent)));

  // Five tiers. Each stage reveals one more, so the hearth visibly grows as the party banks
  // focus together — the one object in the game that only exists because other people are here.
  const layout = TIER_LAYOUT[kind];
  const tiers: THREE.Mesh[] = [];
  for (let i = 0; i < layout.length; i++) {
    const f = layout[i];
    const h = f.flat ? f.s * f.flat : f.s;
    const mesh = new THREE.Mesh(boxGeo(f.s, h, f.s), flat(hex(t.hearth.tiers[i])));
    mesh.position.y = f.y;
    mesh.castShadow = false;
    mesh.visible = false;
    group.add(mesh);
    tiers.push(mesh);
  }

  const fireLight = new THREE.PointLight(hex(t.hearth.light), 2.5, t.hearth.reach + 5, 2);
  fireLight.position.copy(firePoint);
  // Deliberately NOT a shadow caster. A PointLight shadow is a cube map: six extra renders of
  // the whole scene, which measured as most of a 294-call frame on its own. The key casts the
  // shadows; the hearth only lights. Nobody looking at the picture can tell.
  fireLight.castShadow = false;
  group.add(fireLight);

  /* -------------------------------------------------------- orb + ceiling */

  // Big, flat and unlit, high and behind: the cool half of the lighting and often the only thing
  // in the sky, so it has to carry that whole side of the frame.
  let orb: THREE.Mesh | null = null;
  let halo: THREE.Mesh | null = null;
  if (t.orb) {
    orb = new THREE.Mesh(boxGeo(t.orb.size, t.orb.size, 0.4), flat(hex(t.orb.color)));
    orb.position.set(...t.orb.position);
    orb.castShadow = false;
    group.add(orb);

    halo = new THREE.Mesh(
      new THREE.RingGeometry(t.orb.size * 0.74, t.orb.size * 1.53, 40),
      new THREE.MeshBasicMaterial({ color: hex(t.orb.halo), transparent: true, opacity: 0.16, side: THREE.DoubleSide }),
    );
    halo.position.copy(orb.position);
    halo.position.z += 0.3;
    halo.scale.setScalar(0.85);
    group.add(halo);
  }

  if (t.ceiling) {
    // Interiors need a lid or the camera tips up into bare sky and the room stops being a room.
    const lid = box({ w: t.surround.radius * 2.2, h: 0.4, d: t.surround.radius * 2.2, y: t.ceiling.y }, hex(t.ceiling.color));
    lid.castShadow = false;
    lid.receiveShadow = false;
    group.add(lid);
  }

  const moonLight = new THREE.DirectionalLight(hex(t.key.color), t.key.intensity);
  moonLight.position.set(...t.key.position);
  // The only caster in the arena, so the cats keep their grounding shadows.
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  moonLight.shadow.camera.near = 1;
  moonLight.shadow.camera.far = 70;
  moonLight.shadow.camera.left = -16;
  moonLight.shadow.camera.right = 16;
  moonLight.shadow.camera.top = 16;
  moonLight.shadow.camera.bottom = -16;
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0016;
  moonLight.shadow.normalBias = 0.03;
  group.add(moonLight);
  group.add(moonLight.target);

  /* ------------------------------------------------------------- surround */

  // The far ring: a treeline, a wall of shelves, a skyline, a colonnade. Same primitive, four
  // very different silhouettes — it gives the horizon a shape and hides its edge.
  const sur = t.surround;
  const pillars: BoxSpec[] = [];
  for (let i = 0; i < sur.count; i++) {
    const a = (i / sur.count) * TAU;
    const h = sur.minHeight + (sur.varyHeight > 0 ? ((i * 13) % 7) / 6 * sur.varyHeight : 0);
    const jitter = sur.jitter > 0 ? ((i * 5) % 4) * (sur.jitter / 3) : 0;
    pillars.push({
      w: sur.width,
      h,
      d: sur.width,
      x: Math.sin(a) * (sur.radius + jitter),
      y: h / 2 - 0.6,
      z: Math.cos(a) * (sur.radius + jitter),
      ry: a,
    });
  }
  const surround = mergedBoxes(pillars, hex(sur.color));
  if (surround) {
    surround.castShadow = false;
    surround.receiveShadow = false;
    group.add(surround);
  }

  // Bands are drawn as their own ring just inside the surround, so a shelf row or a lit window
  // sits proud of the face instead of z-fighting with it.
  // A solid wall behind a gapped surround. Built first so the columns read as standing in
  // front of it rather than embedded in it.
  if (sur.backdrop) {
    const wallCount = Math.round((TAU * (sur.radius + sur.width)) / 0.9);
    const wallR = sur.radius + sur.width * 1.1;
    const wall: BoxSpec[] = [];
    for (let i = 0; i < wallCount; i++) {
      const a = (i / wallCount) * TAU;
      wall.push({
        w: 1.0,
        h: sur.backdrop.height,
        d: 1.0,
        x: Math.sin(a) * wallR,
        y: sur.backdrop.height / 2 - 0.6,
        z: Math.cos(a) * wallR,
        ry: a,
      });
    }
    const mesh = mergedBoxes(wall, hex(sur.backdrop.color));
    if (mesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
  }

  // Bands are bucketed by colour across EVERY row before anything is merged, so a whole wall of
  // books costs one draw call per distinct book colour (seven) rather than one per row per
  // colour (forty-two). Merging per row put the arena exactly on its 300-call ceiling.
  const bandsByColour = new Map<string, BoxSpec[]>();
  for (const band of sur.bands ?? []) {
    for (let i = 0; i < sur.count; i++) {
      const a = (i / sur.count) * TAU;
      const jitter = sur.jitter > 0 ? ((i * 5) % 4) * (sur.jitter / 3) : 0;
      const br = sur.radius + jitter - sur.width * 0.45;
      const colour = band.colors[i % band.colors.length];
      const list = bandsByColour.get(colour) ?? [];
      list.push({
        w: sur.width * 0.92,
        h: band.height,
        d: sur.width * 0.92,
        x: Math.sin(a) * br,
        y: band.y,
        z: Math.cos(a) * br,
        ry: a,
      });
      bandsByColour.set(colour, list);
    }
  }
  for (const [colour, specs] of bandsByColour) {
    const mesh = mergedBoxes(specs, hex(colour));
    if (!mesh) continue;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  /* ------------------------------------------------------------- behaviour */

  let stage = 0;
  let into = 0;
  let flicker = 0;

  return {
    group,
    venue: venue.id,
    fireLight,
    moonLight,
    firePoint,

    setStage(nextStage, nextInto) {
      stage = Math.max(0, Math.min(BONFIRE_STAGES, Math.round(nextStage)));
      into = Math.max(0, Math.min(1, nextInto));
      for (let i = 0; i < tiers.length; i++) {
        // The tier currently being earned fades in, so progress is visible between stages
        // rather than only at the moment one completes.
        tiers[i].visible = i < stage || (i === stage && into > 0.15);
      }
    },

    update(dt, elapsed, reducedMotion) {
      flicker += dt;
      const lit = Math.max(0.35, stage + into);

      for (let i = 0; i < tiers.length; i++) {
        const mesh = tiers[i];
        if (!mesh.visible) continue;
        const growing = i === stage;
        const base = growing ? 0.35 + into * 0.65 : 1;

        if (kind === 'fire') {
          const wobble = reducedMotion ? 1 : 1 + Math.sin(flicker * (6.5 + i * 2.1) + i) * 0.18;
          const s = base * wobble;
          mesh.scale.set(s, s * 1.25, s);
          mesh.rotation.y = reducedMotion ? 0 : Math.sin(flicker * 1.8 + i) * 0.35;
        } else if (kind === 'steam') {
          // Puffs drift up and thin out rather than flickering: a machine, not a flame.
          const rise = reducedMotion ? 0 : ((flicker * 0.5 + i * 0.31) % 1) * 0.5;
          mesh.position.y = layout[i].y + rise;
          const s = base * (reducedMotion ? 1 : 1 + rise * 0.6);
          mesh.scale.setScalar(s);
          const m = mesh.material as THREE.MeshBasicMaterial;
          m.transparent = true;
          m.opacity = reducedMotion ? 0.8 : 0.85 - rise * 1.1;
        } else if (kind === 'crystal') {
          // Slow rotation and a long breath — the exhibit is still, it just catches the light.
          mesh.scale.setScalar(base);
          mesh.rotation.y = reducedMotion ? 0.4 : flicker * (0.25 + i * 0.06) + i;
          mesh.rotation.x = reducedMotion ? 0 : Math.sin(flicker * 0.6 + i) * 0.18;
        } else {
          // lamp: shades hold still; only the light breathes.
          mesh.scale.set(base, base, base);
        }
      }

      fireLight.distance = t.hearth.reach + lit * 2.4;
      const steady = kind === 'lamp' || kind === 'crystal';
      fireLight.intensity = reducedMotion || steady
        ? 1.4 + lit * 0.7 + (steady && !reducedMotion ? Math.sin(flicker * 1.3) * 0.12 : 0)
        : 1.4 + lit * 0.7 + Math.sin(flicker * 9) * 0.22 + Math.sin(flicker * 3.7) * 0.14;

      for (let i = 0; i < lanterns.length; i++) {
        const m = lanterns[i].material as THREE.MeshBasicMaterial;
        m.transparent = true;
        m.opacity = reducedMotion ? 0.95 : 0.72 + Math.sin(elapsed * 1.4 + i * 1.7) * 0.24;
      }
    },

    dispose() {
      if (wash) {
        wash.geometry.dispose();
        (wash.material as THREE.Material).dispose();
      }
      if (halo) {
        halo.geometry.dispose();
        (halo.material as THREE.Material).dispose();
      }
      group.clear();
    },
  };
}
