/**
 * Snack pool for break time. Every snack is two bites (spec reference notes) and is claimed by
 * exactly one cat. Bowls are separate: infinite, max two cats each.
 */

export interface SnackDef {
  id: string;
  name: string;
  /** Emoji used in the cat-alogue / toasts only — the 3D model is built from `shape`. */
  icon: string;
  /** How catFactory-adjacent prop code assembles it. */
  shape: 'rice' | 'round' | 'puff' | 'fish' | 'crescent' | 'berry' | 'cup' | 'disc' | 'stick';
  colorA: string;
  colorB: string;
  /** Coin price to add it to the rotation. Starter snacks cost nothing. */
  price: number;
  /** Bigger snacks sit lower and bounce less. */
  scale: number;
}

export const SNACKS: Record<string, SnackDef> = {
  onigiri: { id: 'onigiri', name: 'Onigiri', icon: '🍙', shape: 'rice', colorA: '#FBF6EE', colorB: '#4A5B4A', price: 0, scale: 1.3 },
  sardine: { id: 'sardine', name: 'Sardine', icon: '🐟', shape: 'fish', colorA: '#BFCBD8', colorB: '#8A99AC', price: 0, scale: 1.23 },
  milkbread: { id: 'milkbread', name: 'Milk bread', icon: '🍞', shape: 'round', colorA: '#F4DEB8', colorB: '#E0BE8C', price: 0, scale: 1.37 },
  marshmallow: { id: 'marshmallow', name: 'Marshmallow', icon: '🍡', shape: 'puff', colorA: '#FDF4F6', colorB: '#F2C4D2', price: 40, scale: 1.1 },
  melonpan: { id: 'melonpan', name: 'Melon pan', icon: '🍈', shape: 'round', colorA: '#DDE9BE', colorB: '#B9CE94', price: 55, scale: 1.37 },
  strawberry: { id: 'strawberry', name: 'Strawberry', icon: '🍓', shape: 'berry', colorA: '#E8788E', colorB: '#8FBF8A', price: 45, scale: 1.04 },
  croissant: { id: 'croissant', name: 'Croissant', icon: '🥐', shape: 'crescent', colorA: '#E9C089', colorB: '#C99A5E', price: 70, scale: 1.3 },
  sandwich: { id: 'sandwich', name: 'Sandwich', icon: '🥪', shape: 'disc', colorA: '#F2DFB8', colorB: '#A9C293', price: 60, scale: 1.37 },
  macaron: { id: 'macaron', name: 'Macaron', icon: '🍬', shape: 'disc', colorA: '#F0B7C9', colorB: '#FBF2F4', price: 85, scale: 0.975 },
  cocoa: { id: 'cocoa', name: 'Cocoa', icon: '☕', shape: 'cup', colorA: '#FBF2F4', colorB: '#7A5138', price: 75, scale: 1.17 },
  lemonade: { id: 'lemonade', name: 'Lemonade', icon: '🥤', shape: 'cup', colorA: '#FBF2F4', colorB: '#F5E1A4', price: 65, scale: 1.17 },
  sweetpotato: { id: 'sweetpotato', name: 'Sweet potato', icon: '🍠', shape: 'stick', colorA: '#C98BA6', colorB: '#F6C99F', price: 90, scale: 1.3 },
};

export const SNACK_ORDER: readonly string[] = Object.keys(SNACKS);

/** Free from the start — everything else is bought in the shop. */
export const DEFAULT_SNACKS: readonly string[] = ['onigiri', 'sardine', 'milkbread'];

export const BITES_PER_SNACK = 2;
export const MAX_CATS_PER_BOWL = 2;

export function isSnackId(value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SNACKS, value);
}
