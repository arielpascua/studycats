import { describe, it, expect } from 'vitest';
import {
  adoptRemoteTimer,
  clockOffsetFrom,
  normalizeJoinCode,
  onlineBonfireGoal,
  settleBeforeAdopt,
  snapshotToParty,
  toCatCard,
  toWireTimer,
  type PartySnapshot,
  type WireTimer,
} from '../src/core/party-online';
import { bonfireGoal, bonfireProgress, MAX_PARTY } from '../src/core/party';
import { createTimer, start } from '../src/core/timer';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

const card = (name: string, breed = 'snow') => ({ name, breed, outfit: {}, bond: 3 });

function snapshot(overrides: Partial<PartySnapshot> = {}): PartySnapshot {
  return {
    id: 'party-1',
    code: 'ABCDEF',
    room: 'library',
    hostId: 'host',
    members: [
      { id: 'host', name: 'Alice', cat: card('Mochi'), seat: 0, connected: true },
      { id: 'guest-1', name: 'Bo', cat: card('Yuki', 'calico'), seat: 1, connected: true },
    ],
    sharedMinutes: 40,
    cheers: 3,
    timer: null,
    ...overrides,
  };
}

describe('the clock offset', () => {
  it('is local minus server, so a client 60 s fast lands a deadline 60 s later in its own epoch', () => {
    // Local clock reads T0 + 60 s while the server reads T0, with no round trip at all.
    const offset = clockOffsetFrom([{ sentAt: T0 + 60_000, receivedAt: T0 + 60_000, serverNow: T0 }]);
    expect(offset).toBe(60_000);

    const serverDeadline = T0 + 25 * MIN;
    const wire: WireTimer = {
      mode: 'focus',
      running: true,
      endsAt: serverDeadline,
      remainingMs: 25 * MIN,
      round: 0,
      settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsPerLongBreak: 4 },
    };
    const local = adoptRemoteTimer(createTimer(), wire, offset);
    expect(local.endsAt).toBe(serverDeadline + 60_000);
  });

  it('trusts the pong with the smallest round trip and reads the server clock at the midpoint', () => {
    const samples = [
      // A slow first pong (the server was busy seating us) that would put us 4 s off.
      { sentAt: T0, receivedAt: T0 + 8_000, serverNow: T0 },
      // A crisp one: 200 ms round trip, server exactly 100 ms behind our midpoint.
      { sentAt: T0 + 10_000, receivedAt: T0 + 10_200, serverNow: T0 + 10_000 },
      { sentAt: T0 + 20_000, receivedAt: T0 + 21_000, serverNow: T0 + 20_000 },
    ];
    expect(clockOffsetFrom(samples)).toBe(100);
  });

  it('is zero with nothing to go on, never NaN', () => {
    expect(clockOffsetFrom([])).toBe(0);
    expect(clockOffsetFrom([{ sentAt: NaN, receivedAt: T0, serverNow: T0 }])).toBe(0);
  });
});

