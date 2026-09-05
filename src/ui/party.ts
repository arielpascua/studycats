/**
 * The Party panel: a code, the people who typed it, and the fire they are feeding together.
 *
 * Online leads. What the server learns about you is spelled out at the top in one sentence,
 * because the old no-network promise is exactly what this panel retires — a party is other
 * people, and other people are on other devices. The cat-card party stays underneath, folded
 * away, for a train with no signal.
 *
 * The panel is rebuilt from state on every `party:changed`, so nothing here is diffed. Anything
 * that has to outlive a rebuild — the name you typed, which button you pressed, whether FORGET
 * is armed — is view state and lives in module scope, the way the shop remembers its aisles.
 * No network call is made from here: every action goes through `game.*`.
 */

import {
  BONFIRE_STAGES,
  MAX_PARTY,
  MAX_PLAYER_NAME,
  MIN_PARTY,
  bonfireProgress,
  hostMember,
  isReady,
  partyLabel,
  type PartyState,
} from '../core/party';
import { onlineBonfireGoal, type OnlineState } from '../core/party-online';
import { BREEDS } from '../data/breeds';
import { ROOMS, ROOM_ORDER, roomDef, type RoomDef, type RoomId } from '../data/rooms';
import { bus } from '../core/events';
import { outfitSize } from '../data/cosmetics';
import type { Game } from '../store';
import { audio } from '../audio/engine';
import { announce, collapsibleSection, el, emptyState, field, section } from './dom';

/** The disclosure. Verbatim from the design of record; it is the whole privacy story. */
const DISCLOSURE =
  "to be in a party your cat's name, breed, outfit and bond level, and the name you type, are sent to our server and shown to everyone with the code. nothing else — not your save, not what you are studying. leaving deletes the party's rows.";

const MAX_CODE_INPUT = 8;
const FORGET_ARM_MS = 4_000;
const COPIED_MS = 1_500;
const FALLBACK_TITLE = 'no internet? cat cards';
const ROOMS_TITLE = 'MORE ROOMS';

/* ------------------------------------------------------------- view state */

/** What you last typed and picked, so a failed join does not make you type it all again. */
let draftName = '';
let draftCode = '';
let draftCatId: string | null = null;
let draftRoom: RoomId | null = null;
/** Which of START / JOIN is waiting on the server, so a rebuild mid-connect keeps its label. */
let pressed: 'start' | 'join' | null = null;
/** An error the action itself returned (a blank name, a short code) — the store never sees those. */
let actionError: string | null = null;
/** FORGET ME is a two-tap. The arm survives a rebuild but not four seconds. */
let forgetArmedUntil = 0;
/** Open/closed state of the folding parts, remembered across rebuilds like the cats panel. */
const openSections = new Map<string, boolean>();

/* ------------------------------------------------------------------ build */

export function buildPartyPanel(game: Game, rerender: () => void): HTMLElement {
  const online = game.online();
  const seated = online.partyId !== null;
  const body = el('div', { class: 'panel__body' });

  body.appendChild(statusSection(game, online, seated));

  if (seated) {
    for (const node of partySections(game, online, rerender)) body.appendChild(node);
  } else {
    for (const node of entrySections(game, online, rerender)) body.appendChild(node);
  }

  // The cat-card party reads and writes `state.party`, which is the live roster while online.
  // It only exists while nothing is connected.
  if (online.status === 'offline') body.appendChild(fallbackSection(game, rerender));

  body.appendChild(forgetSection(game, rerender, seated || online.status !== 'offline'));
  return body;
}

/* ----------------------------------------------------------------- status */

function statusLine(online: OnlineState, seated: boolean, venue: RoomDef): { text: string; tone: 'on' | 'off' | 'busy' } {
  if (online.status === 'reconnecting') return { text: 'reconnecting…', tone: 'busy' };
  if (seated && online.code) return { text: `in the ${venue.label.toLowerCase()} · code ${online.code}`, tone: 'on' };
  if (online.status === 'offline') return { text: 'offline', tone: 'off' };
  return { text: 'connecting…', tone: 'busy' };
}

