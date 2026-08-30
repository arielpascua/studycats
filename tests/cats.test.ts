/**
 * The cat's coat markings must stay ON the cat.
 *
 * This exists because they did not. The body was reshaped from 0.72 wide to 0.40, `patchSpecs`
 * kept the coordinates it was authored against, and `catAnimator` separately hardcoded the OLD
 * body height and re-applied it every frame — so a cat shipped wearing a pink slab bigger than
 * itself, floating off its flank. Nothing caught it but a screenshot.
 *
 * A marking is allowed to stand very slightly proud of the body, because a coplanar overlay
 * z-fights. Anything further out than that margin is not a marking, it is a lump.
 */

import { describe, expect, it } from 'vitest';
import { BREEDS, BREED_ORDER } from '../src/data/breeds';
import { CAT_BODY, PATCH_MAX_PROUD, patchSpecsFor } from '../src/scene/cats/catFactory';

/** Half-extents of the body, in the same local space the patch specs use. */
const HALF = { x: CAT_BODY.w / 2, y: CAT_BODY.h / 2, z: CAT_BODY.d / 2 };

/** How far a spec's furthest corner pokes out past the body, per axis. */
function overhang(spec: { w: number; h: number; d: number; x?: number; y?: number; z?: number }) {
  return {
    x: Math.abs(spec.x ?? 0) + spec.w / 2 - HALF.x,
    y: Math.abs(spec.y ?? 0) + spec.h / 2 - HALF.y,
    z: Math.abs(spec.z ?? 0) + spec.d / 2 - HALF.z,
  };
}

describe('coat markings sit on the body', () => {
  it('never hangs a marking off the side of the cat', () => {
    const offences: string[] = [];
    for (const id of BREED_ORDER) {
      const specs = patchSpecsFor(BREEDS[id]);
      specs.forEach((spec, i) => {
        const o = overhang(spec);
        for (const axis of ['x', 'y', 'z'] as const) {
          if (o[axis] > PATCH_MAX_PROUD + 1e-9) {
            offences.push(`${id} patch ${i} overhangs ${axis} by ${o[axis].toFixed(3)}`);
          }
        }
      });
    }
    expect(offences, offences.join('\n')).toEqual([]);
  });

  it('lets a marking stand proud enough not to z-fight', () => {
    // The opposite failure: a marking exactly coplanar with the body renders as a stippled
    // dither, the same way the museum picture frames did.
    for (const id of BREED_ORDER) {
      for (const spec of patchSpecsFor(BREEDS[id])) {
        const o = overhang(spec);
        const proudSomewhere = o.x > 0 || o.y > 0 || o.z > 0;
        const buriedEverywhere = o.x < -0.005 && o.y < -0.005 && o.z < -0.005;
        expect(
          proudSomewhere || buriedEverywhere,
          `${id} has a marking flush with the body surface, which will z-fight`,
        ).toBe(true);
      }
    }
  });

  it('gives every patterned breed a marking, and plain breeds none', () => {
    for (const id of BREED_ORDER) {
      const breed = BREEDS[id];
      const count = patchSpecsFor(breed).length;
      if (breed.style === 'none') expect(count, `${id} should be plain`).toBe(0);
      else expect(count, `${id} has style ${breed.style} but no marking`).toBeGreaterThan(0);
    }
  });

  it('keeps the markings bold enough to read across a room', () => {
    // The old markings were a scatter of small dots that vanished at play distance.
    //
    // Measured as TOTAL coverage, not the single biggest shape: a spotted coat is bold because
    // it has five marks, not because any one of them is large, and an earlier version of this
    // test wrongly failed the leopard for having leopard-sized spots.
    const flank = CAT_BODY.w * CAT_BODY.h;
    for (const id of BREED_ORDER) {
      const breed = BREEDS[id];
      if (breed.style === 'none') continue;
      const coverage = patchSpecsFor(breed).reduce((sum, s) => sum + s.w * s.h, 0);
      expect(coverage / flank, `${id}'s markings are too timid to see`).toBeGreaterThan(0.25);
    }
  });
});
