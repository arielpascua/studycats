/**
 * Photo mode (spec §8.6). Pauses the brains, hides the HUD, puts the camera on rails, and
 * exports a PNG with an optional frame caption.
 *
 * The export is drawn onto a second canvas so the frame and caption are baked into the file
 * rather than being screen-only decoration — the point of this feature is the artifact.
 */

import { dayKey } from '../core/time';
import type { Game } from '../store';
import type { CameraRig } from '../scene/camera';
import type { FilterId, SceneRenderer } from '../scene/renderer';
import { audio } from '../audio/engine';
import { announce, el, clear, slider } from './dom';

export interface PhotoMode {
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: 'none', label: 'PLAIN' },
  { id: 'warm', label: 'WARM' },
  { id: 'night', label: 'NIGHT' },
  { id: 'grain', label: 'FILM' },
];

export function mountPhotoMode(
  container: HTMLElement,
  game: Game,
  rig: CameraRig,
  renderer: SceneRenderer,
  hooks: { onOpen(): void; onClose(): void },
): PhotoMode {
  let open = false;
  let showFrame = true;
  let filter: FilterId = 'none';

  // Camera rails: three normalized dials the rig clamps into a safe envelope, so the camera can
  // never end up inside the floor. Held outside render() so re-rendering the controls (after a
  // filter change, say) does not silently desync the sliders from the actual camera pose.
  let turnValue = 50;
  let heightValue = 50;
  let zoomValue = 50;
  const pushRails = (): void => rig.setPhotoControls(turnValue / 100, heightValue / 100, zoomValue / 100);

  function caption(): string {
    const s = game.getState();
    return `STUDY WITH CATS · ${dayKey()} · ${s.stats.totalPomodoros} POMODOROS`;
  }

  /** Compose the render plus the frame + caption into a downloadable PNG. */
  function exportPng(): void {
    const source = renderer.renderer.domElement;
    renderer.render(performance.now() / 1000);

    const out = document.createElement('canvas');
    out.width = source.width;
    out.height = source.height;
    const ctx = out.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(source, 0, 0);

    if (showFrame) {
      const pad = Math.round(Math.min(out.width, out.height) * 0.035);
      ctx.strokeStyle = '#FBF2F4';
      ctx.lineWidth = Math.max(3, Math.round(pad * 0.18));
      ctx.strokeRect(pad, pad, out.width - pad * 2, out.height - pad * 2);

      const text = caption();
      const fontSize = Math.max(11, Math.round(out.width * 0.014));
      ctx.font = `${fontSize}px "Silkscreen", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const metrics = ctx.measureText(text);
      const boxW = metrics.width + fontSize * 2;
      const boxH = fontSize * 2.2;
      const boxX = (out.width - boxW) / 2;
      const boxY = out.height - pad - boxH / 2 - fontSize;

      ctx.fillStyle = '#FBF2F4';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeStyle = '#3B2A44';
      ctx.lineWidth = 2;
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = '#3B2A44';
      ctx.fillText(text, out.width / 2, boxY + boxH / 2);
    }

    const link = document.createElement('a');
    link.download = `study-with-cats-${dayKey()}.png`;
    link.href = out.toDataURL('image/png');
    link.click();

    audio.shutter();
    game.recordPhoto();
    announce('Photo saved to your downloads');
  }

  function render(): void {
    clear(container);

    if (showFrame) {
      container.appendChild(el('div', { class: 'photo__frame', 'aria-hidden': 'true' }));
      container.appendChild(el('p', { class: 'photo__caption', text: caption() }));
    }

    const controls = el('div', { class: 'photo__controls', role: 'group', 'aria-label': 'Photo controls' });

    controls.appendChild(
      slider({
        label: 'TURN',
        min: 0,
        max: 100,
        value: turnValue,
        format: () => '',
        onInput: (v) => {
          turnValue = v;
          pushRails();
        },
      }),
    );
    controls.appendChild(
      slider({
        label: 'HEIGHT',
        min: 0,
        max: 100,
        value: heightValue,
        format: () => '',
        onInput: (v) => {
          heightValue = v;
          pushRails();
        },
      }),
    );
    controls.appendChild(
      slider({
        label: 'ZOOM',
        min: 0,
        max: 100,
        value: zoomValue,
        format: () => '',
        onInput: (v) => {
          zoomValue = v;
          pushRails();
        },
      }),
    );

    const filterRow = el('div', { class: 'photo__row', role: 'group', 'aria-label': 'Filter' });
    for (const f of FILTERS) {
      const btn = el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        'aria-pressed': filter === f.id ? 'true' : 'false',
      }, f.label);
      btn.addEventListener('click', () => {
        filter = f.id;
        renderer.setFilter(f.id);
        audio.blip();
        render();
      });
      filterRow.appendChild(btn);
    }
    controls.appendChild(filterRow);

    const frameBtn = el('button', {
      type: 'button',
      class: 'btn btn--ghost',
      'aria-pressed': showFrame ? 'true' : 'false',
    }, showFrame ? 'FRAME ON' : 'FRAME OFF');
    frameBtn.addEventListener('click', () => {
      showFrame = !showFrame;
      audio.blip();
      render();
    });

    const saveBtn = el('button', { type: 'button', class: 'btn btn--primary' }, '📷 SAVE PNG');
    saveBtn.addEventListener('click', exportPng);

    const doneBtn = el('button', { type: 'button', class: 'btn' }, 'DONE');
    doneBtn.addEventListener('click', () => close());

    controls.appendChild(el('div', { class: 'photo__row' }, frameBtn, saveBtn, doneBtn));
    container.appendChild(controls);

    saveBtn.focus();
  }

  const onKey = (event: KeyboardEvent): void => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  function openMode(): void {
    if (open) return;
    open = true;
    container.hidden = false;
    document.getElementById('ui')?.setAttribute('data-photo', 'true');
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('.rail, .timer, .scenes, .panels, .toasts'))) {
      node.hidden = true;
    }
    turnValue = 50;
    heightValue = 50;
    zoomValue = 50;
    rig.setMood('photo');
    rig.resetPhotoControls();
    renderer.setVignette(0.26);
    hooks.onOpen();
    render();
    announce('Photo mode. Escape to leave.');
  }

  function close(): void {
    if (!open) return;
    open = false;
    container.hidden = true;
    clear(container);
    document.getElementById('ui')?.removeAttribute('data-photo');
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('.rail, .timer, .scenes, .panels, .toasts'))) {
      node.hidden = false;
    }
    rig.resetPhotoControls();
    rig.setMood('idle');
    renderer.setFilter('none');
    renderer.setVignette(0.18);
    hooks.onClose();
    announce('Left photo mode');
  }

  return {
    open: openMode,
    close,
    isOpen: () => open,
    dispose() {
      document.removeEventListener('keydown', onKey);
      clear(container);
    },
  };
}
