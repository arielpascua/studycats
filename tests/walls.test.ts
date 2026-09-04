/**
 * Cutting an opening into a wall is exactly where two failures live: a sliver of wall left
 * inside the hole, or a gap beside it that shows raw background through the shell. Both are
 * invisible in code review and obvious in a screenshot, so the geometry is pinned here.
 */

import { describe, expect, it } from 'vitest';
import { cutWall, type WallOpening } from '../src/scene/environments/index';

type Seg = [number, number, number, number]; // alongCentre, alongLength, yCentre, yHeight

const area = (segs: Seg[]) => segs.reduce((s, [, l, , h]) => s + l * h, 0);

/** Is every point of the wall either inside some segment or inside some opening — never both, never neither? */
function coverage(a0: number, a1: number, h: number, segs: Seg[], openings: WallOpening[], step = 0.05): { holes: number; overlaps: number } {
  let holes = 0;
  let overlaps = 0;
  const inSeg = (x: number, y: number) =>
    segs.filter(([c, l, yc, yh]) => x > c - l / 2 && x < c + l / 2 && y > yc - yh / 2 && y < yc + yh / 2).length;
  const inOpening = (x: number, y: number) =>
    openings.some((o) => x > o.from && x < o.to && y > o.y0 && y < o.y1);
  for (let x = a0 + step / 2; x < a1; x += step) {
    for (let y = step / 2; y < h; y += step) {
      const n = inSeg(x, y);
      const open = inOpening(x, y);
      if (open && n > 0) overlaps++; // wall left inside the hole
      if (!open && n === 0) holes++; // gap beside the hole
      if (n > 1) overlaps++;
    }
  }
  return { holes, overlaps };
}

describe('cutWall', () => {
  it('leaves a whole wall as one box when there is nothing to cut', () => {
    const segs = cutWall(-5.5, 14, 12.5, []);
    expect(segs).toHaveLength(1);
    expect(area(segs)).toBeCloseTo(19.5 * 12.5, 6);
  });

  it('cuts one opening into pier, sill, lintel, pier and nothing else', () => {
    const o: WallOpening[] = [{ wall: 'z', from: 0.5, to: 5.7, y0: 0.4, y1: 3.2 }];
    const segs = cutWall(-5.5, 14, 12.5, o);
    expect(segs).toHaveLength(4);
    expect(area(segs)).toBeCloseTo(19.5 * 12.5 - 5.2 * 2.8, 6);
    expect(coverage(-5.5, 14, 12.5, segs, o)).toEqual({ holes: 0, overlaps: 0 });
  });

  it('drops the sill when the opening reaches the floor', () => {
    const o: WallOpening[] = [{ wall: 'z', from: 0.5, to: 5.7, y0: 0, y1: 3.2 }];
    const segs = cutWall(-5.5, 14, 12.5, o);
    expect(segs).toHaveLength(3);
    expect(coverage(-5.5, 14, 12.5, segs, o)).toEqual({ holes: 0, overlaps: 0 });
  });

  it('handles two openings with a pier between them', () => {
    const o: WallOpening[] = [
      { wall: 'z', from: -4, to: -1, y0: 0.45, y1: 3.05 },
      { wall: 'z', from: 1, to: 5, y0: 0.45, y1: 3.05 },
    ];
    const segs = cutWall(-5.5, 14, 12.5, o);
    expect(coverage(-5.5, 14, 12.5, segs, o)).toEqual({ holes: 0, overlaps: 0 });
    expect(area(segs)).toBeCloseTo(19.5 * 12.5 - (3 + 4) * 2.6, 6);
  });

  it('clips an opening that runs past the end of the wall instead of leaving a gap', () => {
    const o: WallOpening[] = [{ wall: 'x', from: -6, to: 1.0, y0: 0.45, y1: 3.05 }];
    const segs = cutWall(-4, 13.5, 12.5, o);
    const clipped: WallOpening[] = [{ ...o[0], from: -4 }];
    expect(coverage(-4, 13.5, 12.5, segs, clipped)).toEqual({ holes: 0, overlaps: 0 });
  });

  it('accepts openings in any order', () => {
    const a: WallOpening[] = [
      { wall: 'z', from: 1, to: 5, y0: 0.45, y1: 3.05 },
      { wall: 'z', from: -4, to: -1, y0: 0.45, y1: 3.05 },
    ];
    const b = [a[1], a[0]];
    expect(area(cutWall(-5.5, 14, 12.5, a))).toBeCloseTo(area(cutWall(-5.5, 14, 12.5, b)), 6);
  });
});
