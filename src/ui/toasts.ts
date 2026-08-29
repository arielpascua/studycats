/**
 * Toasts. Deliberately quiet: they never block the diorama, never stack more than three deep,
 * and they never demand a dismiss click. A reward should feel like a note left on the desk.
 */

import { bus } from '../core/events';
import { announce, clear, el } from './dom';

const MAX_VISIBLE = 3;
const LIFETIME_MS = 4200;

export function mountToasts(container: HTMLElement): () => void {
  const timers = new Set<number>();

  function show(title: string, body?: string, icon?: string, tone: string = 'default'): void {
    const node = el(
      'div',
      { class: 'toast', 'data-tone': tone, role: 'status' },
      icon ? el('span', { class: 'toast__icon', 'aria-hidden': 'true', text: icon }) : null,
      el(
        'div',
        {},
        el('div', { class: 'toast__title', text: title }),
        body ? el('div', { class: 'toast__body', text: body }) : null,
      ),
    );

    container.appendChild(node);
    announce(body ? `${title}. ${body}` : title);

    while (container.children.length > MAX_VISIBLE) {
      container.removeChild(container.firstChild as ChildNode);
    }

    const timer = globalThis.setTimeout(() => {
      timers.delete(timer);
      node.setAttribute('data-leaving', 'true');
      const removal = globalThis.setTimeout(() => {
        timers.delete(removal);
        node.remove();
      }, 220);
      timers.add(removal);
    }, LIFETIME_MS);
    timers.add(timer);
  }

  const unsubs = [
    bus.on('toast', ({ title, body, icon, tone }) => show(title, body, icon, tone ?? 'default')),
    bus.on('achievement:unlocked', ({ title, description }) => show(title.toUpperCase(), description, '🏆', 'reward')),
  ];

  return () => {
    for (const un of unsubs) un();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clear(container);
  };
}
