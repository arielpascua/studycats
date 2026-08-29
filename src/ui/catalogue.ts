/**
 * The Cat-alogue: a Pokédex-style book of breeds, snacks tasted, visitors met, tricks seen and
 * achievements earned. Locked entries are silhouettes with a hint — never blank, never a
 * teasing lock icon with no information.
 */

import { ACHIEVEMENTS } from '../data/achievements';
import { BREEDS, BREED_ORDER } from '../data/breeds';
import { SNACKS, SNACK_ORDER } from '../data/snacks';
import { VISITORS, VISITOR_ORDER } from '../data/visitors';
import { TRICK_NAMES } from '../scene/cats/catAnimator';
import type { Game } from '../store';
import { el, section } from './dom';

function entry(opts: { name: string; blurb: string; locked: boolean; swatch?: string; icon?: string }): HTMLElement {
  return el(
    'div',
    { class: 'entry', 'data-locked': opts.locked ? 'true' : 'false' },
    el(
      'div',
      { class: 'entry__name' },
      opts.swatch
        ? el('span', {
            class: 'card__swatch',
            style: `background:${opts.locked ? '#9C88A4' : opts.swatch};width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:6px`,
            'aria-hidden': 'true',
          })
        : el('span', { 'aria-hidden': 'true', text: `${opts.locked ? '❓' : opts.icon ?? '•'} ` }),
      opts.locked ? '???' : opts.name,
    ),
    el('div', { class: 'entry__blurb', text: opts.blurb }),
  );
}

export function buildCataloguePanel(game: Game): HTMLElement {
  const s = game.getState();
  const body = el('div', { class: 'panel__body' });

  const seenBreeds = new Set([...s.unlocks.breeds, ...s.cats.map((c) => c.breed)]);
  const tastedSnacks = new Set(s.unlocks.snacksTasted);
  const metVisitors = new Set(s.unlocks.visitors);
  const seenTricks = new Set(s.unlocks.tricksSeen);
  const earned = new Set(s.unlocks.achievements);

  body.appendChild(
    el('p', {
      class: 'note',
      text: `${seenBreeds.size}/${BREED_ORDER.length} breeds · ${tastedSnacks.size}/${SNACK_ORDER.length} snacks · ${metVisitors.size}/${VISITOR_ORDER.length} visitors · ${earned.size}/${ACHIEVEMENTS.length} achievements`,
    }),
  );

  body.appendChild(
    section(
      'BREEDS',
      el(
        'div',
        { class: 'grid-2' },
        ...BREED_ORDER.map((id) => {
          const breed = BREEDS[id];
          const known = seenBreeds.has(id);
          return entry({
            name: breed.name,
            blurb: known ? breed.blurb : breed.unlockHint ?? `${breed.rare ? 'a rare one' : 'adopt from the shop'}`,
            locked: !known,
            swatch: breed.body,
          });
        }),
      ),
    ),
  );

  body.appendChild(
    section(
      'SNACKS TASTED',
      el(
        'div',
        { class: 'grid-2' },
        ...SNACK_ORDER.map((id) => {
          const def = SNACKS[id];
          const tasted = tastedSnacks.has(id);
          return entry({
            name: def.name,
            blurb: tasted ? 'a cat has eaten one' : 'not yet tasted',
            locked: !tasted,
            icon: def.icon,
          });
        }),
      ),
    ),
  );

  body.appendChild(
    section(
      'VISITORS',
      el(
        'div',
        { class: 'grid-2' },
        ...VISITOR_ORDER.map((id) => {
          const def = VISITORS[id];
          const met = metVisitors.has(id);
          return entry({
            name: def.name,
            blurb: met ? def.blurb : 'shows up at the edge sometimes',
            locked: !met,
            icon: def.icon,
          });
        }),
      ),
    ),
  );

  const trickIds = Object.values(TRICK_NAMES);
  body.appendChild(
    section(
      'TRICKS SEEN',
      el(
        'div',
        { class: 'grid-2' },
        ...trickIds.map((name) =>
          entry({
            name,
            blurb: seenTricks.has(name) ? 'you have seen this one' : 'bond with a cat, then double-click',
            locked: !seenTricks.has(name),
            icon: '✨',
          }),
        ),
      ),
    ),
  );

  body.appendChild(
    section(
      'ACHIEVEMENTS',
      ...ACHIEVEMENTS.map((a) => {
        const got = earned.has(a.id);
        return el(
          'div',
          { class: 'entry', 'data-locked': got ? 'false' : 'true' },
          el('div', { class: 'entry__name', text: `${got ? a.icon : '❓'} ${got || !a.secret ? a.title : '???'}` }),
          el('div', { class: 'entry__blurb', text: got || !a.secret ? a.description : 'something is hidden here' }),
        );
      }),
    ),
  );

  return body;
}
