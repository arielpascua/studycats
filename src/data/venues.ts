/**
 * PARTY VENUES — the places the arena can be.
 *
 * The multiplayer scene is one builder, not five. Everything structural is shared and driven by
 * the party size: a disc of floor, a ring of seats, posts between them, a centrepiece that grows
 * as the party banks focus, and a surround far enough out to hide the horizon. A venue only
 * supplies *values* — colours, heights, counts, light, and which of four centrepiece shapes it
 * uses. That is why adding a venue is a data edit and why every venue expands with the party
 * instead of only the clearing doing it.
 *
 * The three lighting fields (`sky`, `key`, `ambient`) are single colours here and are expanded
 * to the six day phases by `arenaDefFor`. Party venues are deliberately phase-independent: the
 * clearing is always night, the library is always lamplit. You went somewhere; the time of day
 * you left behind is not the point.
 */

import { ENVIRONMENTS, type EnvironmentDef } from './environments';

export type VenueId = 'clearing' | 'library' | 'cafe' | 'school' | 'museum';

/** How the growing centrepiece is drawn. Each kind reads the same 0..5 stage. */
export type HearthKind = 'fire' | 'lamp' | 'steam' | 'crystal';

export interface SurroundSpec {
  /** Distance from the middle. Fixed, not party-scaled: it is the horizon, not the furniture. */
  radius: number;
  count: number;
  width: number;
  minHeight: number;
  /** Extra height distributed across the ring, 0 for a flat wall. */
  varyHeight: number;
  /** Radial scatter, 0 for a wall that is actually straight. */
  jitter: number;
  color: string;
  /**
   * Horizontal rows up the face: shelves of books, lit windows, museum friezes.
   *
   * `colors` cycles per segment rather than painting one flat ribbon — a single colour read as
   * a stripe of paint wrapped round the room, which is not what a wall of books looks like.
   * A one-entry list is still available for things that really are continuous, like a frieze.
   */
  bands?: Array<{ colors: string[]; y: number; height: number }>;
  /**
   * A solid wall just behind the surround.
   *
   * Only needed when the surround has gaps you can see the sky through — a colonnade leaked
   * 29% of the frame's top edge to bare background, which is the exact failure the whole
   * enclosure model exists to prevent. Costs one draw call.
   */
  backdrop?: { color: string; height: number };
}

export interface VenueTheme {
  /** The floor disc alternates these two colours ring by ring. */
  floorA: string;
  floorB: string;
  /** The edge trim so the floor does not end on a hard line. */
  lip: string;
  /** Everything beyond the disc — water, carpet, rooftop asphalt. */
  beyond: string;
  /** A soft ring just off the disc's edge. Null skips it. */
  wash: string | null;
  seatA: string;
  seatB: string;
  post: string;
  glow: string;
  /** How tall the posts between seats stand. */
  postHeight: number;
  surround: SurroundSpec;
  /** A big unlit disc in the distance: moon, hanging lamp, skylight. Null for none. */
  orb: { color: string; halo: string; size: number; position: [number, number, number] } | null;
  /** Flat ceiling plane for interiors. Null leaves the sky open. */
  ceiling: { color: string; y: number } | null;
  key: { color: string; intensity: number; position: [number, number, number] };
  hearth: {
    kind: HearthKind;
    /** Pit stones / table / plinth under the growing part. */
    base: string;
    baseAccent: string;
    /** Five colours, bottom tier first. */
    tiers: [string, string, string, string, string];
    light: string;
    /** Point-light reach at stage 0, before the party grows it. */
    reach: number;
  };
}

export interface VenueDef {
  id: VenueId;
  label: string;
  blurb: string;
  icon: string;
  /** Fish coins to unlock. The clearing is free — party mode always has somewhere to go. */
  price: number;
  /** What the shared centrepiece is called, in toasts and the party panel. */
  hearthName: string;
  ambience: EnvironmentDef['ambience'];
  snacks: readonly string[];
  sky: string;
  ambient: { color: string; intensity: number };
  theme: VenueTheme;
}

