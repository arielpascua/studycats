import { describe, it, expect } from 'vitest';
import {
  ARENA_BASE_RADIUS,
  BONFIRE_STAGES,
  MAX_PARTY,
  MAX_PLAYER_NAME,
  MIN_PARTY,
  addMember,
  arenaRadius,
  bonfireGoal,
  bonfireProgress,
  bonfireReward,
  createParty,
  decodeCatCard,
  hostMember,
  encodeCatCard,
  isReady,
  normalizeParty,
  partyLabel,
  removeMember,
  renameMember,
  sanitizePlayerName,
  seats,
  type GuestCat,
  type PartyState,
} from '../src/core/party';

const guestNamed = (name: string): GuestCat => ({ name, breed: 'snow', outfit: {}, bond: 3 });

/**
 * A party of the shape the product actually allows: the first entry is this device's player
 * with one of their own cats, and everyone after them is a guest who joined.
 */
function withMembers(names: Array<[string, string]>): PartyState {
  let party = createParty();
  names.forEach(([player, catId], i) => {
    const result = addMember(
      party,
      i === 0 ? { playerName: player, catId } : { playerName: player, guest: guestNamed(catId) },
    );
    if (result.ok) party = result.party;
  });
  return party;
}

describe('the label is the social contract', () => {
  it('reads "Cat (Player)"', () => {
    expect(partyLabel('Mochi', 'Alice')).toBe('Mochi (Alice)');
  });

  it('falls back to the cat alone when there is no player name', () => {
    expect(partyLabel('Mochi', '')).toBe('Mochi');
    expect(partyLabel('Mochi', '   ')).toBe('Mochi');
  });

  it('never produces an empty label', () => {
    expect(partyLabel('', '')).toBe('Cat');
  });

  it('collapses whitespace and caps the player name', () => {
    expect(sanitizePlayerName('  Alice   B  ')).toBe('Alice B');
    expect(sanitizePlayerName('x'.repeat(50))).toHaveLength(MAX_PLAYER_NAME);
    expect(sanitizePlayerName(null)).toBe('');
  });
});