function statusSection(game: Game, online: OnlineState, seated: boolean): HTMLElement {
  const venue = roomDef(game.getState().settings.room);
  const line = statusLine(online, seated, venue);

  // The store keeps the server's last word; the panel keeps its own. Whichever is newer wins,
  // and a fresh server message makes a stale local one redundant.
  const error = online.error ?? actionError;
  if (online.error) actionError = null;

  return section(
    'ONLINE',
    el(
      'p',
      { class: 'party-status', id: 'party-status' },
      el('span', { class: `dot dot--${line.tone}`, 'aria-hidden': 'true' }),
      el('span', { text: line.text }),
    ),
    el('p', { class: 'note', text: DISCLOSURE }),
    error ? el('p', { class: 'note note--warn', role: 'alert', text: error }) : null,
  );
}

/* ------------------------------------------------------------ async shape */

/**
 * Every action that asks the server follows one shape: the button goes quiet while the question
 * is out, comes back when it is answered, and the whole panel is rebuilt from whatever state the
 * answer left behind. A rejection is treated as "no answer" rather than a crash.
 */
function run<T>(
  btn: HTMLButtonElement,
  action: () => Promise<T>,
  onSettled: (result: T | null) => void,
  rerender: () => void,
): void {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  void action()
    .then(
      (result) => onSettled(result),
      () => onSettled(null),
    )
    .finally(() => {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      rerender();
    });
}

/* ------------------------------------------------------------ not seated */