export const VENUES: Record<VenueId, VenueDef> = {
  /* ------------------------------------------------------------------ clearing */
  clearing: {
    id: 'clearing',
    label: 'MOONLIT CLEARING',
    blurb: 'an island, a fire, and everyone who showed up',
    icon: '🔥',
    price: 0,
    hearthName: 'bonfire',
    ambience: 'fire',
    snacks: ['marshmallow', 'sardine', 'onigiri', 'cocoa', 'sweetpotato', 'yakitori', 'friedchicken'],
    sky: '#1D1740',
    ambient: { color: '#4E4788', intensity: 0.66 },
    theme: {
      floorA: '#4A3F63',
      floorB: '#5E5180',
      lip: '#3E5A54',
      beyond: '#0F0B22',
      wash: '#2A2340',
      seatA: '#C97A98',
      seatB: '#E9A7BE',
      post: '#4A3B33',
      glow: '#F5E1A4',
      postHeight: 1.5,
      surround: {
        radius: 46,
        count: 96,
        width: 1.5,
        minHeight: 2.4,
        varyHeight: 4.4,
        jitter: 1.4,
        color: '#1B1636',
      },
      orb: { color: '#F6F1E2', halo: '#8E86C4', size: 6.2, position: [-15, 7.2, -31] },
      ceiling: null,
      key: { color: '#9AA6E8', intensity: 0.95, position: [-16, 18, -22] },
      hearth: {
        kind: 'fire',
        base: '#5E5180',
        baseAccent: '#4A3B33',
        tiers: ['#F08A5D', '#FFB067', '#F5E1A4', '#FFB067', '#F5E1A4'],
        light: '#F08A5D',
        reach: 9,
      },
    },
  },

  /* ------------------------------------------------------------------- library */
  library: {
    id: 'library',
    label: 'NIGHT LIBRARY',
    blurb: 'green lamps, high shelves, nobody talking above a whisper',
    icon: '📚',
    price: 220,
    hearthName: 'reading lamp',
    ambience: 'room',
    snacks: ['cocoa', 'milkbread', 'croissant', 'macaron', 'sandwich'],
    sky: '#241B2E',
    ambient: { color: '#6B5A72', intensity: 0.7 },
    theme: {
      floorA: '#553A32',
      floorB: '#6A4A3D',
      lip: '#3E2C28',
      beyond: '#2A2028',
      wash: '#7A4E52',
      seatA: '#7C4A55',
      seatB: '#A76B72',
      post: '#3E2C28',
      glow: '#8FD9A8',
      postHeight: 2.1,
      surround: {
        // A ring of shelving. Close spacing and zero jitter is what turns the same primitive
        // that draws a treeline into a wall.
        radius: 20,
        count: 150,
        width: 0.95,
        minHeight: 15.5,
        varyHeight: 0,
        jitter: 0,
        color: '#4A332C',
        bands: (() => {
          const books = ['#C4707E', '#E0BE8C', '#7FA9C4', '#8FA97F', '#B08AC0', '#D9A26B', '#6E8FA8'];
          return [1.35, 2.5, 3.65, 4.8, 5.95, 7.1].map((y, i) => ({
            // Rotating the cycle per shelf stops the rows lining up into vertical columns.
            colors: [...books.slice(i % books.length), ...books.slice(0, i % books.length)],
            y,
            height: 0.5,
          }));
        })(),
      },
      orb: null,
      ceiling: { color: '#1B1420', y: 15 },
      key: { color: '#F2D9A8', intensity: 0.82, position: [-12, 16, -14] },
      hearth: {
        kind: 'lamp',
        base: '#4A332C',
        baseAccent: '#8A6B4F',
        tiers: ['#2E7D5B', '#3F9A71', '#8FD9A8', '#CFF3DD', '#F6FFF9'],
        light: '#9BE8BC',
        reach: 10,
      },
    },
  },

  /* ---------------------------------------------------------------------- café */
  cafe: {
    id: 'cafe',
    label: 'LATE CAFÉ',
    blurb: 'the good table, the last hour before close',
    icon: '☕',
    price: 260,
    hearthName: 'espresso bar',
    ambience: 'cafe',
    snacks: ['croissant', 'macaron', 'cocoa', 'melonpan', 'lemonade', 'meatball', 'milkbread'],
    sky: '#2E2233',
    ambient: { color: '#7C6270', intensity: 0.74 },
    theme: {
      floorA: '#6B4433',
      floorB: '#835440',
      lip: '#4A2F26',
      beyond: '#3A2A32',
      wash: '#93624A',
      seatA: '#9C5B4A',
      seatB: '#C98164',
      post: '#4A2F26',
      glow: '#FFC98A',
      postHeight: 2.3,
      surround: {
        radius: 18,
        count: 128,
        width: 1.0,
        minHeight: 14.5,
        varyHeight: 0,
        jitter: 0,
        color: '#4E3446',
        bands: [
          // Windows at eye height: lit, lit, dark, so it reads as panes with mullions between
          // them rather than one long strip of light.
          { colors: ['#FFD9A0', '#FFE8BE', '#3A2733'], y: 2.6, height: 1.5 },
          { colors: ['#3A2733'], y: 4.6, height: 0.4 },
          { colors: ['#5C4054', '#6B4A62'], y: 6.2, height: 1.1 },
        ],
      },
      orb: null,
      ceiling: { color: '#241A22', y: 14 },
      key: { color: '#FFD2A0', intensity: 0.86, position: [-13, 15, -13] },
      hearth: {
        kind: 'steam',
        base: '#4A2F26',
        baseAccent: '#C0C8D2',
        tiers: ['#E8DCCB', '#F2E7D8', '#FBF6EE', '#FDFBF6', '#FFFFFF'],
        light: '#FFC98A',
        reach: 9.5,
      },
    },
  },

  /* -------------------------------------------------------------------- school */
  school: {
    id: 'school',
    label: 'ROOFTOP CLASS',
    blurb: 'above the city, after the last bell',
    icon: '🏫',
    price: 300,
    hearthName: 'rooftop lantern',
    ambience: 'birds',
    snacks: ['onigiri', 'sandwich', 'melonpan', 'lemonade', 'strawberry', 'friedchicken', 'meatball'],
    sky: '#3B3260',
    ambient: { color: '#6E6BA4', intensity: 0.72 },
    theme: {
      floorA: '#54607A',
      floorB: '#647089',
      lip: '#3C4557',
      beyond: '#2C3247',
      wash: '#7A86A4',
      seatA: '#4E7FA8',
      seatB: '#79A9CC',
      post: '#8A93A8',
      glow: '#FFE9A8',
      postHeight: 1.9,
      surround: {
        // A city skyline: tall, wildly uneven, and far enough out to read as distance.
        radius: 34,
        count: 82,
        width: 3.0,
        minHeight: 5.0,
        varyHeight: 13.0,
        jitter: 3.2,
        color: '#232A44',
        bands: [
          // Office lights across the skyline: most windows are dark at this hour.
          { colors: ['#F2D98A', '#2B3050', '#2B3050', '#FFE9A8', '#2B3050'], y: 4.2, height: 0.35 },
          { colors: ['#2B3050', '#F2D98A', '#2B3050', '#2B3050', '#FFD98A'], y: 7.4, height: 0.35 },
          { colors: ['#2B3050', '#2B3050', '#F2D98A', '#2B3050', '#2B3050'], y: 10.6, height: 0.35 },
        ],
      },
      orb: { color: '#FFE6C0', halo: '#8E86C4', size: 4.4, position: [-17, 9.5, -30] },
      ceiling: null,
      key: { color: '#B9C4F0', intensity: 0.9, position: [-15, 17, -19] },
      hearth: {
        kind: 'lamp',
        base: '#3C4557',
        baseAccent: '#8A93A8',
        tiers: ['#E8A34A', '#F2BC6A', '#FFE9A8', '#FFF4D2', '#FFFCEE'],
        light: '#FFD98A',
        reach: 9,
      },
    },
  },

  /* -------------------------------------------------------------------- museum */
  museum: {
    id: 'museum',
    label: 'QUIET MUSEUM',
    blurb: 'marble, one lit case, and the whole wing to yourselves',
    icon: '🏛️',
    price: 340,
    hearthName: 'exhibit',
    ambience: 'room',
    snacks: ['macaron', 'cocoa', 'strawberry', 'croissant', 'milkbread', 'steak'],
    sky: '#1A1E30',
    ambient: { color: '#5C6488', intensity: 0.68 },
    theme: {
      floorA: '#B9B2C6',
      floorB: '#CFC8D8',
      lip: '#8E86A0',
      beyond: '#2A2C42',
      wash: '#7E86B4',
      seatA: '#5A6096',
      seatB: '#868CC0',
      post: '#DCD6E4',
      glow: '#CFE4FF',
      postHeight: 3.4,
      surround: {
        // Columns: wide, tall, and widely spaced, so you see gaps of dark between them.
        radius: 19,
        count: 26,
        width: 2.0,
        minHeight: 18.5,
        varyHeight: 0,
        jitter: 0,
        color: '#D6D0E0',
        bands: [
          // Column base and capital: genuinely continuous, so a single colour is correct here.
          { colors: ['#9E96B4'], y: 0.6, height: 0.7 },
          { colors: ['#9E96B4'], y: 14.4, height: 0.8 },
        ],
        // The gallery wall the columns stand in front of.
        backdrop: { color: '#3A3C5C', height: 18.5 },
      },
      orb: null,
      ceiling: { color: '#171A2A', y: 18 },
      key: { color: '#CBD6FF', intensity: 0.88, position: [-14, 20, -16] },
      hearth: {
        kind: 'crystal',
        base: '#8E86A0',
        baseAccent: '#DCD6E4',
        tiers: ['#5FC7E8', '#7FD9F2', '#A8E9FA', '#D2F5FF', '#F2FDFF'],
        light: '#8FDDF5',
        reach: 10.5,
      },
    },
  },
};