describe('the wire timer', () => {
  it('round-trips through the host and back to a member on a different clock', () => {
    const offsetHost = -1_500; // host is 1.5 s behind the server
    const offsetMember = 4_000; // member is 4 s ahead of the server
    const host = start(createTimer({ focusMin: 25, autoStart: true }), T0);

    const wire = toWireTimer(host, offsetHost);
    expect(wire.endsAt).toBe((host.endsAt as number) - offsetHost);
    expect(wire.settings).toEqual({ focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsPerLongBreak: 4 });
    expect('autoStart' in wire.settings).toBe(false);

    const member = adoptRemoteTimer(createTimer({ focusMin: 50 }), wire, offsetMember);
    expect(member.mode).toBe('focus');
    expect(member.running).toBe(true);
    // Server epoch → member epoch: the host's deadline expressed on the member's own clock.
    expect(member.endsAt).toBe((host.endsAt as number) - offsetHost + offsetMember);
    expect(member.settings.focusMin).toBe(25);
    // Round-tripping again from the member's point of view reproduces the server deadline.
    expect(toWireTimer(member, offsetMember).endsAt).toBe(wire.endsAt);
  });

  it('publishes no deadline while paused and carries the banked remaining instead', () => {
    const paused = { ...createTimer(), mode: 'focus' as const, remainingMs: 7 * MIN };
    const wire = toWireTimer(paused, 999);
    expect(wire.endsAt).toBeNull();
    expect(wire.remainingMs).toBe(7 * MIN);
    const back = adoptRemoteTimer(createTimer(), wire, 12345);
    expect(back.running).toBe(false);
    expect(back.endsAt).toBeNull();
    expect(back.remainingMs).toBe(7 * MIN);
  });

  it('never advances a session: an already-expired deadline stays running, in the past', () => {
    const wire: WireTimer = {
      mode: 'focus',
      running: true,
      endsAt: T0 - 5 * MIN,
      remainingMs: 0,
      round: 1,
      settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsPerLongBreak: 4 },
    };
    const local = adoptRemoteTimer(createTimer(), wire, 0);
    expect(local.mode).toBe('focus');
    expect(local.running).toBe(true);
    expect(local.endsAt).toBe(T0 - 5 * MIN);
    expect(local.round).toBe(1);
  });

  it('keeps the member\'s own task and autoStart — those are not on the wire', () => {
    const mine = { ...createTimer({ autoStart: true }), task: 'chapter 4' };
    const wire = toWireTimer(createTimer({ focusMin: 30 }), 0);
    const adopted = adoptRemoteTimer(mine, wire, 0);
    expect(adopted.task).toBe('chapter 4');
    expect(adopted.settings.autoStart).toBe(true);
    expect(adopted.settings.focusMin).toBe(30);
  });

  it('sanitises a junk frame instead of trusting the shape', () => {
    const junk = {
      mode: 'nap',
      running: 'yes',
      endsAt: 'soon',
      remainingMs: -40,
      round: 99,
      settings: { focusMin: 9999, shortBreakMin: 'x', longBreakMin: 0, roundsPerLongBreak: 1 },
    } as unknown as WireTimer;
    const local = adoptRemoteTimer(createTimer(), junk, 0);
    expect(local.mode).toBe('idle');
    expect(local.running).toBe(false);
    expect(local.endsAt).toBeNull();
    expect(local.remainingMs).toBeGreaterThanOrEqual(0);
    expect(local.round).toBeLessThanOrEqual(local.settings.roundsPerLongBreak);
    expect(local.settings.focusMin).toBe(120);
    expect(local.settings.roundsPerLongBreak).toBe(2);
  });
});

describe('settling before adopting', () => {
  const wireBreak: WireTimer = {
    mode: 'shortBreak',
    running: true,
    endsAt: T0 + 5 * MIN,
    remainingMs: 5 * MIN,
    round: 1,
    settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, roundsPerLongBreak: 4 },
  };

  it('lets a focus that is about to end on our clock finish first, so our own tick pays for it', () => {
    const mine = start(createTimer({ focusMin: 25 }), T0 - 25 * MIN + 800); // ends 800 ms from now
    expect(settleBeforeAdopt(mine, wireBreak, T0)).toBe(T0 + 800);
  });

  it('settles at now when our deadline already passed', () => {
    const mine = start(createTimer({ focusMin: 25 }), T0 - 26 * MIN);
    expect(settleBeforeAdopt(mine, wireBreak, T0)).toBe(T0);
  });

  it('does not settle when the host skipped — skipped work is not paid', () => {
    const mine = start(createTimer({ focusMin: 25 }), T0 - 10 * MIN); // 15 min left
    expect(settleBeforeAdopt(mine, wireBreak, T0)).toBeNull();
  });

  it('does not settle when nothing changed or nothing is running', () => {
    const running = start(createTimer({ focusMin: 25 }), T0 - 25 * MIN + 500);
    expect(settleBeforeAdopt(running, { ...wireBreak, mode: 'focus' }, T0)).toBeNull();
    expect(settleBeforeAdopt(createTimer(), wireBreak, T0)).toBeNull();
  });
});

