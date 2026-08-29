/**
 * Computed-layout gate (AC-18).
 *
 * The design detector reads source and a reviewer reads screenshots; neither sees the *box
 * model*. This measures it in a real browser and exits non-zero on findings, so an unusable
 * screen cannot pass a green test suite.
 *
 * Checks:
 *   page-h-overflow      document scrolls sideways
 *   unclipped-v-overflow content paints through a box that can neither scroll nor clip it
 *   sibling-overlap      two in-flow siblings occupy the same pixels
 *   small-touch-target   an interactive element under 44x44 at mobile width
 *
 * Every exclusion below was verified necessary in practice; an over-reporting gate gets deleted,
 * which is worse than no gate. See the notes on each rule.
 *
 * Usage:  node tools/geometry-probe.mjs <url> [--selftest]
 */

import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:4318/';
const SELFTEST = process.argv.includes('--selftest');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/** Vertical-overflow tolerance. Every text node reports 3-4px from line-box rounding and
 *  descenders; real unclipped overflow is dozens of px. 12 is comfortably above the noise. */
const V_TOLERANCE = 12;
const TOUCH_MIN = 44;

const MEASURE = ({ vTolerance, touchMin, isMobile }) => {
  const findings = [];
  const push = (rule, detail) => findings.push({ rule, ...detail });

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 120);
  };

  // (a) Anything inside an <svg> is excluded everywhere: vector internals overlap and overflow
  //     by design, and including them buries every real finding under `circle|circle` noise.
  const inSvg = (el) => el.closest && el.closest('svg') !== null;
  // (b) Offscreen-until-focused helpers and decorative nodes are not layout defects.
  const isHiddenHelper = (el) =>
    el.classList?.contains('sr-only') || el.getAttribute?.('aria-hidden') === 'true';

  const all = Array.from(document.querySelectorAll('body *')).filter(
    (el) => !inSvg(el) && !isHiddenHelper(el),
  );

  /* ---- page-h-overflow ------------------------------------------------- */
  // clientWidth, NOT innerWidth: under mobile emulation an over-wide element expands the layout
  // viewport, so innerWidth grows with the overflow and the check can never fire.
  const docWidth = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;

  // This app sets `html,body { overflow: hidden }` (it is a fixed full-screen canvas). That
  // CLIPS sideways overflow instead of making the page scroll, so a scrollWidth comparison can
  // never fire — it would be a permanently green check. Measure the elements themselves
  // instead, which catches both the scrolling and the clipped case.
  // Stop the walk BEFORE <body>: body's own `overflow:hidden` is the page-level clip this rule
  // exists to test for, so counting it as "contained by design" disables the check entirely.
  const clipsX = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const ox = getComputedStyle(node).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
      node = node.parentElement;
    }
    return false;
  };

  const escaped = all.filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= docWidth + 1 && r.left >= -1) return false;
    // Content inside a deliberately scrollable/clipping strip is contained by design.
    return !clipsX(el);
  });

  if (escaped.length > 0) {
    push('page-h-overflow', {
      detail: `${escaped.length} element(s) extend past the ${docWidth}px viewport (documentElement.scrollWidth ${scrollWidth})`,
      offenders: escaped.slice(0, 6).map((el) => {
        const r = el.getBoundingClientRect();
        return `${describe(el)} left=${Math.round(r.left)} right=${Math.round(r.right)}`;
      }),
    });
  }

  /* ---- unclipped-v-overflow -------------------------------------------- */
  for (const el of all) {
    if (el.scrollHeight <= el.clientHeight + vTolerance) continue;
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'hidden' || oy === 'clip') continue;
    if (cs.display === 'inline' || cs.display === 'contents') continue;

    // Attribute the overflow to IN-FLOW children only. An absolutely-positioned closed dropdown
    // inflates a parent's scrollHeight without ever painting through anything.
    const inFlow = Array.from(el.children).filter((c) => {
      const ccs = getComputedStyle(c);
      return ccs.position !== 'absolute' && ccs.position !== 'fixed' && ccs.display !== 'none';
    });
    if (inFlow.length === 0) continue;

    const box = el.getBoundingClientRect();
    const worst = inFlow.reduce((acc, c) => {
      const r = c.getBoundingClientRect();
      return Math.max(acc, r.bottom - box.bottom);
    }, 0);
    if (worst <= vTolerance) continue;

    push('unclipped-v-overflow', {
      detail: `${describe(el)} scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}, in-flow child exceeds by ${Math.round(worst)}px`,
    });
  }

  /* ---- sibling-overlap -------------------------------------------------- */
  const overlapSeen = new Set();
  for (const el of all) {
    const kids = Array.from(el.children).filter((c) => {
      if (inSvg(c) || isHiddenHelper(c)) return false;
      const cs = getComputedStyle(c);
      if (cs.position !== 'static' && cs.position !== 'relative') return false;
      // A wrapped inline element's rect is the UNION of its line boxes, so two spans in one
      // flowing sentence report a full-width overlap while rendering perfectly.
      if (cs.display === 'inline' || cs.display === 'contents' || cs.display === 'none') return false;
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = c.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect();
        const b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2) {
          const key = `${describe(kids[i])}|${describe(kids[j])}`;
          if (overlapSeen.has(key)) continue;
          overlapSeen.add(key);
          push('sibling-overlap', {
            detail: `${key} overlap ${Math.round(ox)}x${Math.round(oy)}px inside ${describe(el)}`,
          });
        }
      }
    }
  }

  /* ---- accessible names -------------------------------------------------
   * Every control must be announceable. A button whose only content is an emoji marked
   * aria-hidden announces as nothing at all, which is the most common way an otherwise-tidy
   * icon bar becomes unusable with a screen reader.
   */
  const named = Array.from(
    document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea'),
  ).filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  for (const el of named) {
    const aria = el.getAttribute('aria-label')?.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    const title = el.getAttribute('title')?.trim();
    // Text content, ignoring anything hidden from the accessibility tree.
    const visibleText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && n.getAttribute?.('aria-hidden') !== 'true'))
      .map((n) => (n.textContent ?? '').trim())
      .join(' ')
      .trim();
    const wrappingLabel = el.closest('label');
    const hasName = Boolean(aria || labelledBy || title || visibleText || wrappingLabel);
    if (!hasName) push('missing-accessible-name', { detail: `${describe(el)} has no announceable name` });
  }

  /* ---- small-touch-target (mobile only) --------------------------------- */
  if (isMobile) {
    const interactive = Array.from(
      document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !inSvg(el) && !isHiddenHelper(el) && !el.disabled);

    for (const el of interactive) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // WCAG 2.5.8 exempts a link laid out inline inside a sentence: text flow sets its size and
      // padding it would break the paragraph.
      if (cs.display === 'inline' && el.closest('p, li, blockquote, figcaption')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.width >= touchMin && r.height >= touchMin) continue;

      // An inline element reports its LINE BOX, not its effective hit area. Hit-test the centre
      // before calling it a defect, so a small label inside a padded parent is not reported.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let effective = null;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) {
        const padded = (hit.closest('button, a[href], [role="button"]') ?? hit).getBoundingClientRect();
        effective = padded;
      }
      if (effective && effective.width >= touchMin && effective.height >= touchMin) continue;

      push('small-touch-target', {
        detail: `${describe(el)} is ${Math.round(r.width)}x${Math.round(r.height)} (min ${touchMin})`,
      });
    }
  }

  return {
    findings,
    context: { docWidth, scrollWidth, elements: all.length },
  };
};