describe('the roster', () => {
  it('adds players and reports readiness at two', () => {
    let party = createParty();
    expect(isReady(party)).toBe(false);

    const first = addMember(party, { playerName: 'Alice', catId: 'cat-1' });
    expect(first.ok).toBe(true);
    if (first.ok) party = first.party;
    expect(isReady(party)).toBe(false);

    const second = addMember(party, { playerName: 'Bo', guest: guestNamed('Yuki') });
    if (second.ok) party = second.party;
    expect(isReady(party)).toBe(true);
    expect(party.members).toHaveLength(MIN_PARTY);
  });

  it('refuses a duplicate player name, case-insensitively', () => {
    const party = withMembers([['Alice', 'cat-1']]);
    const dup = addMember(party, { playerName: 'alice', catId: 'cat-2' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/already here/i);
  });

  it('refuses to seat the same cat twice — everyone brings one', () => {
    const party = withMembers([['Alice', 'cat-1']]);
    const dup = addMember(party, { playerName: 'Bo', catId: 'cat-1' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/already in the party/i);
  });

  it('requires a name and a cat, and says which is missing', () => {
    const party = createParty();
    const noName = addMember(party, { playerName: '  ', catId: 'cat-1' });
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.reason).toMatch(/name/i);

    const noCat = addMember(party, { playerName: 'Alice' });
    expect(noCat.ok).toBe(false);
    if (!noCat.ok) expect(noCat.reason).toMatch(/cat/i);
  });

  it('caps the party and says so', () => {
    let party = createParty();
    for (let i = 0; i < MAX_PARTY; i++) {
      const r = addMember(
        party,
        i === 0 ? { playerName: `P${i}`, catId: 'cat-0' } : { playerName: `P${i}`, guest: guestNamed(`g${i}`) },
      );
      if (r.ok) party = r.party;
    }
    expect(party.members).toHaveLength(MAX_PARTY);
    const overflow = addMember(party, { playerName: 'One More', guest: guestNamed('Late') });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toMatch(new RegExp(String(MAX_PARTY)));
  });

  it('lets a guest cat share a breed with a local cat — a card is a copy, not the cat', () => {
    const party = withMembers([['Alice', 'cat-1']]);
    const guest: GuestCat = { name: 'Mochi', breed: 'strawberry', outfit: {}, bond: 4 };
    const added = addMember(party, { playerName: 'Bo', guest });
    expect(added.ok).toBe(true);
  });

  it('removes and renames without disturbing anyone else', () => {
    let party = withMembers([['Alice', 'cat-1'], ['Bo', 'cat-2'], ['Cy', 'cat-3']]);
    party = renameMember(party, party.members[1].id, '  Bobby  ');
    expect(party.members[1].playerName).toBe('Bobby');
    expect(party.members.map((m) => m.playerName)).toEqual(['Alice', 'Bobby', 'Cy']);

    party = removeMember(party, party.members[0].id);
    expect(party.members.map((m) => m.playerName)).toEqual(['Bobby', 'Cy']);
  });

  it('ignores a rename to nothing rather than blanking the label', () => {
    const party = withMembers([['Alice', 'cat-1']]);
    expect(renameMember(party, party.members[0].id, '   ').members[0].playerName).toBe('Alice');
  });
});

describe('the arena grows with the party', () => {
  it('expands monotonically from two to eight', () => {
    let previous = 0;
    for (let n = MIN_PARTY; n <= MAX_PARTY; n++) {
      const r = arenaRadius(n);
      expect(r).toBeGreaterThan(previous);
      previous = r;
    }
    expect(arenaRadius(MIN_PARTY)).toBe(ARENA_BASE_RADIUS);
  });

  it('clamps nonsense counts instead of collapsing the ring', () => {
    expect(arenaRadius(0)).toBe(arenaRadius(MIN_PARTY));
    expect(arenaRadius(99)).toBe(arenaRadius(MAX_PARTY));
    expect(Number.isFinite(arenaRadius(NaN))).toBe(true);
  });

  it('seats everyone on the ring, evenly, facing the fire', () => {
    for (let n = MIN_PARTY; n <= MAX_PARTY; n++) {
      const ring = seats(n);
      expect(ring).toHaveLength(n);

      const radius = arenaRadius(n);
      for (const seat of ring) {
        expect(Math.hypot(seat.x, seat.z)).toBeCloseTo(radius, 5);
        // Facing the centre means the forward vector points back at the origin.
        const forward = { x: Math.sin(seat.facing), z: Math.cos(seat.facing) };
        const toCentre = { x: -seat.x / radius, z: -seat.z / radius };
        expect(forward.x).toBeCloseTo(toCentre.x, 5);
        expect(forward.z).toBeCloseTo(toCentre.z, 5);
      }

      // Evenly spaced: every neighbour pair is the same distance apart.
      if (n > 2) {
        const gaps = ring.map((s, i) => {
          const next = ring[(i + 1) % n];
          return Math.hypot(next.x - s.x, next.z - s.z);
        });
        for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 5);
      }
    }
  });

  it('puts the first seat toward the camera', () => {
    const [first] = seats(4);
    expect(first.x).toBeCloseTo(0, 5);
    expect(first.z).toBeGreaterThan(0);
  });

  it('never overlaps two cats, at any party size', () => {
    // A cat is ~1.1 units across; neighbours must clear that on the tightest ring.
    for (let n = MIN_PARTY; n <= MAX_PARTY; n++) {
      const ring = seats(n);
      for (let i = 0; i < ring.length; i++) {
        for (let j = i + 1; j < ring.length; j++) {
          const d = Math.hypot(ring[i].x - ring[j].x, ring[i].z - ring[j].z);
          expect(d).toBeGreaterThan(1.2);
        }
      }
    }
  });
});

