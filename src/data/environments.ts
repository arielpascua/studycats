import { PALETTE } from './palette';
import type { DayPhase } from '../core/time';

export type EnvironmentId = 'room' | 'picnic' | 'bonfire' | 'cafe' | 'arena';

/** The worlds you can study in alone. The arena is multiplayer-only and never appears here. */
export type SoloEnvironmentId = Exclude<EnvironmentId, 'arena'>;

/**
 * The *shell*: the volume the viewer is standing inside.
 *
 * This is deliberately NOT `floor`. `floor` is the gameplay footprint — where cats wander,
 * where snacks scatter, where a dragged cat is clamped — and it must stay small and near the
 * desk. The shell is the visual room around all that, and it exists to run off the edges of
 * the frame so the scene reads as somewhere you are, rather than an object you are looking at.
 *
 * The far walls sit exactly where they always did (so the window, shelf, skirting and every
 * furniture slot anchor keep their coordinates); the shell only grows toward the camera, into
 * space that is behind the viewer and therefore never seen.
 */
export interface ShellDef {
  /** 'walls' = an enclosed interior. 'open' = ground running out to a horizon rim. */
  kind: 'walls' | 'open';
  /** Interior extents. The camera rig guarantees the eye never leaves this box. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /**
    * The eye's vertical limit. For an interior this is the wall and ceiling height. Outdoors
    * there is no ceiling, so it is set far above anything reachable — conflating it with the
    * horizon ridge's height pinned the camera to its minimum distance and cropped the desk.
    */
  ceiling: number;
  /** Height of the horizon ridge. Open worlds only. */
  rimHeight: number;
  /** Half-extent of the visible ground. Open worlds run far past the frustum. */
  groundHalf: number;
}

export interface EnvironmentDef {
  id: EnvironmentId;
  /** Chrome label — kept in the source spec's voice. */
  label: string;
  blurb: string;
  icon: string;
  /** Coin price; the cozy room is free and always available. */
  price: number;
  /** Sky/backdrop colour per day phase — this is what makes 11pm feel like 11pm. */
  sky: Record<DayPhase, string>;
  /** Warm key light tint + intensity per phase. */
  key: Record<DayPhase, { color: string; intensity: number }>;
  ambient: Record<DayPhase, { color: string; intensity: number }>;
  /** Ambient audio layer id. */
  ambience: 'room' | 'birds' | 'fire' | 'cafe';
  /** Snack pool available in this world (ids from data/snacks). */
  snacks: readonly string[];
  /** Gameplay footprint in world units — cats path inside this. NOT the visual room size. */
  floor: { w: number; d: number };
  /**
   * Where that footprint is centred. Optional; defaults to the origin. The interiors' far walls
   * are at -x/-z and the rooms extend toward the viewer, so a rect centred on the origin could
   * only ever be as wide as the distance to the nearest far wall — the cats had a strip to pace
   * in while two-thirds of the floor went unused.
   */
  floorCenter?: { x: number; z: number };
  /** The room around the gameplay footprint. See ShellDef. */
  shell: ShellDef;
}

/**
 * How far the shell reaches toward the viewer. The camera orbits into the +x/+z quadrant, so
 * this is the only direction that has to grow — and growing it is free visually, because it is
 * all behind the eye.
 */
// The eye's room, behind and above the viewer. Grown with the focus box: a wider shot needs
// somewhere to back off TO, and the far walls (min-x, min-z — the ones you see) never move.
const NEAR_X = 14.0;
const NEAR_Z = 13.5;
// Taller than it looks: at these framings the eye never sees above about y=5, so the extra
// height is invisible. It exists to keep the ceiling from capping the camera's standoff at high
// elevation, which would silently crop the desk.
const WALL_H = 12.5;
/** Outdoors the only thing above you is sky, so the eye has no practical vertical limit. */
const OPEN_SKY = 60;

const NIGHT_KEY = { color: PALETTE.lavDeep, intensity: 0.8 };

