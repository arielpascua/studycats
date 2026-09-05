/**
 * The HUD: timer chip, session dots, coin/streak chips, scene switcher, keyboard shortcuts.
 *
 * Two rules this module exists to enforce:
 *  - **Shortcuts never fire while typing.** Space in the task field must type a space.
 *  - **The tab title is always right** — `MM:SS · task` while running, the product name at rest.
 */

import { bus } from '../core/events';
import { formatClock } from '../core/time';
import { durationFor, isBreak, modeLabel, remainingAt } from '../core/timer';
import { streakStatus } from '../core/economy';
import { ENVIRONMENTS, ENVIRONMENT_ORDER } from '../data/environments';
import type { Game } from '../store';
import { announce, clear, el, qs } from './dom';
import { audio } from '../audio/engine';

export interface Hud {
  update(now: number): void;
  refreshScenes(): void;
  refreshChips(): void;
  dispose(): void;
}

const TITLE = 'Study With Cats';

const MODE_GLYPH: Record<string, string> = {
  idle: '🐾',
  focus: '📚',
  shortBreak: '☕',
  longBreak: '🌙',
};

export function mountHud(game: Game, onOpenPanel: (id: string) => void): Hud {
  const clock = qs('#timer-clock');
  const modeEl = qs('#timer-mode');
  const dots = qs('#session-dots');
  const startBtn = qs<HTMLButtonElement>('#btn-start');
  const startLabel = qs('#btn-start-label');
  const resetBtn = qs<HTMLButtonElement>('#btn-reset');
  const skipBtn = qs<HTMLButtonElement>('#btn-skip');
  const taskInput = qs<HTMLInputElement>('#task-input');
  const timerCard = qs('.timer');
  const coinValue = qs('#coin-value');
  const streakValue = qs('#streak-value');
  const streakChip = qs('#streak-chip');
  const sceneList = qs('#scene-list');

  let lastClockText = '';
  let lastTitle = '';
  let lastLocked: boolean | null = null;
  const listeners: Array<() => void> = [];

  taskInput.value = game.timer().task;

  // The caption for a clock that is not yours. Built here rather than in index.html because it
  // only means anything once the store has an online party to speak of.
  const hostNote = el('small', { id: 'hud-host-note', class: 'hud__note', text: 'the host runs the clock' });
  hostNote.hidden = true;
  qs('.timer__controls').after(hostNote);

  /* ---------------------------------------------------------------- host */

  /**
   * In an online party the host runs the clock and everyone else's controls are inert. The
   * store already refuses the calls; this makes the refusal visible instead of a button that
   * clicks and does nothing.
   */
  function refreshHost(): void {
    const online = game.online();
    const locked = online.status !== 'offline' && !online.isHost;
    if (locked === lastLocked) return;
    lastLocked = locked;
    for (const btn of [startBtn, resetBtn, skipBtn]) {
      btn.disabled = locked;
      if (locked) btn.setAttribute('aria-describedby', 'hud-host-note');
      else btn.removeAttribute('aria-describedby');
    }
    hostNote.hidden = !locked;
    timerCard.setAttribute('data-locked', locked ? 'true' : 'false');
  }

  /* --------------------------------------------------------------- chips */

  function refreshChips(): void {
    const s = game.getState();
    coinValue.textContent = String(s.economy.coins);

    const status = streakStatus(s.economy.streak);
    const frozen = status === 'frozen';
    streakValue.textContent = String(s.economy.streak.current);
    streakChip.setAttribute('data-frozen', frozen ? 'true' : 'false');
    const icon = streakChip.querySelector('.chip__icon');
    if (icon) icon.textContent = frozen ? '❄' : '🔥';
    streakChip.setAttribute(
      'aria-label',
      frozen
        ? `Streak ${s.economy.streak.current} days, frozen. Opens your stats.`
        : `Streak ${s.economy.streak.current} days. Opens your stats.`,
    );
  }

  /* -------------------------------------------------------------- scenes */

  function refreshScenes(): void {
    const s = game.getState();
    // The solo scene switcher is meaningless in the clearing — you do not pick a world there,
    // the party is the world. Hiding the whole block also gives the arena back its left edge.
    const scenesBlock = sceneList.closest('.scenes') as HTMLElement | null;
    if (scenesBlock) scenesBlock.hidden = s.settings.mode === 'party';
    clear(sceneList);
    for (const id of ENVIRONMENT_ORDER) {
      const def = ENVIRONMENTS[id];
      const owned = s.unlocks.environments.includes(id);
      const current = s.settings.environment === id;
      const btn = el(
        'button',
        {
          type: 'button',
          class: 'scene-btn',
          'data-locked': owned ? 'false' : 'true',
          'aria-current': current ? 'true' : 'false',
          'aria-label': owned ? `Study in the ${def.label.toLowerCase()}` : `${def.label} — locked, ${def.price} fish coins`,
        },
        el('span', { 'aria-hidden': 'true', text: def.icon }),
        el('span', { text: def.label }),
        owned ? null : el('span', { class: 'scene-btn__price', text: `${def.price} 🐟` }),
      );
      btn.addEventListener('click', () => {
        audio.blip();
        if (owned) {
          game.setEnvironment(id);
          announce(`Now studying in the ${def.label.toLowerCase()}`);
        } else if (game.buyEnvironment(id)) {
          game.setEnvironment(id);
        } else {
          bus.emit('toast', {
            title: 'NOT YET',
            body: `${def.label.toLowerCase()} costs ${def.price} 🐟 — finish a session to earn more`,
            icon: def.icon,
            tone: 'gentle',
          });
        }
        refreshScenes();
        refreshChips();
      });
      sceneList.appendChild(btn);
    }
  }

  /* --------------------------------------------------------------- timer */

  function refreshDots(): void {
    const t = game.timer();
    const total = t.settings.roundsPerLongBreak;
    if (dots.children.length !== total) {
      clear(dots);
      for (let i = 0; i < total; i++) dots.appendChild(el('span', { class: 'dot' }));
    }
    for (let i = 0; i < total; i++) {
      (dots.children[i] as HTMLElement).setAttribute('data-filled', i < t.round ? 'true' : 'false');
    }
    dots.setAttribute('aria-label', `${t.round} of ${total} sessions this round`);
  }

  function update(now: number): void {
    const t = game.timer();
    const remaining = remainingAt(t, now);
    const text = formatClock(remaining);

    if (text !== lastClockText) {
      lastClockText = text;
      clock.textContent = text;
    }

    // A tiny glyph in front of the mode. It is the difference between a status field and a
    // friend telling you what's happening: "☕ SHORT BREAK" reads as an invitation.
    modeEl.textContent = `${MODE_GLYPH[t.mode] ?? ''} ${modeLabel(t.mode)}`.trim();
    startLabel.textContent = t.running ? 'PAUSE' : t.mode === 'idle' ? 'START' : 'RESUME';
    startBtn.setAttribute('data-mode', isBreak(t.mode) ? 'break' : 'focus');
    startBtn.setAttribute('aria-label', t.running ? 'Pause the timer' : 'Start the timer');

    // Last-10-seconds pulse (DESIGN.md §5). Reduced motion turns the animation off in CSS.
    const pulsing = t.running && remaining <= 10_000 && remaining > 0;
    timerCard.setAttribute('data-pulse', pulsing ? 'true' : 'false');

    const title = t.running
      ? `${text}${t.task ? ` · ${t.task}` : ` · ${modeLabel(t.mode).toLowerCase()}`}`
      : TITLE;
    if (title !== lastTitle) {
      lastTitle = title;
      document.title = title;
    }

    refreshDots();
    refreshHost();
  }

  /* ------------------------------------------------------------ controls */

  function bind(node: HTMLElement, event: string, handler: EventListener): void {
    node.addEventListener(event, handler);
    listeners.push(() => node.removeEventListener(event, handler));
  }

  bind(startBtn, 'click', () => {
    audio.blip();
    void audio.resume();
    const wasIdle = !game.timer().running;
    game.toggleTimer();
    announce(wasIdle ? `${modeLabel(game.timer().mode)} started` : 'Paused');
    update(Date.now());
  });

  bind(resetBtn, 'click', () => {
    audio.blip();
    game.resetTimer();
    announce('Timer reset');
    update(Date.now());
  });

  bind(skipBtn, 'click', () => {
    audio.blip();
    game.skip();
    announce(`Skipped to ${modeLabel(game.timer().mode).toLowerCase()}`);
    update(Date.now());
  });

  bind(taskInput, 'input', () => {
    game.setTask(taskInput.value);
  });

  bind(qs('#coin-chip'), 'click', () => {
    audio.blip();
    onOpenPanel('shop');
  });
  bind(streakChip, 'click', () => {
    audio.blip();
    onOpenPanel('stats');
  });

  /* ----------------------------------------------------------- shortcuts */

  function isTyping(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (!node) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event.target)) return;

    switch (event.key) {
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        startBtn.click();
        break;
      case 'r':
      case 'R':
        event.preventDefault();
        resetBtn.click();
        break;
      case 's':
      case 'S':
        event.preventDefault();
        skipBtn.click();
        break;
      default:
        break;
    }
  };
  document.addEventListener('keydown', onKeyDown);
  listeners.push(() => document.removeEventListener('keydown', onKeyDown));

  /* ---------------------------------------------------------- reactions */

  const unsubs = [
    bus.on('economy:coins', refreshChips),
    bus.on('economy:streak', refreshChips),
    bus.on('env:changed', () => {
      refreshScenes();
      refreshChips();
    }),
    bus.on('settings:changed', () => {
      refreshDots();
      taskInput.value = game.timer().task;
    }),
    bus.on('timer:transition', ({ to }) => {
      announce(`${modeLabel(to)} — ${formatClock(durationFor(to, game.timer().settings))}`);
    }),
    bus.on('party:changed', () => {
      refreshHost();
      update(Date.now());
    }),
  ];

  refreshChips();
  refreshScenes();
  refreshHost();
  update(Date.now());

  return {
    update,
    refreshScenes,
    refreshChips,
    dispose() {
      for (const un of unsubs) un();
      for (const off of listeners) off();
      hostNote.remove();
    },
  };
}