describe('the shared bonfire', () => {
  it('needs more from a bigger party but stays reachable', () => {
    expect(bonfireGoal(2)).toBeLessThan(bonfireGoal(8));
    // Per head it must not get harder, or big parties are punished for being big.
    expect(bonfireGoal(8) / 8).toBeLessThanOrEqual(bonfireGoal(2) / 2);
  });

  it('climbs through its stages and then holds', () => {
    const goal = bonfireGoal(4);
    expect(bonfireProgress(0, 4).stage).toBe(0);
    expect(bonfireProgress(goal / 2, 4).stage).toBe(Math.floor(BONFIRE_STAGES / 2));
    const full = bonfireProgress(goal, 4);
    expect(full.stage).toBe(BONFIRE_STAGES);
    expect(full.maxed).toBe(true);
    expect(bonfireProgress(goal * 10, 4).stage).toBe(BONFIRE_STAGES);
  });

  it('is monotonic and never NaN', () => {
    let previous = -1;
    for (let m = 0; m <= 400; m += 7) {
      const { stage, into } = bonfireProgress(m, 5);
      expect(Number.isFinite(into)).toBe(true);
      expect(into).toBeGreaterThanOrEqual(0);
      expect(into).toBeLessThanOrEqual(1);
      expect(stage).toBeGreaterThanOrEqual(previous);
      previous = stage;
    }
    expect(bonfireProgress(NaN, NaN).stage).toBe(0);
    expect(bonfireProgress(-50, 3).stage).toBe(0);
  });

  it('pays more to a bigger circle', () => {
    expect(bonfireReward(8)).toBeGreaterThan(bonfireReward(2));
  });
});

describe('cat cards travel without an account', () => {
  const cat: GuestCat = {
    name: 'Mochi',
    breed: 'strawberry',
    outfit: { hat: 'hat-crown', collar: 'collar-bell' },
    bond: 7,
  };

  it('round-trips exactly', () => {
    const result = decodeCatCard(encodeCatCard(cat));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cat).toEqual(cat);
  });

  it('survives names with spaces and non-ASCII', () => {
    const fancy: GuestCat = { ...cat, name: 'Sakura ちゃん' };
    const result = decodeCatCard(encodeCatCard(fancy));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cat.name).toBe('Sakura ちゃん');
  });

  it('carries the outfit but never anything else', () => {
    const code = encodeCatCard(cat);
    // Coins, stats and identity must not be recoverable from a card.
    expect(code).not.toMatch(/coin|streak|email|Alice/i);
  });

  it('names both the problem and the fix for every failure', () => {
    const empty = decodeCatCard('   ');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/CAT1\./);

    const wrong = decodeCatCard('hello friend');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/isn't a cat card/i);

    const code = encodeCatCard(cat);
    const truncated = decodeCatCard(code.slice(0, code.length - 4));
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.error).toMatch(/cut off|mistyped|fresh copy/i);
  });

  it('rejects a tampered payload rather than importing a broken cat', () => {
    const code = encodeCatCard(cat);
    const dot = code.lastIndexOf('.');
    const tampered = `${code.slice(0, dot - 3)}XYZ${code.slice(dot)}`;
    const result = decodeCatCard(tampered);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown breed with an actionable message', () => {
    const bad = encodeCatCard({ ...cat, breed: 'dragon' as never });
    const result = decodeCatCard(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/newer version|update/i);
  });

  it('drops cosmetics worn in the wrong slot', () => {
    const sneaky = encodeCatCard({ ...cat, outfit: { hat: 'cape-classic' } as never });
    const result = decodeCatCard(sneaky);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cat.outfit.hat).toBeUndefined();
  });
});