function entrySections(game: Game, online: OnlineState, rerender: () => void): HTMLElement[] {
  const s = game.getState();
  const cats = s.cats;
  const hasCats = cats.length > 0;
  const busy = online.status !== 'offline';
  const ownedRooms = ROOM_ORDER.filter((id) => s.unlocks.rooms.includes(id));
  const lockedRooms = ROOM_ORDER.filter((id) => !s.unlocks.rooms.includes(id));

  /* one name and one cat serve both START and JOIN */

  const nameInput = el('input', {
    type: 'text',
    id: 'party-name',
    maxlength: String(MAX_PLAYER_NAME),
    placeholder: 'your name',
    autocomplete: 'nickname',
    value: draftName,
  });
  nameInput.addEventListener('input', () => {
    draftName = nameInput.value;
  });

  const catSelect = el('select', { id: 'party-cat' });
  const chosenCat = cats.some((c) => c.id === draftCatId) ? draftCatId : (cats[0]?.id ?? null);
  for (const cat of cats) {
    const option = el('option', { value: cat.id, text: `${cat.name} · ${BREEDS[cat.breed].name}` });
    if (cat.id === chosenCat) option.selected = true;
    catSelect.appendChild(option);
  }
  catSelect.disabled = !hasCats;
  catSelect.addEventListener('change', () => {
    draftCatId = catSelect.value;
  });

  const roomSelect = el('select', { id: 'party-room' });
  const chosenRoom = draftRoom && ownedRooms.includes(draftRoom) ? draftRoom : ownedRooms.includes(s.settings.room) ? s.settings.room : ownedRooms[0];
  for (const id of ownedRooms) {
    const def = ROOMS[id];
    const option = el('option', { value: id, text: `${def.icon} ${def.label}` });
    if (id === chosenRoom) option.selected = true;
    roomSelect.appendChild(option);
  }
  roomSelect.addEventListener('change', () => {
    draftRoom = roomSelect.value as RoomId;
  });

  const cannot = !hasCats || busy || ownedRooms.length === 0;

  /* start */

  const starting = busy && pressed === 'start';
  const startBtn = el(
    'button',
    { type: 'button', id: 'party-start', class: 'btn btn--primary', 'aria-busy': starting ? 'true' : null },
    starting ? 'CONNECTING…' : 'START A PARTY',
  );
  startBtn.disabled = cannot;
  startBtn.addEventListener('click', () => {
    audio.blip();
    pressed = 'start';
    actionError = null;
    run(
      startBtn,
      () => game.startOnlineParty(nameInput.value, catSelect.value, roomSelect.value as RoomId),
      (result) => {
        pressed = null;
        if (result?.ok) {
          audio.purchase();
          announce(`your party is open — the code is ${game.online().code ?? ''}`);
        } else {
          actionError = result?.error ?? 'that did not work — try again';
          announce(actionError);
        }
      },
      rerender,
    );
  });

  const start = section(
    'START A PARTY',
    el('p', {
      class: 'note',
      text: 'pick the cat you are bringing and where you are meeting. you get a six-letter code; friends type it on their own devices.',
    }),
    field('NAME', nameInput),
    field('CAT', catSelect),
    field('ROOM', roomSelect),
    hasCats ? null : el('p', { class: 'note', text: 'adopt a cat first — you bring exactly one, and it is how the party sees you.' }),
    startBtn,
  );

  /* rooms you do not own yet. Bought here because there is nowhere else to buy them. */

  const rooms = lockedRooms.length > 0 ? roomsSection(game, lockedRooms, rerender) : null;

  /* join */

  const joining = busy && pressed === 'join';
  const codeInput = el('input', {
    type: 'text',
    id: 'party-code-input',
    class: 'party-code-input',
    maxlength: String(MAX_CODE_INPUT),
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'ABC234',
    value: draftCode,
  });
  codeInput.addEventListener('input', () => {
    draftCode = codeInput.value.toUpperCase();
  });

  const joinBtn = el(
    'button',
    { type: 'button', id: 'party-join', class: 'btn btn--primary', 'aria-busy': joining ? 'true' : null },
    joining ? 'CONNECTING…' : 'JOIN',
  );
  joinBtn.disabled = !hasCats || busy;
  joinBtn.addEventListener('click', () => {
    audio.blip();
    pressed = 'join';
    actionError = null;
    run(
      joinBtn,
      () => game.joinOnlineParty(codeInput.value, nameInput.value, catSelect.value),
      (result) => {
        pressed = null;
        if (result?.ok) {
          draftCode = '';
          audio.purchase();
          announce(`you are in — code ${game.online().code ?? ''}`);
        } else {
          actionError = result?.error ?? 'that did not work — try again';
          announce(actionError);
        }
      },
      rerender,
    );
  });
  // Enter in the code field is unambiguous: there is one thing you can do with a code.
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !joinBtn.disabled) {
      event.preventDefault();
      joinBtn.click();
    }
  });

  const join = section(
    'JOIN A PARTY',
    el('p', { class: 'note', text: 'same name and cat as above. spaces and dashes in the code are fine.' }),
    field('CODE', codeInput),
    hasCats ? null : el('p', { class: 'note', text: 'adopt a cat first — a party seat is a cat.' }),
    joinBtn,
  );

  return [start, rooms, join].filter((node): node is HTMLElement => node !== null);
}

/** Locked rooms as the scene buttons the venue picker has always used: a tap buys, or explains. */
function roomsSection(game: Game, locked: readonly RoomId[], rerender: () => void): HTMLElement {
  const list = el('div', { class: 'scenes__list' });
  for (const id of locked) {
    const def = ROOMS[id];
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'scene-btn',
        'data-locked': 'true',
        'aria-label': `${def.label} — locked, ${def.price} fish coins. ${def.blurb}`,
      },
      el('span', { 'aria-hidden': 'true', text: def.icon }),
      el('span', { text: def.label }),
      el('span', { class: 'scene-btn__price', text: `${def.price} 🐟` }),
    );
    btn.addEventListener('click', () => {
      audio.blip();
      if (game.buyRoom(id)) {
        draftRoom = id;
        announce(`${def.label.toLowerCase()} unlocked`);
      } else {
        bus.emit('toast', {
          title: 'NOT YET',
          body: `${def.label.toLowerCase()} costs ${def.price} 🐟 — finish a session to earn more`,
          icon: def.icon,
          tone: 'gentle',
        });
      }
      rerender();
    });
    list.appendChild(btn);
  }
  return collapsibleSection(
    ROOMS_TITLE,
    {
      badge: `${locked.length} locked`,
      open: openSections.get(ROOMS_TITLE) === true,
      onToggle: (open) => openSections.set(ROOMS_TITLE, open),
    },
    el('p', { class: 'note', text: 'each one is a different place, not a different colour. buy it once and any party you host can meet there.' }),
    list,
  );
}

