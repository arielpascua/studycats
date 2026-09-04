/**
 * The party: who is in the arena, and where they sit.
 *
 * Pure — no DOM, no Three.js. Everything multiplayer *means* lives here (roster, capacity,
 * labels, the ring the cats sit on, how the shared bonfire grows), so the arena scene is only a
 * projection of it, exactly as the single-player scene is a projection of `feeding.ts`.
 *
 * Two people can play from one keyboard, and a friend who is not in the room can send their cat
 * as a *cat card* — a short code that carries the cat and its outfit but nothing else. No
 * server, no account, no name ever leaves the device unless its owner pastes it somewhere.
 */

import { BREEDS, isBreedId, type BreedId } from '../data/breeds';
import { sanitizeOutfit, type Outfit } from '../data/cosmetics';

export const MIN_PARTY = 2;
export const MAX_PARTY = 8;
export const MAX_PLAYER_NAME = 14;

/** A cat that lives on someone else's device, brought in by cat card. */
export interface GuestCat {
  name: string;
  breed: BreedId;
  outfit: Outfit;
  /** Bond level 1-10, carried across so a well-loved cat still reads as one. */
  bond: number;
}

export interface PartyMember {
  id: string;
  /** The human. Shown in the label as "Mochi (Alice)". */
  playerName: string;
  /** A cat from this device's collection, or null when `guest` is set. */
  catId: string | null;
  guest: GuestCat | null;
}

export interface PartyState {
  members: PartyMember[];
  /** Combined focus minutes the party has banked together. Drives the bonfire. */
  sharedMinutes: number;
  /** Cheers sent this session — the small social act. */
  cheers: number;
}

export function createParty(): PartyState {
  return { members: [], sharedMinutes: 0, cheers: 0 };
}

/* ------------------------------------------------------------------ labels */

/**
 * The multiplayer label. This is the whole social contract of the mode in one string: the cat
 * is the character, the person is the context.
 */
export function partyLabel(catName: string, playerName: string): string {
  const cat = (catName || 'Cat').trim();
  const player = (playerName || '').trim();
  return player ? `${cat} (${player})` : cat;
}

export function sanitizePlayerName(input: unknown): string {
  return String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PLAYER_NAME);
}

/* ------------------------------------------------------------------ roster */

export type AddResult = { ok: true; party: PartyState } | { ok: false; reason: string };

