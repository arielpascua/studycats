/**
 * The single source of colour truth. DESIGN.md §3 defines these; the CSS custom properties in
 * `src/style.css` mirror them, and the 3D scene reads them from here so the diorama and the
 * paper HUD can never drift apart.
 */

export const PALETTE = {
  paper: '#FBF2F4',
  paper2: '#F3E6EC',
  ink: '#3B2A44',
  inkSoft: '#6F5A78',
  inkFaint: '#9C88A4',

  lav: '#C7BFEA',
  lavDeep: '#9C8FD4',
  lavDusk: '#7C6BB0',
  pink: '#F0B7C9',
  pinkDeep: '#D98BA6',
  peach: '#F6C99F',
  mint: '#A9D6C0',
  butter: '#F5E1A4',
  coin: '#F2B441',
  danger: '#C96A72',

  // Scene-only tones
  wood: '#C89B72',
  woodDark: '#9C7350',
  rug: '#E2B7C8',
  leaf: '#8FBF8A',
  leafDark: '#6E9C6C',
  grass: '#A8CE93',
  soil: '#8A6A55',
  stone: '#B7ADBE',
  ember: '#F58A4B',
  emberHot: '#FFD08A',
  night: '#2A2340',
  cream: '#FBF2F4',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** `#RRGGBB` → 0xRRGGBB, for Three.js material colors. */
export function hex(color: string): number {
  return parseInt(color.replace('#', ''), 16);
}

export const C = {
  paper: hex(PALETTE.paper),
  ink: hex(PALETTE.ink),
  lav: hex(PALETTE.lav),
  lavDeep: hex(PALETTE.lavDeep),
  pink: hex(PALETTE.pink),
  peach: hex(PALETTE.peach),
  mint: hex(PALETTE.mint),
  butter: hex(PALETTE.butter),
  coin: hex(PALETTE.coin),
  wood: hex(PALETTE.wood),
  woodDark: hex(PALETTE.woodDark),
  rug: hex(PALETTE.rug),
  leaf: hex(PALETTE.leaf),
  grass: hex(PALETTE.grass),
  stone: hex(PALETTE.stone),
  ember: hex(PALETTE.ember),
  night: hex(PALETTE.night),
} as const;

/** Linear blend between two `#RRGGBB` strings. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseInt(a.slice(1), 16);
  const cb = parseInt(b.slice(1), 16);
  const k = Math.min(1, Math.max(0, t));
  const r = Math.round(((ca >> 16) & 255) * (1 - k) + ((cb >> 16) & 255) * k);
  const g = Math.round(((ca >> 8) & 255) * (1 - k) + ((cb >> 8) & 255) * k);
  const bl = Math.round((ca & 255) * (1 - k) + (cb & 255) * k);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
