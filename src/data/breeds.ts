/**
 * The 8 starter breeds plus 4 unlockable rares (spec §6.1). Colours are the poster palette:
 * cream bodies, pink patches, nothing saturated enough to fight the room.
 */

export type BreedId =
  | 'strawberry'
  | 'snow'
  | 'calico'
  | 'latte'
  | 'peach'
  | 'mist'
  | 'shadow'
  | 'matcha'
  | 'void'
  | 'boba'
  | 'sakura'
  | 'robo';

export type PatchStyle = 'patch' | 'spots' | 'tabby' | 'tuxedo' | 'petals' | 'none';

export interface BreedDef {
  id: BreedId;
  name: string;
  /** One line for the cat-alogue. Voice: warm, observational, never twee. */
  blurb: string;
  body: string;
  patch: string;
  ear: string;
  tail: string;
  eye: string;
  /** How the secondary colour is distributed over the body. */
  style: PatchStyle;
  rare: boolean;
  /** Coin price to adopt. Starter cats are cheap; rares are a real goal. */
  price: number;
  /** Personality dials, 0..1 — shift the brain's behaviour weights. */
  temperament: { energy: number; sleepy: number; social: number };
  /** Extra flourish handled by the factory. */
  quirk?: 'glow-eyes' | 'antenna' | 'petal-trail' | 'metallic';
  /** Non-purchasable rares state how they arrive instead of showing a price. */
  unlockHint?: string;
}

export const BREEDS: Record<BreedId, BreedDef> = {
  strawberry: {
    id: 'strawberry',
    name: 'Strawberry',
    blurb: 'pink where it counts. sits on whatever you were reading.',
    body: '#FBF2F4',
    patch: '#F0B7C9',
    ear: '#F0B7C9',
    tail: '#E39BB2',
    eye: '#3B2A44',
    style: 'patch',
    rare: false,
    price: 0,
    temperament: { energy: 0.55, sleepy: 0.4, social: 0.8 },
  },
  snow: {
    id: 'snow',
    name: 'Snow',
    blurb: 'entirely cream, entirely unbothered.',
    body: '#FDF8F8',
    patch: '#EFE3E8',
    ear: '#F0D8DE',
    tail: '#EFE3E8',
    eye: '#5B7CA8',
    style: 'none',
    rare: false,
    price: 60,
    temperament: { energy: 0.35, sleepy: 0.65, social: 0.5 },
  },
  calico: {
    id: 'calico',
    name: 'Calico',
    blurb: 'three colours, zero regrets.',
    body: '#FBF2F4',
    patch: '#E8A15C',
    ear: '#3B2A44',
    tail: '#E8A15C',
    eye: '#7A5C3E',
    style: 'spots',
    rare: false,
    price: 80,
    temperament: { energy: 0.7, sleepy: 0.3, social: 0.65 },
  },
  latte: {
    id: 'latte',
    name: 'Latte',
    blurb: 'the colour of the drink you forgot on the desk.',
    body: '#DCC1A4',
    patch: '#B98F68',
    ear: '#B98F68',
    tail: '#A97F58',
    eye: '#4A6B4C',
    style: 'tabby',
    rare: false,
    price: 80,
    temperament: { energy: 0.45, sleepy: 0.55, social: 0.7 },
  },
  peach: {
    id: 'peach',
    name: 'Peach',
    blurb: 'sunbeam-seeking. will find the one warm tile.',
    body: '#F8D9BE',
    patch: '#F6B98A',
    ear: '#F6B98A',
    tail: '#E9A473',
    eye: '#6B4A2E',
    style: 'patch',
    rare: false,
    price: 90,
    temperament: { energy: 0.5, sleepy: 0.55, social: 0.75 },
  },
  mist: {
    id: 'mist',
    name: 'Mist',
    blurb: 'grey-lavender, quiet, always three feet away.',
    body: '#C9C4D6',
    patch: '#A79FBE',
    ear: '#A79FBE',
    tail: '#948BAE',
    eye: '#6E8FA3',
    style: 'tabby',
    rare: false,
    price: 110,
    temperament: { energy: 0.4, sleepy: 0.5, social: 0.3 },
  },
  shadow: {
    id: 'shadow',
    name: 'Shadow',
    blurb: 'a tuxedo. formal about napping.',
    body: '#4A415C',
    patch: '#FBF2F4',
    ear: '#3B2A44',
    tail: '#3B2A44',
    eye: '#F5E1A4',
    style: 'tuxedo',
    rare: false,
    price: 130,
    temperament: { energy: 0.6, sleepy: 0.45, social: 0.45 },
  },
  matcha: {
    id: 'matcha',
    name: 'Matcha',
    blurb: 'faintly green in the right light. insists it is normal.',
    body: '#DCE6CC',
    patch: '#A9C293',
    ear: '#A9C293',
    tail: '#8FAE7B',
    eye: '#3E5C3A',
    style: 'patch',
    rare: false,
    price: 150,
    temperament: { energy: 0.65, sleepy: 0.35, social: 0.6 },
  },

  void: {
    id: 'void',
    name: 'Void',
    blurb: 'a cat-shaped absence. the eyes arrive first.',
    body: '#241E33',
    patch: '#1A1526',
    ear: '#1A1526',
    tail: '#1A1526',
    eye: '#A9D6C0',
    style: 'none',
    rare: true,
    price: 420,
    temperament: { energy: 0.5, sleepy: 0.6, social: 0.25 },
    quirk: 'glow-eyes',
  },
  boba: {
    id: 'boba',
    name: 'Boba',
    blurb: 'tapioca-pearl spots. suspiciously round.',
    body: '#E3C9A8',
    patch: '#4A3527',
    ear: '#C9A882',
    tail: '#4A3527',
    eye: '#3B2A44',
    style: 'spots',
    rare: true,
    price: 380,
    temperament: { energy: 0.55, sleepy: 0.5, social: 0.85 },
  },
  sakura: {
    id: 'sakura',
    name: 'Sakura',
    blurb: 'petals settle on her and simply stay.',
    body: '#FBEFF2',
    patch: '#F2B9CC',
    ear: '#F2B9CC',
    tail: '#E9A0BC',
    eye: '#8C5F76',
    style: 'petals',
    rare: true,
    price: 460,
    temperament: { energy: 0.45, sleepy: 0.55, social: 0.7 },
    quirk: 'petal-trail',
  },
  robo: {
    id: 'robo',
    name: 'Robo',
    blurb: 'beeps once, then pretends it did not.',
    body: '#C6CCD6',
    patch: '#8F98A8',
    ear: '#8F98A8',
    tail: '#7C8697',
    eye: '#A9D6C0',
    style: 'none',
    rare: true,
    price: 0,
    temperament: { energy: 0.8, sleepy: 0.2, social: 0.5 },
    quirk: 'antenna',
    unlockHint: 'arrives on its own, eventually. try an old cheat code.',
  },
};

export const BREED_ORDER: readonly BreedId[] = [
  'strawberry',
  'snow',
  'calico',
  'latte',
  'peach',
  'mist',
  'shadow',
  'matcha',
  'void',
  'boba',
  'sakura',
  'robo',
];

export const STARTER_BREED: BreedId = 'strawberry';

export function isBreedId(value: unknown): value is BreedId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BREEDS, value);
}

/** Adoptable = has a price and is not code-gated. Robo is not for sale. */
export function isAdoptable(breed: BreedDef): boolean {
  return !breed.unlockHint;
}
