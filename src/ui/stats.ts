/**
 * Stats dashboard: today / week / all-time, a GitHub-style heatmap, and a minutes-per-day bar
 * chart — both drawn on a plain 2D canvas (no chart library, per the spec's minimal-deps rule).
 *
 * Chart design follows the dataviz discipline: one hue ramp, no chart-library defaults, axes
 * that stay drawn even with no data (an empty chart must still read as a chart, not as a bug).
 */

import { activeDays, favouriteScene, mostPettedCat, type GameState } from '../core/state';
import { addDays, dayKey, formatDuration } from '../core/time';
import { ENVIRONMENTS } from '../data/environments';
import type { Game } from '../store';
import { el, emptyState, section } from './dom';

/** Sequential ramp from paper to plum — one hue, five steps. */
const HEAT_RAMP = ['#F3E6EC', '#E6D3E0', '#CDB2D6', '#A98BC4', '#7C6BB0'] as const;
const INK = '#3B2A44';
const INK_SOFT = '#6F5A78';
const BAR = '#C7BFEA';
const BAR_TODAY = '#D98BA6';

function heatColor(pomodoros: number): string {
  if (pomodoros <= 0) return HEAT_RAMP[0];
  if (pomodoros === 1) return HEAT_RAMP[1];
  if (pomodoros <= 3) return HEAT_RAMP[2];
  if (pomodoros <= 6) return HEAT_RAMP[3];
  return HEAT_RAMP[4];
}

function makeCanvas(width: number, height: number, label: string): HTMLCanvasElement {
  const canvas = el('canvas', {
    class: 'chart',
    width: String(width),
    height: String(height),
    role: 'img',
    'aria-label': label,
  });
  return canvas;
}

/** 18 weeks of squares, newest column on the right — the shape everyone already knows. */
function drawHeatmap(canvas: HTMLCanvasElement, state: GameState, today: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const weeks = 18;
  const cell = 12;
  const gap = 3;
  const left = 4;
  const top = 4;

  // Align the last column to today, then walk backwards day by day.
  const todayDow = new Date(`${today}T12:00:00`).getDay();
  const totalDays = weeks * 7;
  const startOffset = -(totalDays - 1 - (6 - todayDow));

  for (let i = 0; i < totalDays; i++) {
    const day = addDays(today, startOffset + i);
    const col = Math.floor(i / 7);
    const row = i % 7;
    const entry = state.stats.perDay[day];
    ctx.fillStyle = heatColor(entry?.p ?? 0);
    ctx.fillRect(left + col * (cell + gap), top + row * (cell + gap), cell, cell);
    if (day === today) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.strokeRect(left + col * (cell + gap) - 1, top + row * (cell + gap) - 1, cell + 2, cell + 2);
    }
  }
}

/** Last 14 days of focus minutes. */
function drawBars(canvas: HTMLCanvasElement, state: GameState, today: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const days = 14;
  const padLeft = 26;
  const padBottom = 16;
  const padTop = 8;
  const plotW = canvas.width - padLeft - 6;
  const plotH = canvas.height - padBottom - padTop;

  const values: Array<{ day: string; minutes: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    values.push({ day, minutes: state.stats.perDay[day]?.m ?? 0 });
  }

  const peak = Math.max(30, ...values.map((v) => v.minutes));

  // Axis lines are drawn even at zero data — an empty chart still reads as a chart.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padLeft, padTop);
  ctx.lineTo(padLeft, padTop + plotH);
  ctx.lineTo(padLeft + plotW, padTop + plotH);
  ctx.stroke();

  ctx.fillStyle = INK_SOFT;
  ctx.font = '9px "Silkscreen", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(String(peak), padLeft - 4, padTop + 8);
  ctx.fillText('0', padLeft - 4, padTop + plotH);

  const slot = plotW / days;
  const barW = Math.max(4, slot - 4);
  values.forEach((v, i) => {
    const h = peak > 0 ? (v.minutes / peak) * (plotH - 4) : 0;
    ctx.fillStyle = v.day === today ? BAR_TODAY : BAR;
    const x = padLeft + i * slot + (slot - barW) / 2;
    const y = padTop + plotH - h;
    if (h > 0) {
      ctx.fillRect(x, y, barW, h);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, h - 1);
    }
  });

  ctx.fillStyle = INK_SOFT;
  ctx.textAlign = 'center';
  ctx.fillText('14 days ago', padLeft + slot * 1.6, canvas.height - 4);
  ctx.fillText('today', padLeft + plotW - slot, canvas.height - 4);
}

function stat(value: string, label: string): HTMLElement {
  return el(
    'div',
    { class: 'stat' },
    el('span', { class: 'stat__value', text: value }),
    el('span', { class: 'stat__label', text: label }),
  );
}

export function buildStatsPanel(game: Game): HTMLElement {
  const s = game.getState();
  const today = dayKey();
  const body = el('div', { class: 'panel__body' });

  const todayEntry = s.stats.perDay[today];
  const hasHistory = s.stats.totalPomodoros > 0;

  let weekPomodoros = 0;
  let weekMinutes = 0;
  for (let i = 0; i < 7; i++) {
    const entry = s.stats.perDay[addDays(today, -i)];
    weekPomodoros += entry?.p ?? 0;
    weekMinutes += entry?.m ?? 0;
  }

  body.appendChild(
    section(
      'TODAY',
      el(
        'div',
        { class: 'stat-grid' },
        stat(String(todayEntry?.p ?? 0), 'pomodoros'),
        stat(formatDuration(todayEntry?.m ?? 0), 'focused'),
      ),
    ),
  );

  body.appendChild(
    section(
      'THIS WEEK',
      el(
        'div',
        { class: 'stat-grid' },
        stat(String(weekPomodoros), 'pomodoros'),
        stat(formatDuration(weekMinutes), 'focused'),
      ),
    ),
  );

  const scene = favouriteScene(s.stats);
  const petted = mostPettedCat(s.stats);
  const pettedName = petted ? s.cats.find((c) => c.id === petted.id)?.name ?? '—' : '—';

  body.appendChild(
    section(
      'ALL TIME',
      el(
        'div',
        { class: 'stat-grid' },
        stat(String(s.stats.totalPomodoros), 'pomodoros'),
        stat(formatDuration(s.stats.totalFocusMin), 'focused'),
        stat(String(s.economy.streak.best), 'best streak'),
        stat(String(activeDays(s.stats)), 'days studied'),
        stat(scene ? ENVIRONMENTS[scene].label : '—', 'favourite place'),
        stat(pettedName, 'most petted'),
      ),
    ),
  );

  if (!hasHistory) {
    body.appendChild(
      emptyState('📊', 'YOUR FIRST SESSION GOES HERE', 'finish one pomodoro and this page starts filling in.'),
    );
  }

  const heat = makeCanvas(272, 108, 'Calendar heatmap of the last 18 weeks of study');
  const bars = makeCanvas(272, 128, 'Focus minutes per day over the last 14 days');

  body.appendChild(section('THE LAST FEW MONTHS', heat));
  body.appendChild(section('MINUTES PER DAY', bars));

  // Draw after the nodes exist so the canvases are sized.
  queueMicrotask(() => {
    drawHeatmap(heat, s, today);
    drawBars(bars, s, today);
  });

  body.appendChild(
    el('p', {
      class: 'note',
      text: `${s.economy.streak.freezes} freeze${s.economy.streak.freezes === 1 ? '' : 's'} in the drawer ❄ — one missed day each, no questions.`,
    }),
  );

  return body;
}