/* ---------------------------------------------------------------- seated */

function partySections(game: Game, online: OnlineState, rerender: () => void): HTMLElement[] {
  const s = game.getState();
  const party = s.party;
  const venue = roomDef(s.settings.room);
  const code = online.code ?? '';
  const snapshot = game.runtime.online.snapshot;

  /* the code */

  const codeEl = el('code', { id: 'party-code', 'aria-label': `party code ${code.split('').join(' ')}` }, code);
  const copyBtn = el('button', { type: 'button', id: 'party-copy', class: 'btn' }, 'COPY');
  copyBtn.addEventListener('click', () => {
    audio.blip();
    void copyCode(code, codeEl, copyBtn);
  });

  const head = section(
    venue.label,
    el('p', {
      class: 'note',
      text: `friends join with this code. everyone studies to ${online.isHost ? 'your' : "the host's"} clock, and every finished session feeds the ${venue.theme.hearth.name}.`,
    }),
    el('div', { class: 'party-code' }, codeEl, copyBtn),
  );

  /* who is here */

  const list = el('ul', { class: 'party-roster', 'aria-label': 'Who is in the party' });
  for (const member of party.members) {
    const local = member.catId ? s.cats.find((c) => c.id === member.catId) : undefined;
    const cat = local ?? member.guest;
    const breed = cat ? BREEDS[cat.breed] : null;
    const label = partyLabel(cat?.name ?? 'Cat', member.playerName);
    const isSelf = member.id === online.playerId;
    const isHost = member.id === online.hostId;
    const connected = snapshot?.members.find((m) => String(m.id) === member.id)?.connected ?? true;

    const actions = el('div', { class: 'party-member__actions' });
    if (!isSelf) {
      const cheer = el(
        'button',
        { type: 'button', id: `party-cheer-${member.id}`, class: 'btn btn--ghost party-cheer', 'aria-label': `Cheer ${label}` },
        'CHEER',
      );
      cheer.addEventListener('click', () => {
        audio.blip();
        game.sendCheer(member.id);
        announce(`cheered ${label}`);
      });
      actions.appendChild(cheer);

      if (online.isHost) {
        const kick = el(
          'button',
          { type: 'button', id: `party-kick-${member.id}`, class: 'btn btn--ghost party-kick', 'aria-label': `Send ${label} home` },
          'SEND HOME',
        );
        kick.addEventListener('click', () => {
          audio.blip();
          game.kickOnline(member.id);
          announce(`sent ${member.playerName} home`);
        });
        actions.appendChild(kick);
      }
    }

    list.appendChild(
      el(
        'li',
        { class: 'party-member', 'data-player-id': member.id, 'data-connected': connected ? 'true' : 'false' },
        el('span', { class: `dot ${connected ? 'dot--on' : 'dot--off'}`, role: 'img', 'aria-label': connected ? 'connected' : 'away' }),
        el('span', { class: 'party-member__name' }, swatch(breed?.body), label),
        isHost ? el('span', { class: 'section__badge party-member__tag', text: 'host' }) : null,
        isSelf ? el('span', { class: 'section__badge party-member__tag party-member__tag--you', text: 'you' }) : null,
        isSelf ? null : actions,
      ),
    );
  }

  const roster = section(`WHO IS HERE · ${party.members.length} OF ${MAX_PARTY}`, list);

  /* the hearth, scored the online way */

  const goal = onlineBonfireGoal(party.members.length, game.timer().settings.focusMin);
  const hearth = hearthSection(party, goal, venue, `${party.cheers} cheer${party.cheers === 1 ? '' : 's'} sent — tap CHEER, or tap a cat in the room.`);

  /* leaving */

  const leaveBtn = el('button', { type: 'button', id: 'party-leave', class: 'btn' }, 'LEAVE');
  const endBtn = online.isHost ? el('button', { type: 'button', id: 'party-end', class: 'btn btn--ghost' }, 'END PARTY') : null;

  leaveBtn.addEventListener('click', () => {
    audio.blip();
    if (endBtn) endBtn.disabled = true;
    run(leaveBtn, () => game.leaveOnlineParty(), () => announce('you left the party'), rerender);
  });

  // There is no "end" on the wire. Sending everyone home and then leaving is the same thing,
  // and the order matters: leave first and the party would carry on under the next host.
  endBtn?.addEventListener('click', () => {
    audio.blip();
    leaveBtn.disabled = true;
    run(
      endBtn,
      async () => {
        const self = game.online().playerId;
        for (const member of game.party().members) {
          if (member.id !== self) game.kickOnline(member.id);
        }
        await game.leaveOnlineParty();
      },
      () => announce('the party is over — everyone is home'),
      rerender,
    );
  });

  const doors = section(
    'HEADING HOME',
    el('p', {
      class: 'note',
      text: online.isHost
        ? 'LEAVE hands the party to whoever joined next. END PARTY sends everyone home and closes it.'
        : 'leaving takes your cat home. the party carries on without you.',
    }),
    el('div', { class: 'field__row' }, leaveBtn, endBtn),
  );

  return [head, roster, hearth, doors];
}