describe('snapshotToParty', () => {
  it('seats me as my own cat and everyone else as a guest, keeping the fire and the cheers', () => {
    const party = snapshotToParty(snapshot(), 'host', 'cat-1');
    expect(party.members).toHaveLength(2);
    expect(party.members[0]).toEqual({ id: 'host', playerName: 'Alice', catId: 'cat-1', guest: null });
    expect(party.members[1].catId).toBeNull();
    expect(party.members[1].guest).toEqual({ name: 'Yuki', breed: 'calico', outfit: {}, bond: 3 });
    expect(party.sharedMinutes).toBe(40);
    expect(party.cheers).toBe(3);
  });

  it('orders the roster by seat, not by arrival in the frame', () => {
    const shuffled = snapshot({
      members: [
        { id: 'guest-1', name: 'Bo', cat: card('Yuki'), seat: 2, connected: true },
        { id: 'host', name: 'Alice', cat: card('Mochi'), seat: 0, connected: true },
        { id: 'guest-2', name: 'Cy', cat: card('Nori'), seat: 1, connected: false },
      ],
    });
    expect(snapshotToParty(shuffled, 'guest-2', 'cat-9').members.map((m) => m.id)).toEqual(['host', 'guest-2', 'guest-1']);
  });

  it('drops a guest whose breed this build does not know, and sanitises the outfit', () => {
    const odd = snapshot({
      members: [
        { id: 'host', name: 'Alice', cat: card('Mochi'), seat: 0, connected: true },
        { id: 'g1', name: 'Bo', cat: card('Future', 'hologram'), seat: 1, connected: true },
        { id: 'g2', name: 'Cy', cat: { ...card('Nori'), outfit: { hat: 'hat-beanie', collar: 'not-a-thing', cape: 'hat-crown' } }, seat: 2, connected: true },
      ],
    });
    const party = snapshotToParty(odd, 'host', 'cat-1');
    expect(party.members.map((m) => m.id)).toEqual(['host', 'g2']);
    expect(party.members[1].guest?.outfit).toEqual({ hat: 'hat-beanie' });
  });

  it('caps at the party size even if the server sends more', () => {
    const many = snapshot({
      members: Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        cat: card(`C${i}`),
        seat: i,
        connected: true,
      })),
    });
    expect(snapshotToParty(many, 'p0', 'cat-1').members).toHaveLength(MAX_PARTY);
  });

  it('never invents a seat for me if I am not in the frame', () => {
    const party = snapshotToParty(snapshot(), 'stranger', 'cat-1');
    expect(party.members.every((m) => m.catId === null)).toBe(true);
  });
});

describe('the hearth online', () => {
  it('lights after three shared sessions at any party size, never cheaper than a duo', () => {
    expect(onlineBonfireGoal(2, 25)).toBe(150);
    expect(onlineBonfireGoal(5, 25)).toBe(375);
    expect(onlineBonfireGoal(1, 25)).toBe(onlineBonfireGoal(2, 25));
    expect(onlineBonfireGoal(4, 50)).toBe(600);
  });

  it('bonfireProgress takes an explicit goal and is unchanged without one', () => {
    const goal = onlineBonfireGoal(3, 25);
    expect(bonfireProgress(goal, 3, goal).maxed).toBe(true);
    expect(bonfireProgress(goal / 5, 3, goal).stage).toBe(1);
    expect(bonfireProgress(goal / 5, 3, goal).goal).toBe(goal);
    expect(bonfireProgress(30, 3)).toEqual(bonfireProgress(30, 3, bonfireGoal(3)));
  });
});

describe('what leaves the device', () => {
  it('a cat card is name, breed, outfit and bond level — nothing else', () => {
    const cat = {
      id: 'cat-1',
      name: 'Mochi',
      breed: 'snow' as const,
      bondXp: 400,
      petCount: 99,
      outfit: { hat: 'hat-beanie', collar: 'bogus' },
    };
    const wire = toCatCard(cat);
    expect(Object.keys(wire).sort()).toEqual(['bond', 'breed', 'name', 'outfit']);
    expect(wire.outfit).toEqual({ hat: 'hat-beanie' });
    expect(wire.bond).toBeGreaterThanOrEqual(1);
    expect(wire.bond).toBeLessThanOrEqual(10);
  });

  it('normalises a join code the way the server compares it', () => {
    expect(normalizeJoinCode(' ab-cd ef ')).toBe('ABCDEF');
    expect(normalizeJoinCode('')).toBe('');
  });
});

describe('snapshotToParty without a known local cat', () => {
  it('draws self from the server card instead of a blank cat', () => {
    const snapshot = {
      id: '1',
      code: 'ABCDEF',
      room: 'library' as const,
      hostId: 'p1',
      members: [
        { id: 'p1', name: 'Alice', cat: { name: 'Mochi', breed: 'snow', outfit: {}, bond: 3 }, seat: 0, connected: true },
        { id: 'p2', name: 'Bob', cat: { name: 'Pepper', breed: 'calico', outfit: {}, bond: 1 }, seat: 1, connected: true },
      ],
      sharedMinutes: 0,
      cheers: 0,
      timer: null,
    };
    const party = snapshotToParty(snapshot, 'p1', '');
    expect(party.members.map((m) => m.playerName)).toEqual(['Alice', 'Bob']);
    const self = party.members[0];
    expect(self.catId).toBeNull();
    expect(self.guest?.name).toBe('Mochi');
    expect(self.guest?.breed).toBe('snow');
  });
});