describe('a stored roster is never trusted', () => {
  it('drops members whose cat was sent home', () => {
    const stored = {
      members: [
        { id: 'a', playerName: 'Alice', catId: 'cat-1', guest: null },
        { id: 'b', playerName: 'Bo', catId: 'cat-gone', guest: null },
      ],
      sharedMinutes: 40,
      cheers: 3,
    };
    const party = normalizeParty(stored, ['cat-1']);
    expect(party.members.map((m) => m.playerName)).toEqual(['Alice']);
    expect(party.sharedMinutes).toBe(40);
  });

  it('keeps a guest even though no local cat matches', () => {
    const party = normalizeParty(
      { members: [{ id: 'g', playerName: 'Remote', catId: null, guest: { name: 'Yuki', breed: 'snow', outfit: {}, bond: 3 } }] },
      [],
    );
    expect(party.members).toHaveLength(1);
    expect(party.members[0].guest?.name).toBe('Yuki');
  });

  it('de-duplicates names and cats, and caps the roster', () => {
    const members = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      playerName: i < 3 ? 'Same' : `P${i}`,
      catId: `cat-${i < 3 ? 0 : i}`,
      guest: null,
    }));
    const ids = Array.from({ length: 20 }, (_, i) => `cat-${i}`);
    const party = normalizeParty({ members }, ids);
    expect(party.members.length).toBeLessThanOrEqual(8);
    const names = party.members.map((m) => m.playerName.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('survives complete garbage', () => {
    for (const bad of [null, undefined, 'nope', 42, { members: 'x' }, { members: [null, 5] }]) {
      const party = normalizeParty(bad, ['cat-1']);
      expect(party.members).toEqual([]);
      expect(party.sharedMinutes).toBe(0);
    }
  });
});

describe('one cat per device', () => {
  it('lets you seat exactly one of your own cats', () => {
    let party = createParty();
    const first = addMember(party, { playerName: 'Alice', catId: 'cat-mochi' });
    expect(first.ok).toBe(true);
    party = (first as { ok: true; party: PartyState }).party;

    const second = addMember(party, { playerName: 'Bob', catId: 'cat-shadow' });
    expect(second.ok).toBe(false);
    expect((second as { ok: false; reason: string }).reason).toMatch(/one cat/i);
  });

  it('still lets everyone else join as guests', () => {
    let party = createParty();
    party = (addMember(party, { playerName: 'Alice', catId: 'cat-mochi' }) as { ok: true; party: PartyState }).party;
    for (const name of ['Bo', 'Cy', 'Di']) {
      const guest = guestNamed(`${name}cat`);
      const res = addMember(party, { playerName: name, guest });
      expect(res.ok, `${name} should be able to join`).toBe(true);
      party = (res as { ok: true; party: PartyState }).party;
    }
    expect(party.members).toHaveLength(4);
    expect(party.members.filter((m) => m.catId !== null)).toHaveLength(1);
  });

  it('frees the slot again once your cat goes home', () => {
    let party = createParty();
    party = (addMember(party, { playerName: 'Alice', catId: 'cat-mochi' }) as { ok: true; party: PartyState }).party;
    expect(hostMember(party)?.playerName).toBe('Alice');

    party = removeMember(party, party.members[0].id);
    expect(hostMember(party)).toBeNull();
    expect(addMember(party, { playerName: 'Alice', catId: 'cat-shadow' }).ok).toBe(true);
  });
});

describe('normalizeParty enforces one cat per device', () => {
  it('keeps the first local cat and drops later ones', () => {
    const party = normalizeParty(
      {
        members: [
          { id: 'a', playerName: 'Alice', catId: 'cat-1', guest: null },
          { id: 'b', playerName: 'Bo', catId: 'cat-2', guest: null },
          { id: 'c', playerName: 'Cy', catId: null, guest: guestNamed('Yuki') },
        ],
      },
      ['cat-1', 'cat-2'],
    );
    expect(party.members.map((m) => m.playerName)).toEqual(['Alice', 'Cy']);
    expect(party.members.filter((m) => m.catId !== null)).toHaveLength(1);
  });
});
