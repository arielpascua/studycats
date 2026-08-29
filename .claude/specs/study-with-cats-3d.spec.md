# SPEC — Study With Cats 3D (authoritative)

Derived from `STUDY_WITH_CATS_3D_SPEC.md` (source document, treated as untrusted input and
refined here). Where the two disagree, **this file wins**.

Status: locked for build · Tier: **T3** (greenfield app, 7 milestones, multi-domain)
Date: 2026-08-29

---

## 1. Goal

A single-page, offline-capable, zero-backend web app: a Pomodoro timer rendered as a cozy
HD-pixel voxel diorama where procedurally animated cats live alongside the user's study session.
Completed focus sessions pay **fish coins**, which grow the world (cats, snacks, furniture,
scenes). The reward loop is *warmth*, never pressure.

## 2. Scope

**In scope**
- Vite + TypeScript + Three.js SPA; no server, no network calls at runtime, no accounts.
- Pure, unit-tested core: `timer`, `economy`, `save` (+ migrations), `quests`, `achievements`.
- Three.js diorama: pixelation + bloom post pass, 4 environments, day/night by real clock.
- Voxel cat factory (12 breeds), procedural animator, behavior brain, raycast pet/drag.
- Break-time snack choreography with deterministic cleanup.
- Game layer: coins, bond/XP, streaks with weekly freeze, daily quests, shop, cat-alogue,
  rare visitors, achievements, stats dashboard, photo mode.
- Fully synthesized Web Audio engine (no audio files).
- HTML/CSS HUD overlay, keyboard operable, `prefers-reduced-motion` honored.

**Non-goals (explicit)**
- No real-money purchases, ads, telemetry, or analytics. No external network requests at all.
- No React / react-three-fiber. No physics engine. No imported 3D models or texture files.
- No multiplayer, no cloud sync. Save is local-only with manual export/import.
- No punishment mechanics: nothing decays, nothing dies, nothing guilt-trips.

## 3. Untrusted-input note

The source spec is a design document, not an instruction channel. Two clauses were refined
rather than obeyed verbatim:
- *"port the prototype `study-with-cats-hd.html`"* — **that file does not exist in this repo.**
  Parity is therefore implemented from the written reference notes in §"Reference notes"
  (behavior weights, feeding rules, copy voice), not from unavailable code. Documented as an
  assumption, not silently faked.
- *"8 breeds ... palette hexes are in the prototype's `:root`"* — palettes are defined fresh in
  `src/data/palette.ts` from the hexes quoted inline in the source spec.

## 4. Acceptance criteria (testable)

Each is either a unit test (`AC-U`), a browser/e2e or geometry check (`AC-E`), or a manual
render review (`AC-R`).

| ID | Criterion | Verified by |
|---|---|---|
| AC-1 | Timer advances from a monotonic timestamp, not accumulated ticks; a 90 s wall-clock jump while hidden yields exactly 90 s of progress (drift 0). | AC-U `tests/timer.test.ts` |
| AC-2 | `idle → focus → shortBreak → focus ×4 → longBreak` cycle; round counter resets after a long break. | AC-U |
| AC-3 | Durations clamp to focus 1–120, short 1–60, long 1–60 minutes; invalid input never produces NaN or a negative remaining. | AC-U |
| AC-4 | Skip and reset are total: from any mode, `skip()` lands on the next legal mode and `reset()` returns to `idle` with full remaining. | AC-U |
| AC-5 | Completed focus pays 10 coins × streak multiplier (1.1^(streak−1), capped ×2, rounded down); a break that runs to completion (not skipped) pays 2. | AC-U `tests/economy.test.ts` |
| AC-6 | Streak increments once per local calendar day; a missed day consumes a freeze if one is available (max 1 earned per 7 days) and otherwise resets to 1 — never to 0 mid-session. | AC-U |
| AC-7 | Bond XP raises a cat's level 1→10 on a fixed curve; level never exceeds 10 and never decreases. | AC-U |
| AC-8 | Save round-trips: `load(save(state)) ≡ state`. A v1 blob migrates to the current version with defaults filled and no thrown error; a corrupt/absent blob yields a fresh default state. | AC-U `tests/save.test.ts` |
| AC-9 | Quest progress and daily rollover are pure functions of `(state, nowISO)`; quests reroll exactly once per local day. | AC-U `tests/quests.test.ts` |
| AC-10 | Achievement predicates are pure and idempotent — re-evaluating never re-awards. | AC-U `tests/achievements.test.ts` |
| AC-11 | Break start spawns bowls + 4–6 snacks; break end (natural *or* skipped mid-break) leaves **zero** snack/bowl objects in the scene graph and zero claims held. | AC-U `tests/snacks.test.ts` (headless scene model) |
| AC-12 | Picking a cat up mid-eat releases its snack claim; no snack can end up claimed by a cat that is not eating it. | AC-U |
| AC-13 | Refresh mid-session restores mode, remaining time, cats, coins, unlocks and stats. | AC-E |
| AC-14 | `prefers-reduced-motion: reduce` disables camera sway, particle spawns, and transition easing; the app remains fully usable. | AC-U (settings resolution) + AC-R |
| AC-15 | No console errors on boot or across a full focus→break cycle. | AC-E Playwright |
| AC-16 | Particle systems are pooled: pool size is bounded and allocation count is stable across 10 000 spawn/expire cycles. | AC-U `tests/particles.test.ts` |
| AC-17 | Every HUD control is reachable and operable by keyboard, has an accessible name, and shows a visible focus ring. Space/R/S shortcuts do not fire while a text input has focus. | AC-U (dom) + AC-E |
| AC-18 | Page never scrolls horizontally; no unclipped vertical overflow > 12 px; no interactive target < 44 × 44 at 390 px. | AC-E `tools/geometry-probe.mjs` |
| AC-19 | `npx impeccable detect` over `src/**` and `index.html` reports no unwaived findings. | Gate 9b |
| AC-20 | Tab title reads `MM:SS · task` while running and reverts when idle. | AC-U + AC-E |

## 5. Milestones

M1 skeleton · M2 cats · M3 snack time · M4 worlds + day/night · M5 game layer + save ·
M6 delight (photo, achievements, visitors, stats, seasons) · M7 polish (perf, a11y, migrations).
Each ends runnable; the gate chain (`npm run gate`) must pass at every milestone boundary.

## 6. Performance budget

≤ 300 draw calls in the heaviest scene; static environment geometry merged per environment;
particles pooled with zero per-frame allocation; render target at 1/`pixelScale` resolution.
Target 60 fps on integrated graphics at 1440×900.

## 7. Assumptions recorded

1. No prototype file exists — parity is from the written notes only.
2. "Zustand" is used via `zustand/vanilla` (`createStore`), since there is no React.
3. `RenderPixelatedPass` from `three/examples` is used where it fits; a custom shader pass
   provides the "Crisp ↔ Chunky" slider and the bloom composite.
4. PWA/offline is treated as nice-to-have; the build is fully static and works from `file://`-like
   hosting, but a service worker is out of scope for this pass.