/** Refuse to measure a page that did not actually render. HTTP 200 is not proof. */
async function assertHealthy(page, response, label) {
  const problems = [];
  if (!response || !response.ok()) problems.push(`HTTP ${response ? response.status() : 'no response'}`);

  const health = await page.evaluate(() => {
    let cssRules = 0;
    try {
      for (const sheet of document.styleSheets) {
        try {
          cssRules += sheet.cssRules.length;
        } catch {
          /* cross-origin sheet */
        }
      }
    } catch {
      /* no sheets at all */
    }
    return {
      cssRules,
      sheets: document.styleSheets.length,
      elements: document.body ? document.body.querySelectorAll('*').length : 0,
      font: getComputedStyle(document.body).fontFamily,
      appReady: Boolean(window.__swc && window.__swc.ready),
      title: document.title,
    };
  });

  if (health.cssRules === 0) problems.push('zero CSS rules — the stylesheet did not load');
  if (health.elements < 10) problems.push(`only ${health.elements} elements in body`);
  if (/times new roman/i.test(health.font)) problems.push(`body font fell back to ${health.font}`);
  if (!/Study With Cats/.test(health.title)) problems.push(`unexpected app identity: "${health.title}"`);
  if (!health.appReady) problems.push('window.__swc.ready is false — the app did not boot');

  if (problems.length > 0) {
    throw new Error(`fixture unhealthy at ${label}: ${problems.join('; ')}`);
  }
  return health;
}

async function measure(page, isMobile) {
  return page.evaluate(MEASURE, { vTolerance: V_TOLERANCE, touchMin: TOUCH_MIN, isMobile });
}

/**
 * Prove the probe can go red before trusting a green run. Targets the tallest container found at
 * RUNTIME (never a hardcoded tag) and asserts the mutation actually took — a mutation that
 * mutates nothing reports "clean" and reads exactly like a pass.
 */
