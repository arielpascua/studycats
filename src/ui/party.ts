/**
 * The Party panel: who is in the arena, how the shared fire is doing, and how to bring in a cat
 * that lives on somebody else's device.
 *
 * The mode switch is the first thing in the panel because it is the only control here that
 * changes what you are looking at; everything below it is roster management.
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
} from '../core/party';
import { BREEDS } from '../data/breeds';
import { ROOMS, ROOM_ORDER, roomDef } from '../data/rooms';
import { bus } from '../core/events';
import { outfitSize } from '../data/cosmetics';
import type { Game } from '../store';
import { audio } from '../audio/engine';
import { announce, el, emptyState, section } from './dom';

export function buildPartyPanel(game: Game, rerender: () => void): HTMLElement {
  const s = game.getState();
  const party = s.party;
  const body = el('div', { class: 'panel__body' });
  const inParty = s.settings.mode === 'party';
  const venue = roomDef(s.settings.room);

  /* --------------------------------------------------------------- mode */

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

  body.appendChild(
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

  /* ---------------------------------------------------------------- venue */

  // The party can meet anywhere it has unlocked. Each venue is a different scene rather than a
  // reskin, so this is the one control in the panel that changes the whole picture.
  const venueList = el('div', { class: 'scenes__list' });
  for (const id of ROOM_ORDER) {
    const def = ROOMS[id];
    const owned = s.unlocks.rooms.includes(id);
    const current = s.settings.room === id;
    const btn = el(
      'button',
      {
        type: 'button',
        class: 'scene-btn',
        'data-locked': owned ? 'false' : 'true',
        'aria-current': current ? 'true' : 'false',
        'aria-label': owned
          ? `Meet in the ${def.label.toLowerCase()} — ${def.blurb}`
          : `${def.label} — locked, ${def.price} fish coins`,
      },
      el('span', { 'aria-hidden': 'true', text: def.icon }),
      el('span', { text: def.label }),
      owned ? null : el('span', { class: 'scene-btn__price', text: `${def.price} 🐟` }),
    );
    btn.addEventListener('click', () => {
      audio.blip();
      if (owned) {
        game.setRoom(id);
        announce(`The party meets in the ${def.label.toLowerCase()}`);
      } else if (game.buyRoom(id)) {
        game.setRoom(id);
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
    venueList.appendChild(btn);
  }

  body.appendChild(
    section(
      'WHERE YOU MEET',
      venueList,
      el('p', {
        class: 'note',
        text: 'every room seats the whole party — it grows with you wherever you go.',
      }),
    ),
  );

  /* ------------------------------------------------------------ bonfire */

  if (party.members.length > 0) {
    const progress = bonfireProgress(party.sharedMinutes, party.members.length);
    const pct = Math.round(((progress.stage + progress.into) / BONFIRE_STAGES) * 100);
    body.appendChild(
      section(
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
        el('p', {
          class: 'note',
          text: `${party.cheers} cheer${party.cheers === 1 ? '' : 's'} sent — tap any cat to send one.`,
        }),
      ),
    );
  }

  /* ------------------------------------------------------------- roster */

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
            el(
              'span',
              { class: 'card__name' },
              breed
                ? el('span', {
                    class: 'card__swatch',
                    style: `background:${breed.body};width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:6px`,
                    'aria-hidden': 'true',
                  })
                : null,
              partyLabel(cat?.name ?? 'Cat', member.playerName),
            ),
            el('span', {
              class: 'quest__reward',
              text: member.guest ? 'guest' : `${dressed}/4 worn`,
            }),
          ),
          el('div', { class: 'field__row' }, nameInput, leave),
        ),
      );
    }
  }
  body.appendChild(roster);

  /* ---------------------------------------------------------- add local */

  const host = hostMember(party);
  const availableCats = s.cats;
  const full = party.members.length >= MAX_PARTY;

  // You bring ONE cat. The panel says so by simply not offering the control again once your
  // seat is taken — a disabled button you can never enable is worse than no button.
  const addSection = section('YOUR CAT');
  if (host) {
    const hostCat = host.catId ? s.cats.find((c) => c.id === host.catId) : undefined;
    addSection.appendChild(
      el('p', {
        class: 'note',
        text: `${hostCat ? hostCat.name : 'your cat'} is representing you. one cat each — everyone else joins with a code.`,
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
  } else if (availableCats.length === 0) {
    addSection.appendChild(emptyState('🐈', 'NO CATS YET', 'adopt a cat first — you bring exactly one.'));
  } else {
    const nameInput = el('input', {
      type: 'text',
      placeholder: 'player name',
      maxlength: String(MAX_PLAYER_NAME),
      'aria-label': 'New player name',
    });
    const catSelect = el('select', { 'aria-label': 'Which cat are they bringing' });
    for (const cat of availableCats) {
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
  body.appendChild(addSection);

  /* --------------------------------------------------------- cat cards */

  const cards = section('BRING A FRIEND’S CAT');
  cards.appendChild(
    el('p', {
      class: 'note',
      text: 'a cat card is a short code carrying one cat and what it is wearing. nothing else travels — no account, no scores, nothing leaves this device unless you paste it somewhere.',
    }),
  );

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

  body.appendChild(cards);
  return body;
}
