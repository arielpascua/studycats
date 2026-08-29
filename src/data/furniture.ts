/**
 * Slot-based room customization (spec §8.5). Placement is slot-based, never freeform — it
 * avoids the jank of a freehand drag and it means a saved room always reconstructs exactly.
 */

import type { EnvironmentId } from './environments';

export type SlotId =
  | 'floor-a'
  | 'floor-b'
  | 'floor-c'
  | 'wall-a'
  | 'wall-b'
  | 'corner'
  | 'desk'
  | 'window';

export type FurnitureKind = 'rug' | 'art' | 'tower' | 'lights' | 'mug' | 'window' | 'plant' | 'cushion';

export interface FurnitureDef {
  id: string;
  name: string;
  kind: FurnitureKind;
  blurb: string;
  price: number;
  /** Which slots this item is legal in. */
  slots: readonly SlotId[];
  /** Restrict to certain worlds; empty = everywhere. */
  environments?: readonly EnvironmentId[];
  colorA: string;
  colorB: string;
  /** Cat towers and cushions add a surface cats can be dropped onto. */
  perch?: { height: number; radius: number };
}

export const FURNITURE: Record<string, FurnitureDef> = {
  'rug-clover': {
    id: 'rug-clover', name: 'Clover rug', kind: 'rug', blurb: 'soft enough to sleep on. they will.',
    price: 60, slots: ['floor-a'], colorA: '#E2B7C8', colorB: '#C7BFEA',
  },
  'rug-checker': {
    id: 'rug-checker', name: 'Checker rug', kind: 'rug', blurb: 'a grid to sit exactly off-centre of.',
    price: 90, slots: ['floor-a'], colorA: '#F6C99F', colorB: '#FBF2F4',
  },
  'art-moon': {
    id: 'art-moon', name: 'Moon print', kind: 'art', blurb: 'a small moon, badly hung.',
    price: 80, slots: ['wall-a', 'wall-b'], colorA: '#3B2A44', colorB: '#F5E1A4',
  },
  'art-fish': {
    id: 'art-fish', name: 'Fish poster', kind: 'art', blurb: 'aspirational.',
    price: 80, slots: ['wall-a', 'wall-b'], colorA: '#A9D6C0', colorB: '#3B2A44',
  },
  'tower-basic': {
    id: 'tower-basic', name: 'Cat tower', kind: 'tower', blurb: 'a new place to be dropped onto.',
    price: 220, slots: ['corner'], colorA: '#C89B72', colorB: '#E2B7C8',
    perch: { height: 1.9, radius: 0.55 },
  },
  'cushion-round': {
    id: 'cushion-round', name: 'Round cushion', kind: 'cushion', blurb: 'claimed within the hour.',
    price: 70, slots: ['floor-b', 'floor-c'], colorA: '#F0B7C9', colorB: '#D98BA6',
    perch: { height: 0.22, radius: 0.5 },
  },
  'lights-warm': {
    id: 'lights-warm', name: 'Warm fairy lights', kind: 'lights', blurb: 'the good kind of orange.',
    price: 110, slots: ['wall-a'], colorA: '#F5E1A4', colorB: '#F2B441',
  },
  'lights-cool': {
    id: 'lights-cool', name: 'Cool fairy lights', kind: 'lights', blurb: 'for late, quiet weeks.',
    price: 110, slots: ['wall-a'], colorA: '#A9D6C0', colorB: '#C7BFEA',
  },
  'mug-cat': {
    id: 'mug-cat', name: 'Cat mug', kind: 'mug', blurb: 'gets knocked over. rights itself.',
    price: 40, slots: ['desk'], colorA: '#FBF2F4', colorB: '#F0B7C9',
  },
  'mug-stripe': {
    id: 'mug-stripe', name: 'Striped mug', kind: 'mug', blurb: 'holds slightly more.',
    price: 40, slots: ['desk'], colorA: '#C7BFEA', colorB: '#3B2A44',
  },
  'plant-fern': {
    id: 'plant-fern', name: 'Fern', kind: 'plant', blurb: 'chewed, but surviving.',
    price: 55, slots: ['floor-b', 'floor-c', 'corner'], colorA: '#8FBF8A', colorB: '#C89B72',
  },
  'plant-cactus': {
    id: 'plant-cactus', name: 'Cactus', kind: 'plant', blurb: 'a boundary the cats respect.',
    price: 65, slots: ['floor-b', 'floor-c', 'desk'], colorA: '#A9C293', colorB: '#E2B7C8',
  },
  'window-city': {
    id: 'window-city', name: 'City view', kind: 'window', blurb: 'someone else is also awake.',
    price: 140, slots: ['window'], environments: ['room', 'cafe'], colorA: '#7C6BB0', colorB: '#F5E1A4',
  },
  'window-hills': {
    id: 'window-hills', name: 'Hills view', kind: 'window', blurb: 'green, distant, undemanding.',
    price: 140, slots: ['window'], environments: ['room', 'cafe'], colorA: '#A8CE93', colorB: '#CDE4F0',
  },
};

export const FURNITURE_ORDER: readonly string[] = Object.keys(FURNITURE);

export const SLOTS: readonly SlotId[] = ['floor-a', 'floor-b', 'floor-c', 'wall-a', 'wall-b', 'corner', 'desk', 'window'];

export const SLOT_LABEL: Record<SlotId, string> = {
  'floor-a': 'RUG SPOT',
  'floor-b': 'FLOOR LEFT',
  'floor-c': 'FLOOR RIGHT',
  'wall-a': 'WALL LEFT',
  'wall-b': 'WALL RIGHT',
  corner: 'CORNER',
  desk: 'DESK',
  window: 'WINDOW',
};

export function isFurnitureId(value: unknown): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FURNITURE, value);
}

export function fitsSlot(id: string, slot: SlotId): boolean {
  const def = FURNITURE[id];
  return !!def && def.slots.includes(slot);
}

export function allowedIn(id: string, env: EnvironmentId): boolean {
  const def = FURNITURE[id];
  if (!def) return false;
  return !def.environments || def.environments.includes(env);
}
