/**
 * The shop: adoptions, snacks, furniture, worlds, radio stations.
 *
 * The affordability state is the interesting part (DESIGN.md §7): an item you can't afford is
 * never a bare disabled button — it dims, its price chip turns to the muted brick tone, and the
 * panel explains how coins are earned. Wanting something you can't buy yet is the point.
 */

import { BREEDS, BREED_ORDER, isAdoptable } from '../data/breeds';
import { ENVIRONMENTS, ENVIRONMENT_ORDER } from '../data/environments';
import { FURNITURE, FURNITURE_ORDER, SLOTS, SLOT_LABEL, allowedIn, fitsSlot, type SlotId } from '../data/furniture';
import { SNACKS, SNACK_ORDER } from '../data/snacks';
import { RADIO_STATIONS } from '../audio/engine';
import type { Game } from '../store';
import { audio } from '../audio/engine';
import { card, el, emptyState, section } from './dom';

export function buildShopPanel(game: Game, rerender: () => void): HTMLElement {
  const s = game.getState();
  const coins = s.economy.coins;
  const body = el('div', { class: 'panel__body' });

  const afford = (price: number) => coins >= price;

  function buy(action: () => boolean): void {
    if (action()) {
      audio.purchase();
      rerender();
    } else {
      audio.blip();
    }
  }

  /* ------------------------------------------------------------ adoption */

  const adoptable = BREED_ORDER.map((id) => BREEDS[id]).filter(isAdoptable);
  const adoptCards = adoptable.map((breed) => {
    const owned = s.cats.some((c) => c.breed === breed.id);
    const price = breed.price;
    return card({
      swatch: breed.body,
      name: breed.name,
      blurb: owned ? `already home · ${breed.blurb}` : breed.blurb,
      price: price === 0 ? 'free' : `${price} 🐟`,
      affordable: afford(price),
      ariaLabel: `Adopt ${breed.name}, ${price === 0 ? 'free' : `${price} fish coins`}${afford(price) ? '' : ' — not enough coins'}`,
      onClick: () =>
        buy(() => {
          const result = game.adoptCat(breed.id);
          return result.ok;
        }),
    });
  });

  body.appendChild(
    section(
      'ADOPT A CAT',
      el('p', { class: 'note', text: `you have ${coins} 🐟. a cat costs what it costs; nobody is going anywhere.` }),
      ...adoptCards,
    ),
  );

  const lockedRares = BREED_ORDER.map((id) => BREEDS[id]).filter((b) => !isAdoptable(b) && !s.unlocks.breeds.includes(b.id));
  if (lockedRares.length > 0) {
    body.appendChild(
      section(
        'NOT FOR SALE',
        ...lockedRares.map((breed) =>
          card({
            icon: '❓',
            name: '???',
            blurb: breed.unlockHint ?? 'arrives its own way',
            disabled: true,
            affordable: false,
          }),
        ),
      ),
    );
  }

  /* --------------------------------------------------------------- snacks */

  const lockedSnacks = SNACK_ORDER.filter((id) => !s.unlocks.snacks.includes(id));
  body.appendChild(
    section(
      'SNACKS',
      lockedSnacks.length === 0
        ? emptyState('🍙', 'THE WHOLE MENU', 'every snack is in the rotation. the cats have opinions about all of them.')
        : null,
      ...lockedSnacks.map((id) => {
        const def = SNACKS[id];
        return card({
          icon: def.icon,
          name: def.name,
          blurb: 'added to the break-time rotation',
          price: `${def.price} 🐟`,
          affordable: afford(def.price),
          onClick: () => buy(() => game.buySnack(id)),
        });
      }),
    ),
  );

  /* ------------------------------------------------------------- worlds */

  const lockedWorlds = ENVIRONMENT_ORDER.filter((id) => !s.unlocks.environments.includes(id));
  if (lockedWorlds.length > 0) {
    body.appendChild(
      section(
        'PLACES TO STUDY',
        ...lockedWorlds.map((id) => {
          const def = ENVIRONMENTS[id];
          return card({
            icon: def.icon,
            name: def.label,
            blurb: def.blurb,
            price: `${def.price} 🐟`,
            affordable: afford(def.price),
            onClick: () => buy(() => game.buyEnvironment(id)),
          });
        }),
      ),
    );
  }

  /* ---------------------------------------------------------- furniture */

  const env = s.settings.environment;
  const placements = s.unlocks.placements[env] ?? {};
  const forSale = FURNITURE_ORDER.filter((id) => !s.unlocks.furniture.includes(id) && allowedIn(id, env));

  body.appendChild(
    section(
      'FURNITURE',
      forSale.length === 0
        ? emptyState('🪑', 'NOTHING LEFT TO BUY', 'you own everything that fits in here. try another world.')
        : null,
      ...forSale.map((id) => {
        const def = FURNITURE[id];
        return card({
          swatch: def.colorA,
          name: def.name,
          blurb: def.blurb,
          price: `${def.price} 🐟`,
          affordable: afford(def.price),
          onClick: () => buy(() => game.buyFurniture(id)),
        });
      }),
    ),
  );

  /* ------------------------------------------------------------ placement */

  const owned = s.unlocks.furniture.filter((id) => allowedIn(id, env));
  const placementSection = section('PUT IT SOMEWHERE');
  if (owned.length === 0) {
    placementSection.appendChild(
      emptyState('📦', 'NOTHING DELIVERED YET', 'buy a rug or a cushion above, then drop it into a spot here.'),
    );
  } else {
    for (const slot of SLOTS) {
      const options = owned.filter((id) => fitsSlot(id, slot));
      if (options.length === 0) continue;
      const current = placements[slot] ?? '';

      const select = el('select', { 'aria-label': `What goes in the ${SLOT_LABEL[slot].toLowerCase()}` });
      select.appendChild(el('option', { value: '', text: '— empty —' }));
      for (const id of options) {
        const option = el('option', { value: id, text: FURNITURE[id].name });
        if (id === current) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        audio.blip();
        game.placeFurniture(select.value || null, slot as SlotId);
        rerender();
      });

      placementSection.appendChild(
        el(
          'label',
          { class: 'field' },
          el('span', { class: 'field__label', text: SLOT_LABEL[slot] }),
          el('div', { class: 'field__row' }, select),
        ),
      );
    }
  }
  body.appendChild(placementSection);

  /* ---------------------------------------------------------------- radio */

  const lockedRadio = RADIO_STATIONS.filter((r) => !s.unlocks.radio.includes(r.id));
  if (lockedRadio.length > 0) {
    body.appendChild(
      section(
        'RADIO',
        ...lockedRadio.map((station) =>
          card({
            icon: '📻',
            name: station.name,
            blurb: station.blurb,
            price: `${station.price} 🐟`,
            affordable: afford(station.price),
            onClick: () => buy(() => game.buyRadio(station.id)),
          }),
        ),
      ),
    );
  }

  body.appendChild(
    el('p', {
      class: 'note',
      text: 'nothing here costs real money, and it never will. coins come from finishing sessions.',
    }),
  );

  return body;
}
