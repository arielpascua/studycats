/**
 * The wardrobe.
 *
 * Cosmetics exist for one reason: multiplayer is a showcase, and a showcase needs something to
 * show. Every item is voxel-buildable from the same box vocabulary as the cats themselves, so a
 * dressed cat still reads as part of the world rather than as a sticker applied to it.
 *
 * Four slots, each mounted on a different joint, so nothing can ever overlap:
 *   hat      → the head pivot (rides the head bob and the ear twitch)
 *   collar   → the neck, between head and body
 *   cape     → the body (swings with the walk)
 *   charm    → a floating flourish above the cat, for the rare ones
 *
 * Prices are deliberately low relative to a cat (60-460). Dressing up should be the thing you
 * do with spare coins, not a second economy that competes with adopting.
 */

export type CosmeticSlot = 'hat' | 'collar' | 'cape' | 'charm';

export interface CosmeticDef {
  id: string;
  name: string;
  slot: CosmeticSlot;
  /** One line for the wardrobe list. Same warm, observational voice as the breeds. */
  blurb: string;
  price: number;
  colorA: string;
  colorB: string;
  /** How the factory assembles it. */
  shape:
    | 'beanie'
    | 'party'
    | 'crown'
    | 'flowers'
    | 'headphones'
    | 'chef'
    | 'bell'
    | 'bow'
    | 'bandana'
    | 'scarf'
    | 'cape'
    | 'wings'
    | 'backpack'
    | 'blanket'
    | 'sparkle'
    | 'halo'
    | 'balloon';
  /** Charms may animate; the animator reads this. */
  animated?: boolean;
}

export const COSMETICS: Record<string, CosmeticDef> = {
  /* ------------------------------------------------------------------ hats */
  'hat-beanie': {
    id: 'hat-beanie', name: 'Beanie', slot: 'hat', shape: 'beanie',
    blurb: 'pulled down over the ears, mostly.',
    price: 60, colorA: '#D98BA6', colorB: '#FBF2F4',
  },
  'hat-party': {
    id: 'hat-party', name: 'Party hat', slot: 'hat', shape: 'party',
    blurb: 'strictly for occasions. every day is one.',
    price: 70, colorA: '#F5E1A4', colorB: '#F0B7C9',
  },
  'hat-crown': {
    id: 'hat-crown', name: 'Little crown', slot: 'hat', shape: 'crown',
    blurb: 'unelected, unopposed.',
    price: 220, colorA: '#F2B441', colorB: '#FBF2F4',
  },
  'hat-flowers': {
    id: 'hat-flowers', name: 'Flower crown', slot: 'hat', shape: 'flowers',
    blurb: 'picked on the hill, worn ever since.',
    price: 130, colorA: '#F0B7C9', colorB: '#A9C293',
  },
  'hat-headphones': {
    id: 'hat-headphones', name: 'Headphones', slot: 'hat', shape: 'headphones',
    blurb: 'the same four songs, forever.',
    price: 160, colorA: '#7C6BB0', colorB: '#3B2A44',
  },
  'hat-chef': {
    id: 'hat-chef', name: 'Chef hat', slot: 'hat', shape: 'chef',
    blurb: 'has never cooked. owns the hat.',
    price: 140, colorA: '#FDF8F8', colorB: '#EFE3E8',
  },

  /* --------------------------------------------------------------- collars */
  'collar-bell': {
    id: 'collar-bell', name: 'Bell collar', slot: 'collar', shape: 'bell',
    blurb: 'you always know. that is the point.',
    price: 60, colorA: '#C96A72', colorB: '#F2B441',
  },
  'collar-bow': {
    id: 'collar-bow', name: 'Bow tie', slot: 'collar', shape: 'bow',
    blurb: 'formal from the neck up.',
    price: 90, colorA: '#3B2A44', colorB: '#D98BA6',
  },
  'collar-bandana': {
    id: 'collar-bandana', name: 'Bandana', slot: 'collar', shape: 'bandana',
    blurb: 'off to do something practical, apparently.',
    price: 80, colorA: '#A9D6C0', colorB: '#6F5A78',
  },
  'collar-scarf': {
    id: 'collar-scarf', name: 'Long scarf', slot: 'collar', shape: 'scarf',
    blurb: 'trails behind. catches on everything.',
    price: 150, colorA: '#C7BFEA', colorB: '#F6C99F',
  },

  /* ----------------------------------------------------------------- capes */
  'cape-classic': {
    id: 'cape-classic', name: 'Cape', slot: 'cape', shape: 'cape',
    blurb: 'billows even indoors. especially indoors.',
    price: 180, colorA: '#7C6BB0', colorB: '#F5E1A4',
  },
  'cape-wings': {
    id: 'cape-wings', name: 'Paper wings', slot: 'cape', shape: 'wings',
    blurb: 'not aerodynamic. deeply committed.',
    price: 320, colorA: '#FBF2F4', colorB: '#C7BFEA',
  },
  'cape-backpack': {
    id: 'cape-backpack', name: 'Tiny backpack', slot: 'cape', shape: 'backpack',
    blurb: 'contains one leaf and a small rock.',
    price: 140, colorA: '#C89B72', colorB: '#8FBF8A',
  },
  'cape-blanket': {
    id: 'cape-blanket', name: 'Blanket', slot: 'cape', shape: 'blanket',
    blurb: 'refuses to be separated from it.',
    price: 110, colorA: '#E2B7C8', colorB: '#FBF2F4',
  },

  /* ---------------------------------------------------------------- charms */
  'charm-sparkle': {
    id: 'charm-sparkle', name: 'Sparkles', slot: 'charm', shape: 'sparkle',
    blurb: 'follows them around. nobody asks why.',
    price: 260, colorA: '#F5E1A4', colorB: '#FBF2F4', animated: true,
  },
  'charm-halo': {
    id: 'charm-halo', name: 'Halo', slot: 'charm', shape: 'halo',
    blurb: 'unearned, worn sincerely.',
    price: 380, colorA: '#F2B441', colorB: '#F5E1A4', animated: true,
  },
  'charm-balloon': {
    id: 'charm-balloon', name: 'Balloon', slot: 'charm', shape: 'balloon',
    blurb: 'tied on at the picnic. never let go.',
    price: 200, colorA: '#F0B7C9', colorB: '#3B2A44', animated: true,
  },
};

