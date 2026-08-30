/**
 * Panel manager plus the Cats and Setup panels.
 *
 * One panel at a time, `Esc` always closes, focus moves in on open and returns to the trigger
 * on close. Panels are rebuilt from state on every open rather than diffed — at this size that
 * is both simpler and impossible to desync.
 */

import { bondProgress } from '../core/economy';
import { BREEDS } from '../data/breeds';
import { RADIO_STATIONS, audio } from '../audio/engine';
import type { Game } from '../store';
import { resolveReducedMotion } from '../store';
import { buildCataloguePanel } from './catalogue';
import { buildPartyPanel } from './party';
import { COSMETIC_SLOTS, SLOT_LABEL as COSMETIC_SLOT_LABEL, cosmeticsInSlot } from '../data/cosmetics';
import { buildShopPanel } from './shop';
import { buildStatsPanel } from './stats';
import { announce, card, clear, collapsibleSection, el, emptyState, field, qs, qsa, section, slider, toggle } from './dom';
import { bus } from '../core/events';

export interface PanelHost {
  open(id: string): void;
  close(): void;
  toggle(id: string): void;
  isOpen(): boolean;
  rerender(): void;
  dispose(): void;
}

const TITLES: Record<string, string> = {
  party: 'PARTY',
  cats: 'YOUR CATS',
  shop: 'SHOP',
  stats: 'STATS',
  catalogue: 'CAT-ALOGUE',
  settings: 'SETUP',
};

export interface PanelDeps {
  game: Game;
  onMotionChange(reduced: boolean): void;
  onPixelScale(scale: number): void;
  onBloom(value: number): void;
  onShadows(enabled: boolean): void;
  onPhotoMode(): void;
}

export function mountPanels(container: HTMLElement, deps: PanelDeps): PanelHost {
  const { game } = deps;
  let current: string | null = null;
  let lastTrigger: HTMLElement | null = null;

  function buildBody(id: string): HTMLElement {
    switch (id) {
      case 'shop':
        return buildShopPanel(game, () => rerender());
      case 'stats':
        return buildStatsPanel(game);
      case 'catalogue':
        return buildCataloguePanel(game);
      case 'party':
        return buildPartyPanel(game, () => rerender());
      case 'settings':
        return buildSettingsPanel(deps, () => rerender());
      case 'cats':
      default:
        return buildCatsPanel(game, () => rerender());
    }
  }

  function render(): void {
    clear(container);
    if (!current) return;

    const panel = el('section', {
      class: 'panel',
      role: 'dialog',
      'aria-modal': 'false',
      'aria-label': TITLES[current] ?? current,
    });

    const closeBtn = el('button', { type: 'button', class: 'panel__close', 'aria-label': 'Close this panel' }, '✕');
    closeBtn.addEventListener('click', () => close());

    panel.appendChild(
      el(
        'div',
        { class: 'panel__head' },
        el('h2', { class: 'panel__title', text: TITLES[current] ?? current }),
        closeBtn,
      ),
    );
    panel.appendChild(buildBody(current));
    container.appendChild(panel);

    // Focus the panel's first control so keyboard users land inside it.
    const first = panel.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]');
    first?.focus();
  }

  function rerender(): void {
    if (current) render();
  }

  function setExpanded(): void {
    for (const btn of qsa<HTMLButtonElement>('[data-panel]')) {
      btn.setAttribute('aria-expanded', btn.dataset.panel === current ? 'true' : 'false');
    }
  }

  function open(id: string): void {
    lastTrigger = (document.activeElement as HTMLElement) ?? null;
    current = id;
    render();
    setExpanded();
    announce(`${TITLES[id] ?? id} open`);
  }

  function close(): void {
    if (!current) return;
    current = null;
    clear(container);
    setExpanded();
    lastTrigger?.focus();
    lastTrigger = null;
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && current) {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  const triggers = qsa<HTMLButtonElement>('[data-panel]');
  const triggerHandlers: Array<() => void> = [];
  for (const btn of triggers) {
    const handler = (): void => {
      audio.blip();
      const id = btn.dataset.panel ?? 'cats';
      if (current === id) close();
      else open(id);
    };
    btn.addEventListener('click', handler);
    triggerHandlers.push(() => btn.removeEventListener('click', handler));
  }

  // Panels that show live numbers refresh themselves when those numbers move.
  const unsubs = [
    bus.on('economy:coins', () => {
      if (current === 'shop' || current === 'stats') rerender();
    }),
    bus.on('cat:bond', () => {
      if (current === 'cats') rerender();
    }),
  ];

  return {
    open,
    close,
    toggle: (id) => (current === id ? close() : open(id)),
    isOpen: () => current !== null,
    rerender,
    dispose() {
      document.removeEventListener('keydown', onKey);
      for (const off of triggerHandlers) off();
      for (const un of unsubs) un();
      clear(container);
    },
  };
}