async function copyCode(code: string, codeEl: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (copied) {
    announce('code copied');
    btn.textContent = 'COPIED';
    globalThis.setTimeout(() => {
      if (btn.isConnected) btn.textContent = 'COPY';
    }, COPIED_MS);
    return;
  }
  // No clipboard (an old browser, or a page that is not a secure context): leave the code
  // selected so one more keystroke does the job.
  const range = document.createRange();
  range.selectNodeContents(codeEl);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  announce('the code is selected — copy it by hand');
}

function swatch(colour: string | undefined): HTMLElement | null {
  if (!colour) return null;
  return el('span', { class: 'party-member__swatch', style: `background:${colour}`, 'aria-hidden': 'true' });
}

/* ----------------------------------------------------------------- hearth */

/**
 * The shared hearth, exactly as it has always been drawn. The online party passes its own goal
 * because its minutes are credited per connected member; the cat-card party takes the default.
 */
function hearthSection(party: PartyState, goal: number | undefined, venue: RoomDef, cheerLine: string): HTMLElement {
  const progress = bonfireProgress(party.sharedMinutes, party.members.length, goal);
  const pct = Math.round(((progress.stage + progress.into) / BONFIRE_STAGES) * 100);
  return section(
    `THE SHARED ${venue.theme.hearth.name.toUpperCase()}`,
    el(
      'div',
      { class: 'quest', 'data-done': progress.maxed ? 'true' : 'false' },
      el(
        'div',
        { class: 'quest__row' },
        el('span', { text: progress.maxed ? 'roaring' : `stage ${progress.stage} of ${BONFIRE_STAGES}` }),
        el('span', { class: 'quest__reward', text: `${Math.round(party.sharedMinutes)} / ${progress.goal} min` }),
      ),
      el(
        'div',
        {
          class: 'quest__bar',
          role: 'progressbar',
          'aria-valuenow': String(Math.round(party.sharedMinutes)),
          'aria-valuemin': '0',
          'aria-valuemax': String(progress.goal),
          'aria-label': `Shared ${venue.theme.hearth.name}`,
        },
        el('div', { class: 'quest__fill', style: `width:${pct}%` }),
      ),
    ),
    el('p', { class: 'note', text: cheerLine }),
  );
}