export const COSMETIC_ORDER: readonly string[] = Object.keys(COSMETICS);

export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ['hat', 'collar', 'cape', 'charm'];

export const SLOT_LABEL: Record<CosmeticSlot, string> = {
  hat: 'HAT',
  collar: 'COLLAR',
  cape: 'BACK',
  charm: 'CHARM',
};

/** What a cat is wearing. Every slot optional — an undressed cat is a valid cat. */
export type Outfit = Partial<Record<CosmeticSlot, string>>;

export function isCosmeticId(value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COSMETICS, value);
}

export function cosmeticsInSlot(slot: CosmeticSlot): CosmeticDef[] {
  return COSMETIC_ORDER.map((id) => COSMETICS[id]).filter((c) => c.slot === slot);
}

/**
 * Drop anything unknown and anything in the wrong slot. A hand-edited save must never be able
 * to put a cape on a cat's head.
 */
export function sanitizeOutfit(input: unknown): Outfit {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const outfit: Outfit = {};
  for (const slot of COSMETIC_SLOTS) {
    const id = raw[slot];
    if (isCosmeticId(id) && COSMETICS[id].slot === slot) outfit[slot] = id;
  }
  return outfit;
}

/** How many slots are filled — drives the "best dressed" flourish in the arena. */
export function outfitSize(outfit: Outfit): number {
  return COSMETIC_SLOTS.reduce((n, slot) => n + (outfit[slot] ? 1 : 0), 0);
}

export function outfitPrice(outfit: Outfit): number {
  return COSMETIC_SLOTS.reduce((sum, slot) => {
    const id = outfit[slot];
    return sum + (id && COSMETICS[id] ? COSMETICS[id].price : 0);
  }, 0);
}