/* ------------------------------------------------------------------- cats */

/**
 * Which parts of the cats panel are open, remembered across rerenders.
 *
 * Renaming a cat or equipping a hat rebuilds the whole panel, so without this every wardrobe
 * change would slam the cat you were dressing shut again. Keyed by cat id, not by index, so
 * sending one home does not reshuffle everyone else's state.
 */
const catsOpen = new Map<string, boolean>();

function buildCatsPanel(game: Game, rerender: () => void): HTMLElement {
  const s = game.getState();
  const body = el('div', { class: 'panel__body' });

  const quests = game.quests();
  const questRows: Array<Node | null> = [];
  if (quests.length === 0) {
    questRows.push(emptyState('📋', 'NO QUESTS YET', 'three show up each morning. come back tomorrow.'));
  } else {
    for (const q of quests) {
      const pct = Math.round((q.progress / q.goal) * 100);
      questRows.push(
        el(
          'div',
          { class: 'quest', 'data-done': q.complete ? 'true' : 'false' },
          el(
            'div',
            { class: 'quest__row' },
            el('span', { text: q.def.title }),
            el('span', { class: 'quest__reward', text: q.claimed ? 'claimed' : `+${q.def.reward} 🐟` }),
          ),
          el(
            'div',
            {
              class: 'quest__bar',
              role: 'progressbar',
              'aria-valuenow': String(q.progress),
              'aria-valuemin': '0',
              'aria-valuemax': String(q.goal),
              'aria-label': q.def.title,
            },
            el('div', { class: 'quest__fill', style: `width:${pct}%` }),
          ),
        ),
      );
    }
    const claimable = quests.some((q) => q.complete && !q.claimed);
    const claimBtn = el('button', { type: 'button', class: 'btn btn--primary' }, claimable ? 'CLAIM REWARDS' : 'NOTHING TO CLAIM');
    claimBtn.disabled = !claimable;
    claimBtn.addEventListener('click', () => {
      audio.purchase();
      game.claimQuests();
      rerender();
    });
    questRows.push(claimBtn);
  }

  const unclaimed = quests.filter((q) => q.complete && !q.claimed).length;
  body.appendChild(
    collapsibleSection(
      'TODAY',
      {
        // A collapsed quest list still has to shout when there is a reward waiting, or folding
        // it away would quietly cost you coins.
        badge: unclaimed > 0 ? `${unclaimed} ready` : String(quests.length),
        open: catsOpen.get('TODAY') !== false,
        onToggle: (open) => catsOpen.set('TODAY', open),
      },
      ...questRows,
    ),
  );

  const catRows: Array<Node | null> = [];
  for (const cat of s.cats) {
    const breed = BREEDS[cat.breed];
    const bond = bondProgress(cat.bondXp);

    const pips = el('div', { class: 'bond', role: 'img', 'aria-label': `Bond level ${bond.level} of 10` });
    for (let i = 0; i < 10; i++) {
      pips.appendChild(el('span', { class: 'bond__pip', 'data-on': i < bond.level ? 'true' : 'false' }));
    }

    const nameInput = el('input', {
      type: 'text',
      value: cat.name,
      maxlength: '16',
      'aria-label': `Name for this ${breed.name}`,
    });
    nameInput.addEventListener('change', () => {
      game.renameCat(cat.id, nameInput.value);
      rerender();
    });

    const sendHome = el('button', { type: 'button', class: 'btn btn--ghost' }, 'SEND HOME');
    sendHome.disabled = s.cats.length <= 1;
    sendHome.setAttribute(
      'aria-label',
      s.cats.length <= 1 ? 'Cannot send your last cat home' : `Send ${cat.name} home`,
    );
    sendHome.addEventListener('click', () => {
      audio.blip();
      if (game.sendHome(cat.id)) {
        bus.emit('toast', { title: 'SEE YOU SOON', body: `${cat.name} went home`, icon: '👋', tone: 'gentle' });
        rerender();
      }
    });

    // The wardrobe. Every slot is a select rather than a grid of tiles: four dropdowns fit in
    // the panel beside the cat they dress, and an outfit is a set of exclusive choices, which is
    // exactly what a select means.
    const wardrobe = el('div', { class: 'section' });
    wardrobe.appendChild(el('h4', { class: 'section__title', text: 'WEARING' }));
    for (const slot of COSMETIC_SLOTS) {
      const options = cosmeticsInSlot(slot);
      const select = el('select', { 'aria-label': `${COSMETIC_SLOT_LABEL[slot]} for ${cat.name}` });
      select.appendChild(el('option', { value: '', text: '— nothing —' }));
      for (const item of options) {
        const owned = s.unlocks.cosmetics.includes(item.id);
        const affordable = s.economy.coins >= item.price;
        const option = el('option', {
          value: item.id,
          text: owned ? item.name : `${item.name} — ${item.price} 🐟${affordable ? '' : ' (need more)'}`,
        });
        // An unaffordable item still shows, so you know what you are saving toward.
        option.disabled = !owned && !affordable;
        if (cat.outfit[slot] === item.id) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        const id = select.value;
        if (!id) {
          game.equipCosmetic(cat.id, slot, null);
          rerender();
          return;
        }
        // Buying and wearing are one gesture: picking something you do not own buys it.
        if (!game.getState().unlocks.cosmetics.includes(id)) {
          if (!game.buyCosmetic(id)) {
            audio.blip();
            rerender();
            return;
          }
        }
        game.equipCosmetic(cat.id, slot, id);
        audio.purchase();
        rerender();
      });
      wardrobe.appendChild(
        el(
          'label',
          { class: 'field' },
          el('span', { class: 'field__label', text: COSMETIC_SLOT_LABEL[slot] }),
          el('div', { class: 'field__row' }, select),
        ),
      );
    }

    // Every cat is its own disclosure. A cat card is a name field, ten bond pips, four wardrobe
    // dropdowns and a tricks line; six cats of that is a panel you scroll rather than read.
    // Collapsed, the section becomes a roster you can actually scan.
    catRows.push(
      collapsibleSection(
        cat.name,
        {
          level: 'h4',
          variant: 'section--nested',
          badge: `${breed.name} · ♥${bond.level}`,
          open: catsOpen.get(`cat:${cat.id}`) === true,
          onToggle: (open) => catsOpen.set(`cat:${cat.id}`, open),
        },
        el(
          'div',
          { class: 'quest' },
          el(
            'div',
            { class: 'quest__row' },
            el('span', { class: 'card__name', text: `${breed.name}` }),
            el('span', { class: 'quest__reward', text: `${cat.petCount} pets · ${cat.snacksEaten} snacks` }),
          ),
          pips,
          el('div', { class: 'field__row' }, nameInput, sendHome),
          wardrobe,
          cat.tricks.length > 0
            ? el('p', { class: 'note', text: `knows: ${cat.tricks.map((t) => t.replace('trick-', '')).join(', ')} — double-click to ask` })
            : el('p', { class: 'note', text: 'pet them to build a bond; tricks come at level 3' }),
        ),
      ),
    );
  }

  body.appendChild(
    collapsibleSection(
      'IN THE ROOM',
      {
        badge: String(s.cats.length),
        open: catsOpen.get('IN THE ROOM') !== false,
        onToggle: (open) => catsOpen.set('IN THE ROOM', open),
      },
      ...catRows,
    ),
  );

  body.appendChild(
    el('p', { class: 'note', text: 'click a cat to pet · drag to move them · double-click for a trick' }),
  );

  return body;
}