export function addMember(
  party: PartyState,
  member: { playerName: string; catId?: string | null; guest?: GuestCat | null; id?: string },
): AddResult {
  if (party.members.length >= MAX_PARTY) {
    return { ok: false, reason: `a party seats ${MAX_PARTY} — send someone home first` };
  }
  const playerName = sanitizePlayerName(member.playerName);
  if (!playerName) return { ok: false, reason: 'give this player a name first' };

  // Names are how you tell two cats apart at a glance, so they have to be distinct.
  const taken = party.members.some((m) => m.playerName.toLowerCase() === playerName.toLowerCase());
  if (taken) return { ok: false, reason: `${playerName} is already here — try a different name` };

  const catId = member.catId ?? null;
  const guest = member.guest ?? null;
  if (!catId && !guest) return { ok: false, reason: 'pick a cat to bring' };

  // One cat cannot be in two places. Guests are exempt: they are copies, not the cat itself.
  if (catId && party.members.some((m) => m.catId === catId)) {
    return { ok: false, reason: 'that cat is already in the party — everyone brings one' };
  }

  // ONE CAT PER DEVICE. A party is other people, not your own collection lined up on cushions:
  // you bring exactly one of your cats and everybody else arrives as a guest. Enforced here
  // rather than in the panel so it holds for imported saves and any future entry point too.
  if (catId && party.members.some((m) => m.catId !== null)) {
    return { ok: false, reason: 'you bring one cat — the rest of the party joins with a code' };
  }

  const id = member.id ?? `p${party.members.length}-${playerName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return {
    ok: true,
    party: { ...party, members: [...party.members, { id, playerName, catId, guest }] },
  };
}

/** The member representing this device's player, if they have taken their seat yet. */
export function hostMember(party: PartyState): PartyMember | null {
  return party.members.find((m) => m.catId !== null) ?? null;
}

export function removeMember(party: PartyState, id: string): PartyState {
  return { ...party, members: party.members.filter((m) => m.id !== id) };
}

export function renameMember(party: PartyState, id: string, playerName: string): PartyState {
  const clean = sanitizePlayerName(playerName);
  if (!clean) return party;
  return {
    ...party,
    members: party.members.map((m) => (m.id === id ? { ...m, playerName: clean } : m)),
  };
}

/**
 * A party can start when there are enough people AND one of them is you.
 *
 * The second clause is the one that was missing. "You bring one cat" was enforced as "at most
 * one", so a roster of five guests with no host passed as ready and the panel said "everyone is
 * here" over a room that did not contain the player's own cat. A party you are not in is not
 * your party.
 */
export function isReady(party: PartyState): boolean {
  return party.members.length >= MIN_PARTY && hostMember(party) !== null;
}

/* ------------------------------------------------------------------- arena */

/** The ring the cats sit on. Grows with the party so nobody is ever crowded. */
export const ARENA_BASE_RADIUS = 3.2;
export const ARENA_RADIUS_PER_MEMBER = 0.62;

export function arenaRadius(memberCount: number): number {
  const n = Math.max(MIN_PARTY, Math.min(MAX_PARTY, memberCount || MIN_PARTY));
  return ARENA_BASE_RADIUS + (n - MIN_PARTY) * ARENA_RADIUS_PER_MEMBER;
}

export interface Seat {
  x: number;
  z: number;
  /** Facing the centre, so every cat looks at the fire. */
  facing: number;
}

/**
 * Evenly spaced seats around the fire, with the first seat toward the camera so the host's cat
 * is the one you see best. Pure, so the scene and the tests agree on where everyone is.
 */
export function seats(memberCount: number, radius = arenaRadius(memberCount)): Seat[] {
  const n = Math.max(1, Math.min(MAX_PARTY, memberCount));
  const out: Seat[] = [];
  for (let i = 0; i < n; i++) {
    // Start at +z (toward the default camera) and go round.
    const angle = (i / n) * Math.PI * 2;
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    out.push({ x, z, facing: Math.atan2(-x, -z) });
  }
  return out;
}

/* ---------------------------------------------------------------- bonfire */

/**
 * The shared bonfire is the thing single player does not have.
 *
 * It grows on the party's *combined* focus, so a bigger group lights it faster and everybody's
 * session counts toward the same object. Per-member scaling keeps a duo's fire reachable
 * without making an eight-cat party trivial.
 */
export const BONFIRE_STAGES = 5;

export function bonfireGoal(memberCount: number): number {
  const n = Math.max(MIN_PARTY, memberCount || MIN_PARTY);
  return 25 * n;
}

/** 0..1 through the current stage, and the stage itself (0..BONFIRE_STAGES). */
export function bonfireProgress(sharedMinutes: number, memberCount: number): {
  stage: number;
  into: number;
  goal: number;
  maxed: boolean;
} {
  const goal = bonfireGoal(memberCount);
  const perStage = goal / BONFIRE_STAGES;
  const minutes = Math.max(0, sharedMinutes || 0);
  const raw = minutes / perStage;
  const stage = Math.min(BONFIRE_STAGES, Math.floor(raw));
  return {
    stage,
    into: stage >= BONFIRE_STAGES ? 1 : raw - stage,
    goal,
    maxed: stage >= BONFIRE_STAGES,
  };
}

/** Coins the party earns together when the fire reaches full height. */
export function bonfireReward(memberCount: number): number {
  return 40 + 15 * Math.max(MIN_PARTY, memberCount || MIN_PARTY);
}

/* ---------------------------------------------------------------- cat card */

const CARD_PREFIX = 'CAT1.';

interface CardPayload {
  n: string;
  b: string;
  o: Outfit;
  l: number;
}

function checksum(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const padded = code.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a cat as a shareable card. Carries the cat and what it is wearing — nothing else. No
 * coins, no stats, no identity: a card is a photograph, not an account.
 */
export function encodeCatCard(cat: GuestCat): string {
  const payload: CardPayload = {
    n: cat.name.slice(0, 24),
    b: cat.breed,
    o: sanitizeOutfit(cat.outfit),
    l: Math.max(1, Math.min(10, Math.round(cat.bond || 1))),
  };
  const body = toBase64Url(JSON.stringify(payload));
  return `${CARD_PREFIX}${body}.${checksum(body)}`;
}

export type CardResult = { ok: true; cat: GuestCat } | { ok: false; error: string };

/**
 * Decode a card. Every failure names the problem *and* the fix — a friend squinting at a code
 * in a chat window is the least forgiving place to show "invalid input".
 */
export function decodeCatCard(input: string): CardResult {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'paste the card your friend sent — it starts with CAT1.' };
  if (!text.startsWith(CARD_PREFIX)) {
    return { ok: false, error: "that isn't a cat card — the code should start with CAT1." };
  }

  const rest = text.slice(CARD_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) {
    return { ok: false, error: 'that card is missing its ending — copy it again, all the way to the last character' };
  }

  const body = rest.slice(0, dot);
  const sum = rest.slice(dot + 1);
  if (checksum(body) !== sum) {
    return { ok: false, error: 'that card looks like it got cut off or mistyped — ask for a fresh copy' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(body));
  } catch {
    return { ok: false, error: 'that card could not be read — ask for a fresh copy' };
  }

  const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<CardPayload>;
  if (!isBreedId(raw.b)) {
    return { ok: false, error: 'that card is from a newer version of the game — update, then try again' };
  }

  return {
    ok: true,
    cat: {
      name: String(raw.n ?? BREEDS[raw.b].name).slice(0, 24) || BREEDS[raw.b].name,
      breed: raw.b,
      outfit: sanitizeOutfit(raw.o),
      bond: Math.max(1, Math.min(10, Math.round(Number(raw.l) || 1))),
    },
  };
}

/* ----------------------------------------------------------------- persist */

export interface PartySave {
  members: PartyMember[];
  sharedMinutes: number;
  cheers: number;
}

/** Never trust a stored roster: cats get sent home, and a member pointing at one must not linger. */
export function normalizeParty(input: unknown, knownCatIds: readonly string[]): PartyState {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<PartySave>;
  const known = new Set(knownCatIds);
  const seenNames = new Set<string>();
  const seenCats = new Set<string>();

  const members: PartyMember[] = [];
  for (const entry of Array.isArray(raw.members) ? raw.members : []) {
    const m = (entry && typeof entry === 'object' ? entry : {}) as Partial<PartyMember>;
    const playerName = sanitizePlayerName(m.playerName);
    if (!playerName || seenNames.has(playerName.toLowerCase())) continue;

    const guest =
      m.guest && typeof m.guest === 'object' && isBreedId((m.guest as GuestCat).breed)
        ? {
            name: String((m.guest as GuestCat).name ?? '').slice(0, 24) || 'Cat',
            breed: (m.guest as GuestCat).breed,
            outfit: sanitizeOutfit((m.guest as GuestCat).outfit),
            bond: Math.max(1, Math.min(10, Math.round(Number((m.guest as GuestCat).bond) || 1))),
          }
        : null;

    // One cat per device, same rule addMember enforces. A save edited by hand (or written by an
    // older build, which allowed a whole shelf of your own cats) must come back obeying it, so
    // the rule lives on both the way in and the way through.
    const claimsLocal =
      typeof m.catId === 'string' && known.has(m.catId) && !seenCats.has(m.catId) && seenCats.size === 0;
    const catId = claimsLocal ? (m.catId as string) : null;
    if (!catId && !guest) continue;
    if (catId) seenCats.add(catId);

    seenNames.add(playerName.toLowerCase());
    members.push({ id: String(m.id ?? `p${members.length}`), playerName, catId, guest });
    if (members.length >= MAX_PARTY) break;
  }

  return {
    members,
    sharedMinutes: Math.max(0, Number(raw.sharedMinutes) || 0),
    cheers: Math.max(0, Math.floor(Number(raw.cheers) || 0)),
  };
}