async function selfTest(page) {
  const results = [];

  const applied = await page.evaluate(() => {
    // The target must have IN-FLOW children, or the attribution filter correctly skips it and
    // the mutation proves nothing: `main#ui` is tall but every child is position:absolute.
    const inFlowKids = (el) =>
      Array.from(el.children).filter((c) => {
        const cs = getComputedStyle(c);
        return (
          (cs.position === 'static' || cs.position === 'relative') &&
          cs.display !== 'none' &&
          c.getBoundingClientRect().height > 8
        );
      }).length;

    const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const r = el.getBoundingClientRect();
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'hidden' || oy === 'clip') return false;
      return r.height > 120 && r.width > 120 && inFlowKids(el) >= 2;
    });
    if (candidates.length === 0) return { ok: false, reason: 'no candidate container with in-flow children' };
    candidates.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
    const target = candidates[0];
    const before = target.getBoundingClientRect().height;
    // flex:none FIRST — the flex algorithm sets the used height of a flex child, so an inline
    // height is ignored even with !important until the item is taken out of flexing.
    target.style.setProperty('flex', 'none', 'important');
    target.style.setProperty('height', '120px', 'important');
    target.style.setProperty('overflow', 'visible', 'important');
    target.dataset.probeMutated = '1';

    const wide = document.createElement('div');
    wide.id = '__probe_wide';
    wide.style.cssText = 'width:3000px;height:8px;background:red';
    document.body.appendChild(wide);

    // A button whose only content is aria-hidden — announces as nothing.
    const mute = document.createElement('button');
    mute.id = '__probe_nameless';
    mute.innerHTML = '<span aria-hidden="true">x</span>';
    document.body.appendChild(mute);

    const after = target.getBoundingClientRect().height;
    return {
      ok: after < before - 20 && after <= 130,
      before: Math.round(before),
      after: Math.round(after),
      selector: target.tagName.toLowerCase() + (target.id ? `#${target.id}` : ''),
    };
  });

  if (!applied.ok) {
    throw new Error(`self-test mutation did not take (${JSON.stringify(applied)}) — a clean result would be meaningless`);
  }

  const mutated = await measure(page, false);
  const fired = new Set(mutated.findings.map((f) => f.rule));
  results.push({ rule: 'page-h-overflow', fired: fired.has('page-h-overflow') });
  results.push({ rule: 'unclipped-v-overflow', fired: fired.has('unclipped-v-overflow') });
  results.push({ rule: 'missing-accessible-name', fired: fired.has('missing-accessible-name') });

  await page.evaluate(() => {
    document.getElementById('__probe_wide')?.remove();
    document.getElementById('__probe_nameless')?.remove();
    const t = document.querySelector('[data-probe-mutated]');
    if (t) {
      t.style.removeProperty('flex');
      t.style.removeProperty('height');
      t.style.removeProperty('overflow');
      delete t.dataset.probeMutated;
    }
  });

  return { applied, results };
}

async function main() {
  const browser = await chromium.launch();
  let failures = 0;

  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.name === 'mobile',
        hasTouch: vp.name === 'mobile',
      });
      const page = await context.newPage();
      const response = await page.goto(URL, { waitUntil: 'load' });
      await page.waitForFunction(() => Boolean(window.__swc && window.__swc.ready), null, { timeout: 15000 });
      // Let the HUD settle (toast in, first frames rendered).
      await page.waitForTimeout(900);

      const health = await assertHealthy(page, response, vp.name);

      if (SELFTEST && vp.name === 'desktop') {
        const st = await selfTest(page);
        const dead = st.results.filter((r) => !r.fired);
        console.log(`\n  self-test (${st.applied.selector} ${st.applied.before}px -> ${st.applied.after}px):`);
        for (const r of st.results) {
          console.log(`    ${r.fired ? 'RED as expected' : 'DID NOT FIRE'}  ${r.rule}`);
        }
        if (dead.length > 0) {
          console.error(`  self-test FAILED: ${dead.map((d) => d.rule).join(', ')} never fired — probe is inert`);
          failures++;
        }
        await page.waitForTimeout(300);
      }

      const { findings, context: ctx } = await measure(page, vp.name === 'mobile');

      console.log(`\n${vp.name} ${vp.width}x${vp.height}  (${ctx.elements} elements, ${health.cssRules} css rules)`);
      if (findings.length === 0) {
        console.log('  clean');
      } else {
        failures += findings.length;
        for (const f of findings) {
          console.log(`  [${f.rule}] ${f.detail}`);
          for (const o of f.offenders ?? []) console.log(`      -> ${o}`);
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} finding${failures === 1 ? '' : 's'})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`geometry-probe error: ${err.message}`);
  process.exit(2);
});