/* --------------------------------------------------------------- fallback */

/**
 * The cat-card party: a code carrying one cat, pasted by hand. It was the whole of party mode
 * before the server existed, and it is still the one that works with no signal.
 */
function fallbackSection(game: Game, rerender: () => void): HTMLElement {
  const s = game.getState();
  const party = s.party;
  const inParty = s.settings.mode === 'party';
  const badge = inParty ? 'in the room' : party.members.length > 0 ? `${party.members.length} seated` : undefined;
  return collapsibleSection(
    FALLBACK_TITLE,
    {
      badge,
      open: openSections.get(FALLBACK_TITLE) === true,
      onToggle: (open) => openSections.set(FALLBACK_TITLE, open),
    },
    el('p', {
      class: 'note',
      text: 'a cat card is a short code carrying one cat and what it is wearing. it travels only where you paste it — no server, no account, no clock shared.',
    }),
    ...fallbackChildren(game, rerender),
  );
}

function fallbackChildren(game: Game, rerender: () => void): HTMLElement[] {
  const s = game.getState();
  const party = s.party;
  const inParty = s.settings.mode === 'party';
  const venue = roomDef(s.settings.room);
  const out: HTMLElement[] = [];

  /* mode — the one control that changes what you are looking at */

  const modeBtn = el(
    'button',
    { type: 'button', class: 'btn btn--primary' },
    inParty ? 'BACK TO YOUR ROOM' : `GO TO THE ${venue.label}`,
  );
  const short = !inParty && !isReady(party);
  modeBtn.disabled = short;
  modeBtn.addEventListener('click', () => {
    audio.blip();
    game.setMode(inParty ? 'solo' : 'party');
    announce(inParty ? 'Back in your room' : `In the ${venue.label.toLowerCase()}`);
    rerender();
  });

  out.push(
    section(
      venue.label,
      el('p', {
        class: 'note',
        text: inParty
          ? `everyone studies to the same clock, and every minute feeds the ${venue.theme.hearth.name}.`
          : short
            // A disabled button with no explanation is a dead end. Say what is missing and what
            // to do about it, in the same breath — and the two things that can be missing are
            // different sentences.
            ? hostMember(party) === null
              ? `${venue.blurb}. take your seat first — a party you are not in is not your party.`
              : `${venue.blurb}. a party is other people — you need at least ${MIN_PARTY - party.members.length} more ${party.members.length === MIN_PARTY - 1 ? 'person' : 'people'} before you can go.`
            : `${venue.blurb}. everyone is here — head over whenever you like.`,
      }),
      modeBtn,
    ),
  );

  /* venue — the rooms you own. Locked ones are bought up in MORE ROOMS. */

  const venueList = el('div', { class: 'scenes__list' });
  for (const id of ROOM_ORDER) {
    if (!s.unlocks.rooms.includes(id)) continue;
    const def = ROOMS[id];
    const current = s.settings.room === id;
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'scene-btn',
        'data-locked': 'false',
        'aria-current': current ? 'true' : 'false',
        'aria-label': `Meet in the ${def.label.toLowerCase()} — ${def.blurb}`,
      },
      el('span', { 'aria-hidden': 'true', text: def.icon }),
      el('span', { text: def.label }),
    );
    btn.addEventListener('click', () => {
      audio.blip();
      game.setRoom(id);
      announce(`The party meets in the ${def.label.toLowerCase()}`);
      rerender();
    });
    venueList.appendChild(btn);
  }
  out.push(
    section(
      'WHERE YOU MEET',
      venueList,
      el('p', { class: 'note', text: 'every room seats the whole party — it grows with you wherever you go.' }),
    ),
  );

  /* bonfire */

  if (party.members.length > 0) {
    out.push(hearthSection(party, undefined, venue, `${party.cheers} cheer${party.cheers === 1 ? '' : 's'} sent — tap any cat to send one.`));
  }

  /* roster */

  const roster = section('WHO IS HERE');
  if (party.members.length === 0) {
    roster.appendChild(
      emptyState('🪑', 'THE CIRCLE IS EMPTY', 'add a player below. everyone brings exactly one cat.'),
    );
  } else {
    for (const member of party.members) {
      const local = member.catId ? s.cats.find((c) => c.id === member.catId) : undefined;
      const cat = local ?? member.guest;
      const breed = cat ? BREEDS[cat.breed] : null;
      const dressed = cat ? outfitSize(cat.outfit) : 0;

      const nameInput = el('input', {
        type: 'text',
        value: member.playerName,
        maxlength: String(MAX_PLAYER_NAME),
        'aria-label': `Player name for ${cat?.name ?? 'this cat'}`,
      });
      nameInput.addEventListener('change', () => {
        game.renamePlayer(member.id, nameInput.value);
        rerender();
      });

      const leave = el('button', { type: 'button', class: 'btn btn--ghost' }, 'LEAVE');
      leave.setAttribute('aria-label', `Remove ${member.playerName} from the circle`);
      leave.addEventListener('click', () => {
        audio.blip();
        game.removePlayer(member.id);
        rerender();
      });

      roster.appendChild(
        el(
          'div',
          { class: 'quest' },
          el(
            'div',
            { class: 'quest__row' },
            el('span', { class: 'card__name' }, swatch(breed?.body), partyLabel(cat?.name ?? 'Cat', member.playerName)),
            el('span', { class: 'quest__reward', text: member.guest ? 'guest' : `${dressed}/4 worn` }),
          ),
          el('div', { class: 'field__row' }, nameInput, leave),
        ),
      );
    }
  }
  out.push(roster);

  /* add local */

  const host = hostMember(party);
  const full = party.members.length >= MAX_PARTY;

  // You bring ONE cat. The panel says so by simply not offering the control again once your
  // seat is taken — a disabled button you can never enable is worse than no button.
  const addSection = section('YOUR CAT');
  if (host) {
    const hostCat = host.catId ? s.cats.find((c) => c.id === host.catId) : undefined;
    addSection.appendChild(
      el('p', {
        class: 'note',
        text: `${hostCat ? hostCat.name : 'your cat'} is representing you. one cat each — everyone else joins with a card.`,
      }),
    );
    const swap = el('button', { type: 'button', class: 'btn btn--ghost' }, 'BRING A DIFFERENT CAT');
    swap.addEventListener('click', () => {
      audio.blip();
      game.removePlayer(host.id);
      rerender();
    });
    addSection.appendChild(swap);
  } else if (full) {
    addSection.appendChild(
      emptyState('🎟', 'THE PARTY IS FULL', `${MAX_PARTY} seats, ${MAX_PARTY} cats. someone has to head home first.`),
    );
  } else if (s.cats.length === 0) {
    addSection.appendChild(emptyState('🐈', 'NO CATS YET', 'adopt a cat first — you bring exactly one.'));
  } else {
    const nameInput = el('input', {
      type: 'text',
      placeholder: 'player name',
      maxlength: String(MAX_PLAYER_NAME),
      'aria-label': 'New player name',
    });
    const catSelect = el('select', { 'aria-label': 'Which cat are they bringing' });
    for (const cat of s.cats) {
      catSelect.appendChild(el('option', { value: cat.id, text: `${cat.name} · ${BREEDS[cat.breed].name}` }));
    }
    const error = el('p', { class: 'error', hidden: true, role: 'alert' });
    const addBtn = el('button', { type: 'button', class: 'btn btn--primary' }, 'TAKE YOUR SEAT');
    addBtn.addEventListener('click', () => {
      const result = game.addPlayer(nameInput.value, { catId: catSelect.value });
      if (result.ok) {
        audio.purchase();
        rerender();
      } else {
        audio.blip();
        error.hidden = false;
        error.textContent = result.error ?? 'that did not work';
        nameInput.focus();
      }
    });

    addSection.appendChild(el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'NAME' }), nameInput));
    addSection.appendChild(el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'CAT' }), catSelect));
    addSection.appendChild(error);
    addSection.appendChild(addBtn);
  }
  out.push(addSection);

  /* cat cards */

  const cards = section('BRING A FRIEND’S CAT');
  const cardInput = el('textarea', { 'aria-label': 'Cat card from a friend', spellcheck: 'false', placeholder: 'CAT1.…' });
  const guestName = el('input', {
    type: 'text',
    placeholder: 'their name',
    maxlength: String(MAX_PLAYER_NAME),
    'aria-label': 'Name of the friend whose cat this is',
  });
  const cardError = el('p', { class: 'error', hidden: true, role: 'alert' });

  const bringBtn = el('button', { type: 'button', class: 'btn btn--primary' }, 'SEAT THEM');
  bringBtn.disabled = full;
  bringBtn.addEventListener('click', () => {
    const result = game.bringGuest(guestName.value, cardInput.value);
    if (result.ok) {
      audio.purchase();
      rerender();
    } else {
      audio.blip();
      cardError.hidden = false;
      cardError.textContent = result.error ?? 'that card could not be read';
    }
  });

  cards.appendChild(el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'THEIR NAME' }), guestName));
  cards.appendChild(el('div', { class: 'field' }, cardInput));
  cards.appendChild(cardError);
  cards.appendChild(bringBtn);

  if (s.cats.length > 0) {
    const shareSelect = el('select', { 'aria-label': 'Which of your cats to share' });
    for (const cat of s.cats) {
      shareSelect.appendChild(el('option', { value: cat.id, text: cat.name }));
    }
    const shareOut = el('textarea', { 'aria-label': 'Your cat card', spellcheck: 'false', readonly: 'true' });
    const shareBtn = el('button', { type: 'button', class: 'btn' }, 'MAKE A CARD');
    shareBtn.addEventListener('click', () => {
      audio.blip();
      const code = game.catCardFor(shareSelect.value);
      shareOut.value = code ?? '';
      shareOut.focus();
      shareOut.select();
      announce('Cat card ready — copy it and send it to a friend.');
    });
    cards.appendChild(
      el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'SEND ONE OF YOURS' }), shareSelect),
    );
    cards.appendChild(shareBtn);
    cards.appendChild(el('div', { class: 'field' }, shareOut));
  }
  out.push(cards);

  return out;
}