/* --------------------------------------------------------------- settings */

function buildSettingsPanel(deps: PanelDeps, rerender: () => void): HTMLElement {
  const { game } = deps;
  const s = game.getState();
  const body = el('div', { class: 'panel__body' });

  /* durations */
  const durations = section('POMODORO');
  const mk = (label: string, key: 'focusMin' | 'shortBreakMin' | 'longBreakMin' | 'roundsPerLongBreak', min: number, max: number) => {
    const input = el('input', { type: 'number', min: String(min), max: String(max), value: String(s.settings.timer[key]) });
    input.addEventListener('change', () => {
      game.updateTimerSettings({ [key]: Number(input.value) } as never);
      input.value = String(game.getState().settings.timer[key]);
    });
    return field(label, input);
  };
  durations.appendChild(mk('FOCUS (MIN)', 'focusMin', 1, 120));
  durations.appendChild(mk('SHORT BREAK (MIN)', 'shortBreakMin', 1, 60));
  durations.appendChild(mk('LONG BREAK (MIN)', 'longBreakMin', 1, 60));
  durations.appendChild(mk('SESSIONS BEFORE A LONG BREAK', 'roundsPerLongBreak', 2, 8));
  durations.appendChild(
    toggle('start the next session automatically', s.settings.timer.autoStart, (value) => {
      game.updateTimerSettings({ autoStart: value });
    }),
  );
  body.appendChild(durations);

  /* look */
  const look = section('LOOK');
  look.appendChild(
    slider({
      label: 'CRISP ↔ CHUNKY',
      min: 1,
      max: 6,
      value: s.settings.pixelScale,
      format: (v) => (v === 1 ? 'crisp' : v >= 5 ? 'chunky' : String(v)),
      onInput: (v) => {
        game.setSetting('pixelScale', v);
        deps.onPixelScale(v);
      },
    }),
  );
  look.appendChild(
    slider({
      label: 'GLOW',
      min: 0,
      max: 100,
      value: Math.round(s.settings.bloom * 100),
      format: (v) => `${v}%`,
      onInput: (v) => {
        game.setSetting('bloom', v / 100);
        deps.onBloom(v / 100);
      },
    }),
  );
  look.appendChild(
    toggle('shadows', s.settings.showShadows, (value) => {
      game.setSetting('showShadows', value);
      deps.onShadows(value);
    }),
  );

  const motionSelect = el('select', { 'aria-label': 'Motion' });
  for (const [value, label] of [
    ['auto', 'follow my system setting'],
    ['full', 'full motion'],
    ['reduced', 'calm — no sway, no particles'],
  ] as const) {
    const option = el('option', { value, text: label });
    if (s.settings.motion === value) option.selected = true;
    motionSelect.appendChild(option);
  }
  motionSelect.addEventListener('change', () => {
    const value = motionSelect.value as 'auto' | 'full' | 'reduced';
    game.setSetting('motion', value);
    deps.onMotionChange(resolveReducedMotion(value));
  });
  look.appendChild(field('MOTION', motionSelect));

  const photoBtn = el('button', { type: 'button', class: 'btn btn--primary' }, '📷 PHOTO MODE');
  photoBtn.addEventListener('click', () => {
    audio.blip();
    deps.onPhotoMode();
  });
  look.appendChild(photoBtn);
  body.appendChild(look);

  /* sound */
  const sound = section('SOUND');
  sound.appendChild(
    toggle('mute everything', s.settings.muted, (value) => {
      game.setSetting('muted', value);
      audio.applySettings({ muted: value });
    }),
  );
  const mkVol = (label: string, key: 'master' | 'music' | 'ambience' | 'sfx') =>
    slider({
      label,
      min: 0,
      max: 100,
      value: Math.round(s.settings.volume[key] * 100),
      format: (v) => `${v}%`,
      onInput: (v) => {
        const volume = { ...game.getState().settings.volume, [key]: v / 100 };
        game.setSetting('volume', volume);
        audio.applySettings(volume);
      },
    });
  sound.appendChild(mkVol('MASTER', 'master'));
  sound.appendChild(mkVol('MUSIC', 'music'));
  sound.appendChild(mkVol('AMBIENCE', 'ambience'));
  sound.appendChild(mkVol('EFFECTS', 'sfx'));

  const stationSelect = el('select', { 'aria-label': 'Radio station' });
  for (const station of RADIO_STATIONS) {
    const owned = s.unlocks.radio.includes(station.id);
    const option = el('option', { value: station.id, text: owned ? station.name : `${station.name} — locked` });
    option.disabled = !owned;
    if (s.settings.radio === station.id) option.selected = true;
    stationSelect.appendChild(option);
  }
  stationSelect.addEventListener('change', () => {
    game.setSetting('radio', stationSelect.value);
    audio.setStation(stationSelect.value);
  });
  sound.appendChild(field('RADIO', stationSelect));
  body.appendChild(sound);

  /* save */
  const save = section('YOUR SAVE');
  const textarea = el('textarea', { 'aria-label': 'Save data', spellcheck: 'false' });
  const error = el('p', { class: 'error', hidden: true, role: 'alert' });

  const exportBtn = el('button', { type: 'button', class: 'btn' }, 'EXPORT');
  exportBtn.addEventListener('click', () => {
    audio.blip();
    textarea.value = game.exportSave();
    textarea.focus();
    textarea.select();
    error.hidden = true;
    announce('Save exported into the box below. Copy it somewhere safe.');
  });

  const importBtn = el('button', { type: 'button', class: 'btn btn--primary' }, 'IMPORT');
  importBtn.addEventListener('click', () => {
    const result = game.importSave(textarea.value);
    if (result.ok) {
      audio.purchase();
      error.hidden = true;
      rerender();
    } else {
      audio.blip();
      error.hidden = false;
      error.textContent = result.error ?? 'that save could not be read';
      textarea.focus();
    }
  });

  save.appendChild(el('p', { class: 'note', text: 'everything lives in this browser. copy this out if you ever clear your data.' }));
  save.appendChild(el('div', { class: 'field' }, textarea));
  save.appendChild(error);
  save.appendChild(el('div', { class: 'field__row' }, exportBtn, importBtn));

  let armed = false;
  const resetBtn = el('button', { type: 'button', class: 'btn btn--ghost' }, 'START OVER');
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetBtn.textContent = 'REALLY? THIS CLEARS EVERYTHING';
      resetBtn.style.background = 'var(--danger)';
      resetBtn.style.color = 'var(--paper)';
      globalThis.setTimeout(() => {
        if (!armed) return;
        armed = false;
        resetBtn.textContent = 'START OVER';
        resetBtn.style.background = '';
        resetBtn.style.color = '';
      }, 5000);
      return;
    }
    game.resetEverything();
    rerender();
  });
  save.appendChild(resetBtn);
  body.appendChild(save);

  body.appendChild(
    el('p', { class: 'note', text: 'no accounts, no ads, no tracking, no network. this is a gift, not a funnel.' }),
  );

  return body;
}

export { qs, card };