export const VENUE_ORDER: readonly VenueId[] = ['clearing', 'library', 'cafe', 'school', 'museum'];

/** Party mode always has somewhere free to go. */
export const DEFAULT_VENUE: VenueId = 'clearing';

export function isVenueId(value: unknown): value is VenueId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VENUES, value);
}

export function venueDef(id: VenueId | string): VenueDef {
  return isVenueId(id) ? VENUES[id] : VENUES[DEFAULT_VENUE];
}

/**
 * The arena's `EnvironmentDef`, themed by venue.
 *
 * The shell, floor plan and camera machinery are the arena's and never change — only the light
 * and the labels do. Building the def this way means every existing code path that reads
 * `env.def` (day/night, ambience, the snack pool, the panel title) becomes venue-aware without
 * knowing venues exist.
 */
export function arenaDefFor(id: VenueId | string): EnvironmentDef {
  const venue = venueDef(id);
  const base = ENVIRONMENTS.arena;
  const key = { color: venue.theme.key.color, intensity: venue.theme.key.intensity };
  const everyPhase = <T,>(value: T): Record<keyof EnvironmentDef['sky'], T> => ({
    dawn: value,
    morning: value,
    afternoon: value,
    golden: value,
    dusk: value,
    night: value,
  });

  // An interior venue has a real lid over it, and the camera rig must be told: `shell.ceiling`
  // is the eye's vertical limit, and with it left at OPEN_SKY the rig happily climbed above the
  // ceiling during break framing and rendered the room from the roof — a black screen.
  const ceiling = venue.theme.ceiling ? venue.theme.ceiling.y - 1.2 : base.shell.ceiling;

  return {
    ...base,
    shell: { ...base.shell, ceiling },
    label: venue.label,
    blurb: venue.blurb,
    icon: venue.icon,
    ambience: venue.ambience,
    snacks: [...venue.snacks],
    sky: everyPhase(venue.sky),
    key: everyPhase(key),
    ambient: everyPhase(venue.ambient),
  };
}