/* ----------------------------------------------------------------- forget */

/**
 * "Delete my account", for a product with no accounts: the server drops the player row and the
 * device drops its key. Two taps, four seconds apart at most, so a stray thumb cannot do it.
 */
function forgetSection(game: Game, rerender: () => void, disabled: boolean): HTMLElement {
  const armed = Date.now() < forgetArmedUntil;
  const btn = el('button', { type: 'button', id: 'party-forget', class: 'btn btn--quiet' }, armed ? 'TAP AGAIN TO FORGET' : 'FORGET ME ON THE SERVER');
  btn.disabled = disabled;

  btn.addEventListener('click', () => {
    audio.blip();
    const now = Date.now();
    if (now >= forgetArmedUntil) {
      forgetArmedUntil = now + FORGET_ARM_MS;
      btn.textContent = 'TAP AGAIN TO FORGET';
      announce('tap again within four seconds to forget');
      globalThis.setTimeout(() => {
        if (Date.now() < forgetArmedUntil) return; // re-armed since
        if (btn.isConnected) btn.textContent = 'FORGET ME ON THE SERVER';
      }, FORGET_ARM_MS);
      return;
    }
    forgetArmedUntil = 0;
    actionError = null;
    run(btn, () => game.forgetMeOnline(), () => announce('forgotten'), rerender);
  });

  return el(
    'div',
    { class: 'party-forget' },
    btn,
    el('p', {
      class: 'note',
      text: disabled
        ? 'leave the party first — then this deletes your player row and this device’s key.'
        : 'deletes your player row on the server and this device’s key. your save stays here.',
    }),
  );
}