export const ENVIRONMENTS: Record<EnvironmentId, EnvironmentDef> = {
  room: {
    id: 'room',
    label: 'COZY ROOM',
    blurb: 'lavender walls, a window, and the rug you always sit on',
    icon: '🛏',
    price: 0,
    sky: {
      dawn: '#E8CBD8',
      morning: '#DCE3F2',
      afternoon: '#D9DDF0',
      golden: '#F3CBA8',
      dusk: '#C2A7CE',
      night: '#2A2340',
    },
    key: {
      dawn: { color: '#F5C9C0', intensity: 0.9 },
      morning: { color: '#FFF4E2', intensity: 1.25 },
      afternoon: { color: '#FFF8EC', intensity: 1.3 },
      golden: { color: '#FFD3A0', intensity: 1.35 },
      dusk: { color: '#E0B7C8', intensity: 0.85 },
      night: NIGHT_KEY,
    },
    ambient: {
      dawn: { color: '#C7BFEA', intensity: 0.55 },
      morning: { color: '#E4E7F5', intensity: 0.62 },
      afternoon: { color: '#EDE9F6', intensity: 0.65 },
      golden: { color: '#F6C99F', intensity: 0.6 },
      dusk: { color: '#B9A5CF', intensity: 0.5 },
      night: { color: '#5B4E82', intensity: 0.66 },
    },
    ambience: 'room',
    snacks: ['onigiri', 'melonpan', 'marshmallow', 'sardine', 'milkbread'],
    floor: { w: 14.1, d: 12.2 },
    floorCenter: { x: 2.45, z: 2.9 },
    // Far walls unchanged at x -5.5 / z -4.0; the room simply extends behind the viewer.
    shell: { kind: 'walls', minX: -5.5, maxX: NEAR_X, minZ: -4.0, maxZ: NEAR_Z, ceiling: WALL_H, rimHeight: 0, groundHalf: 0 },
  },

  picnic: {
    id: 'picnic',
    label: 'PICNIC HILL',
    blurb: 'a checkered blanket, tall grass, and something buzzing past',
    icon: '🧺',
    price: 120,
    sky: {
      dawn: '#F3D2C8',
      morning: '#CDE4F0',
      afternoon: '#BFDFF2',
      golden: '#F7C89A',
      dusk: '#C6A9D2',
      night: '#242046',
    },
    key: {
      dawn: { color: '#FFD2B8', intensity: 1.0 },
      morning: { color: '#FFFBEE', intensity: 1.4 },
      afternoon: { color: '#FFFDF4', intensity: 1.5 },
      golden: { color: '#FFC98C', intensity: 1.4 },
      dusk: { color: '#DCB6CE', intensity: 0.8 },
      night: NIGHT_KEY,
    },
    ambient: {
      dawn: { color: '#DCC7DE', intensity: 0.6 },
      morning: { color: '#DFEFF6', intensity: 0.7 },
      afternoon: { color: '#E7F3FA', intensity: 0.72 },
      golden: { color: '#F6D3AA', intensity: 0.62 },
      dusk: { color: '#B4A2CB', intensity: 0.5 },
      night: { color: '#564A80', intensity: 0.62 },
    },
    ambience: 'birds',
    snacks: ['sandwich', 'strawberry', 'melonpan', 'onigiri', 'lemonade', 'friedchicken', 'meatball'],
    floor: { w: 17, d: 14 },
    // Outdoors: no walls, but the ground has to reach past the frustum in every direction or
    // you can see the edge of the world at the bottom of the frame.
    shell: { kind: 'open', minX: -22, maxX: 22, minZ: -22, maxZ: 22, ceiling: OPEN_SKY, rimHeight: 6.5, groundHalf: 46 },
  },

  bonfire: {
    id: 'bonfire',
    label: 'BONFIRE NIGHT',
    blurb: 'logs, sparks, and a marshmallow on a stick',
    icon: '🔥',
    price: 200,
    sky: {
      dawn: '#4C4270',
      morning: '#6E6395',
      afternoon: '#7C6BB0',
      golden: '#8A6A8E',
      dusk: '#3F3560',
      night: '#1E1A38',
    },
    key: {
      dawn: { color: '#B79ED0', intensity: 0.6 },
      morning: { color: '#C9B7E0', intensity: 0.7 },
      afternoon: { color: '#D3C4E8', intensity: 0.75 },
      golden: { color: '#E8AE8C', intensity: 0.8 },
      dusk: { color: '#9E82BE', intensity: 0.55 },
      night: { color: '#8877BE', intensity: 0.6 },
    },
    ambient: {
      dawn: { color: '#4E4374', intensity: 0.42 },
      morning: { color: '#5D5288', intensity: 0.46 },
      afternoon: { color: '#6A5D97', intensity: 0.48 },
      golden: { color: '#8A6A8E', intensity: 0.46 },
      dusk: { color: '#3F3560', intensity: 0.4 },
      night: { color: '#463C6B', intensity: 0.52 },
    },
    ambience: 'fire',
    snacks: ['marshmallow', 'sardine', 'sandwich', 'cocoa', 'sweetpotato', 'yakitori', 'steak'],
    floor: { w: 16, d: 14 },
    shell: { kind: 'open', minX: -22, maxX: 22, minZ: -22, maxZ: 22, ceiling: OPEN_SKY, rimHeight: 7.2, groundHalf: 46 },
  },

  cafe: {
    id: 'cafe',
    label: 'RAINY CAFÉ',
    blurb: 'window seat, two lamps, and rain doing all the talking',
    icon: '☕',
    price: 260,
    sky: {
      dawn: '#9FA6BE',
      morning: '#A9B0C6',
      afternoon: '#AEB4CA',
      golden: '#B9A9BE',
      dusk: '#8C87A8',
      night: '#2E2B48',
    },
    key: {
      dawn: { color: '#D9CFE0', intensity: 0.7 },
      morning: { color: '#E6E2EE', intensity: 0.85 },
      afternoon: { color: '#EAE6F0', intensity: 0.88 },
      golden: { color: '#E8C9AE', intensity: 0.8 },
      dusk: { color: '#BFB1CE', intensity: 0.65 },
      night: { color: '#9A88C6', intensity: 0.68 },
    },
    ambient: {
      dawn: { color: '#9AA0B8', intensity: 0.55 },
      morning: { color: '#B3B8CC', intensity: 0.6 },
      afternoon: { color: '#BBC0D2', intensity: 0.62 },
      golden: { color: '#C4B2C2', intensity: 0.58 },
      dusk: { color: '#8F8AAB', intensity: 0.5 },
      night: { color: '#544A78', intensity: 0.62 },
    },
    ambience: 'cafe',
    snacks: ['croissant', 'milkbread', 'cocoa', 'strawberry', 'macaron', 'meatball'],
    floor: { w: 14.6, d: 12.1 },
    floorCenter: { x: 2.2, z: 2.95 },
    shell: { kind: 'walls', minX: -6.0, maxX: NEAR_X, minZ: -4.0, maxZ: NEAR_Z, ceiling: WALL_H, rimHeight: 0, groundHalf: 0 },
  },

  /**
   * The multiplayer arena. Listed here so it gets the same lighting, shell and camera machinery
   * as everywhere else, but kept out of ENVIRONMENT_ORDER: it is not somewhere you can choose to
   * sit alone, it is where the party happens. Its geometry is built from the party size rather
   * than from these numbers — see scene/environments/arena.ts.
   */
  arena: {
    id: 'arena',
    label: 'MOONLIT CLEARING',
    blurb: 'an island, a fire, and everyone who showed up',
    icon: '🔥',
    price: 0,
    sky: {
      dawn: '#1D1740',
      morning: '#1D1740',
      afternoon: '#1D1740',
      golden: '#1D1740',
      dusk: '#1D1740',
      night: '#1D1740',
    },
    key: {
      dawn: { color: '#9AA6E8', intensity: 0.75 },
      morning: { color: '#9AA6E8', intensity: 0.75 },
      afternoon: { color: '#9AA6E8', intensity: 0.75 },
      golden: { color: '#9AA6E8', intensity: 0.75 },
      dusk: { color: '#9AA6E8', intensity: 0.75 },
      night: { color: '#9AA6E8', intensity: 0.75 },
    },
    ambient: {
      dawn: { color: '#4E4788', intensity: 0.66 },
      morning: { color: '#4E4788', intensity: 0.66 },
      afternoon: { color: '#4E4788', intensity: 0.66 },
      golden: { color: '#4E4788', intensity: 0.66 },
      dusk: { color: '#4E4788', intensity: 0.66 },
      night: { color: '#4E4788', intensity: 0.66 },
    },
    ambience: 'fire',
    snacks: ['marshmallow', 'sardine', 'onigiri', 'cocoa', 'sweetpotato'],
    // The play area is generous: cats mill around the ring rather than staying on a rug.
    floor: { w: 16, d: 16 },
    shell: { kind: 'open', minX: -34, maxX: 34, minZ: -34, maxZ: 34, ceiling: OPEN_SKY, rimHeight: 3.4, groundHalf: 60 },
  },
};

/** The four worlds the solo scene switcher offers. The arena is reached through party mode. */
export const ENVIRONMENT_ORDER: readonly SoloEnvironmentId[] = ['room', 'picnic', 'bonfire', 'cafe'];

export function isSoloEnvironmentId(value: unknown): value is SoloEnvironmentId {
  return typeof value === 'string' && (ENVIRONMENT_ORDER as readonly string[]).includes(value);
}

export function isEnvironmentId(value: unknown): value is EnvironmentId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENVIRONMENTS, value);
}
