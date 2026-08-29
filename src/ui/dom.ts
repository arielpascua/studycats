/**
 * Tiny DOM helpers. Not a framework — just enough to build the HUD declaratively without
 * string-concatenating HTML (which is how XSS and broken markup both get in).
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') throw new Error('use text, never html');
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

export function qsa<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** A labelled section wrapper used all over the panels. */
export function section(title: string, ...children: Child[]): HTMLElement {
  return el('div', { class: 'section' }, el('h3', { class: 'section__title', text: title }), ...children);
}

/**
 * Empty states are a design contract (DESIGN.md §7), so they get a real component rather than
 * an ad-hoc paragraph in five different places.
 */
export function emptyState(icon: string, title: string, body: string): HTMLElement {
  return el(
    'div',
    { class: 'empty' },
    el('span', { class: 'empty__icon', 'aria-hidden': 'true', text: icon }),
    el('p', { class: 'empty__title', text: title }),
    el('p', { class: 'empty__body', text: body }),
  );
}

export interface CardOptions {
  icon?: string;
  swatch?: string;
  name: string;
  blurb?: string;
  price?: string;
  owned?: boolean;
  affordable?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onClick?: () => void;
}

export function card(opts: CardOptions): HTMLButtonElement {
  const node = el('button', {
    type: 'button',
    class: 'card',
    'data-owned': opts.owned ? 'true' : 'false',
    'data-affordable': opts.affordable === false ? 'false' : 'true',
    'aria-label': opts.ariaLabel ?? `${opts.name}${opts.price ? `, ${opts.price}` : ''}`,
  });
  if (opts.disabled || opts.owned) node.disabled = Boolean(opts.disabled);

  if (opts.swatch) {
    node.appendChild(el('span', { class: 'card__swatch', style: `background:${opts.swatch}`, 'aria-hidden': 'true' }));
  } else if (opts.icon) {
    node.appendChild(el('span', { class: 'card__icon', 'aria-hidden': 'true', text: opts.icon }));
  }

  node.appendChild(
    el(
      'span',
      { class: 'card__text' },
      el('span', { class: 'card__name', text: opts.name }),
      opts.blurb ? el('span', { class: 'card__blurb', text: opts.blurb }) : null,
    ),
  );

  if (opts.price) node.appendChild(el('span', { class: 'card__price', text: opts.price }));
  if (opts.onClick) node.addEventListener('click', opts.onClick);
  return node;
}

export function field(label: string, control: HTMLElement, valueNode?: HTMLElement): HTMLElement {
  const row = el('div', { class: 'field__row' }, control);
  if (valueNode) row.appendChild(valueNode);
  return el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), row);
}

export function slider(opts: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput: (value: number) => void;
}): HTMLElement {
  const input = el('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    value: opts.value,
    'aria-label': opts.label,
  });
  const readout = el('span', { class: 'field__value', text: (opts.format ?? String)(opts.value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    readout.textContent = (opts.format ?? String)(v);
    opts.onInput(v);
  });
  return field(opts.label, input, readout);
}

export function toggle(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'switch' }, el('span', { text: label }), input);
}

/** Announce something to screen readers without moving focus. */
export function announce(message: string): void {
  const live = document.getElementById('live');
  if (!live) return;
  // Clearing first forces AT to re-read an identical message.
  live.textContent = '';
  globalThis.setTimeout(() => {
    live.textContent = message;
  }, 30);
}
