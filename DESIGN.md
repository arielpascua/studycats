# DESIGN.md — Study With Cats 3D

Wave 0 design contract. Wave 1 implements *this file*, not its own taste. Wave 2 reviews the
**render** against it.

---

## 0. Refinement vs. redesign

**Greenfield / original design.** No incumbent visual authority exists in this repo: no tokens,
no CSS, no shipped components — only a prose spec. The visual world is authored from scratch
here. (Per 8a-i: a missing `DESIGN.md` alone would not settle this; the *absence of any styled
artifact in the tree* does.)

## 0.1 REFERENCE — the product this build is trying to beat

```
REFERENCE: poolside.fm — https://poolside.fm
           the bar for: retro-aesthetic chrome cohesion + atmosphere
```
Why this one: it is real, currently shipping, and directly inspectable; it holds a nostalgic
pixel/retro identity across *every* control — buttons, sliders, window chrome, the audio player,
the cursor — rather than only in a hero image. That consistency is the axis we must match. It is
**not** the bar for 3D, for information density, or for data display; nothing is the bar for
everything.

The falsifiable question for the blind A/B in gate 9a-i: *given two unlabeled screenshots at the
same viewport, does ours hold its aesthetic as far into the small controls as poolside.fm holds
its own?*

---

## 1. Aesthetic direction

**"HD-pixel diorama, lit at golden hour, seen through a paper viewfinder."**

Three commitments, in priority order:

1. **The scene is the hero.** Chrome occupies the margins. Nothing opaque covers the diorama's
   centre third. Panels enter from an edge and are dismissible with `Esc`.
2. **Everything is on a pixel grid.** Radii, borders, shadows and motion all quantize. No
   sub-pixel blur, no soft drop shadows — shadows are *offset hard blocks* (`4px 4px 0`), the
   way a sticker sits on paper. This single rule does most of the anti-slop work.
3. **Warmth over contrast.** The palette is lavender-dusk and peach. Secondary text is a
   **desaturated plum tinted from the hue — never gray** (craft-floor rule).

## 2. Type

| Role | Family | Fallback stack | Usage |
|---|---|---|---|
| Display / labels | **Silkscreen** (400/700) | `"Silkscreen", "Courier New", monospace` | ALL-CAPS chrome labels, timer digits, toasts. `letter-spacing: 0.08em`. Never below 10px, never above 40px. |
| Body / UI | **Quicksand** (400/500/600/700) | `"Quicksand", "Trebuchet MS", "Segoe UI", sans-serif` | Sentence copy, inputs, numbers in the stats page. |

- Fonts are **self-hosted woff2** in `public/fonts/` — no Google Fonts CDN, no network at runtime.
- Display type is capped at **2.5rem** (`--fs-display`); the source spec's poster feel comes from
  *scale contrast inside a small range*, not from 6rem hero text.
- **Functional text floor: 11px** (`--fs-label`). Every chrome label, price and micro-heading sits
  at or above it. Silkscreen is a bitmap face and the first pass ran labels down to 8px, which is
  unreadable on a normal display however neatly it sits on the ramp.
- Tracking floor for anything ≥ 2rem: `-0.01em` on Quicksand; Silkscreen keeps positive tracking
  because it is a bitmap face (the −0.04em craft-floor rule is for humanist display faces and
  would collide the pixel glyphs — **documented deviation, deliberate**).
- Body measure: `--measure: 62ch` on prose blocks (Quicksand runs narrow; 62ch measures ≈ 68
  characters — verified rather than assumed, per the IBM-Plex `ch` lesson).

## 3. Color tokens

Authoritative values. Wave 1 must use the CSS custom properties, never raw hexes.

```css
/* --- surface (paper overlay) --- */
--paper:        #FBF2F4;  /* cream, the HUD's paper ground        */
--paper-2:      #F3E6EC;  /* recessed paper                        */
--ink:          #3B2A44;  /* deep plum — ALL body text             */
--ink-soft:     #5C4767;  /* secondary text: plum-tinted, NOT gray */
--ink-faint:    #736080;  /* tertiary / dimmed-but-still-readable  */
--line:         #3B2A44;  /* hard 2px borders, same as ink         */

/* --- brand --- */
--lav:          #C7BFEA;  /* lavender, the room                    */
--lav-deep:     #9C8FD4;  /* lavender pressed / active             */
--pink:         #F0B7C9;  /* cat patch pink, primary accent        */
--pink-deep:    #D98BA6;
--peach:        #F6C99F;  /* golden-hour light                     */
--mint:         #A9D6C0;  /* success / positive                    */
--butter:       #F5E1A4;  /* coins, highlights                     */

/* --- semantic --- */
--focus-hue:    var(--pink);    /* focus mode chrome */
--break-hue:    var(--mint);    /* break mode chrome */
--coin:         #F2B441;
--danger:       #C96A72;        /* muted brick, never pure red     */
--ring:         #3B2A44;        /* focus ring, 3px offset 2px      */
```

**Forbidden:** any `linear-gradient` between two hues more than 60° apart; gradient-filled text;
`color: gray/#666/#888` anywhere; pure `#000` or `#fff`; `backdrop-filter: blur` on panels.
A single vertical gradient *within one hue* (e.g. `--peach` → `--butter`) is allowed for the sky
only, inside the 3D scene.

## 4. Space, shape, elevation

- Scale (px): `2 4 8 12 16 24 32 48 64` — token `--s1..--s9`. Everything snaps to it.
- Radius: `--r: 6px` on panels, `--r-sm: 4px` on controls, `0` on pixel-art elements. Nothing
  fully rounded except the coin chip.
- Border: **`2px solid var(--line)`** on every raised surface. This is the signature.
- Elevation: `box-shadow: 4px 4px 0 var(--line)` (hard). Pressed state: shadow → `2px 2px 0`
  plus `translate(2px, 2px)`. **No blurred shadows anywhere in the HUD.**

## 5. Motion

One authored moment, not scattered effects.

| Moment | Spec |
|---|---|
| Button press | `translate(2px,2px)` + shadow shrink, 90 ms `steps(2)` — stepped, not eased, to stay on the pixel grid. |
| Panel open | slide from its own edge, 220 ms `cubic-bezier(.2,.8,.3,1)`, opacity 0→1 over the first 120 ms. |
| Session complete | **the authored moment**: 900 ms — timer chip punches to 1.08 and back, fish confetti falls, chime, camera dollies back. Everything else in the app is quieter than this. |
| Timer last 10 s | chip pulses 1.0→1.03, 1 s loop, `ease-in-out`. |
| Camera idle sway | ±0.04 rad, 24 s period. |
| Orbit / zoom | user-driven: drag orbits within **180°–270°** azimuth and **14°–40°** elevation; scroll/pinch zooms 0.5×–1.2× of the fitted distance. Damped, never snapped. |

- **No `cubic-bezier` with overshoot** (`bounce-easing` is a detector rule and an anti-reference
  tell). The only springy thing in the product is a cat.
- `prefers-reduced-motion: reduce` → all durations to `0.01ms`, sway off, particles off,
  camera dolly instant. Verified by test, not by eye.

### 5.1 Framing: you are *inside* the room

The viewer stands in the room; they do not look at a model of one. That is enforced by two
volumes with deliberately **opposite** guarantees, and confusing them is the fastest way to
break the scene:

| Volume | Guarantee | Where it lives |
|---|---|---|
| **FOCUS** — a box around the desk cluster | the camera must **contain** it: the laptop and the cats beside it are never cropped | `FOCUS_WIDE` / `FOCUS_TALL` in `scene/camera.ts` — declared constants, never measured from the scene graph |
| **SHELL** — the room interior | the eye must never **escape** it: walls, floor and ceiling always run off the frame edges | `shell` on each `EnvironmentDef` |

Distance is therefore `min(containFit(FOCUS), interiorLimit(SHELL))` — fitted to the small
volume, capped by the big one.

**The trap this replaced.** The first version fitted the camera to the whole world bounding box.
That made the camera a *function of the geometry*: every extra unit of wall bought another unit
of standoff, so the room could never grow around the viewer — it just pushed them further away.
Measured at the time: **100% of the frame's edge was empty sky at every angle**, with 45–70% of
the whole frame background. That number is why the phrase "nothing is ever cropped" no longer
appears here — it was the guarantee that produced the wrong picture.

**Consequences that are not negotiable:**

- The lens is **46°** at rest (42° focus, 50° break), against 28° before. This is arithmetic,
  not taste: at 28° even a desk-sized box needs ~12 units of standoff, which is outside the room.
  An interior view requires an interior lens. It does mean voxel cubes keystone more toward the
  frame edges, and the long-lens miniature look is gone — that look *was* the problem.
- Every mood's distance multiplier is **1.0**. Standing inside a room, "pull back" is not
  available; break expresses itself with a wider lens and a raised eyeline instead.
- `floor` on an `EnvironmentDef` is the **gameplay footprint** (where cats wander, where snacks
  scatter). `shell` is the **visual room**. They are separate on purpose and must stay separate:
  a room that grew the play area would have cats roaming off-camera.
- The far walls stay at their original planes (`shell.minZ = -4.0`, room `minX = -5.5`). The
  shell grows only toward the viewer, into space behind the eye. This is load-bearing: the
  window, shelf, skirting and every furniture slot anchor are positioned from those planes.

**Verified numerically, not by eye.** Two probes, pointed at the two different volumes:

- `__swc.enclosure()` renders one frame with the sky swapped for sentinel magenta and samples
  the result, so "can the viewer see out of the room" is a percentage rather than an opinion.
  Measured after: **0% sky on every edge, 0 open corners**, for room and café, across the full
  180°–270° arc, 14°–40° elevation and 0.5×–1.2× zoom. Outdoors (picnic, bonfire) the bottom and
  side edges are 0% and sky appears only along the **top** edge, which is correct on a hill.
- `__swc.fitCheck()` projects the FOCUS corners and reports the worst |NDC|, plus which term set
  the distance. Measured worst case across 32 sampled poses: **0.977** — the desk is never
  cropped in the working band. `tests/framing.test.ts` pins both invariants headlessly over
  2000+ poses.

## 6. Layout & composition

```
┌───────────────────────────────────────────────┐
│ ◄ coins / streak chip           settings ► │  ← 56px top rail, transparent
│                                               │
│                                               │
│              ( the diorama )                  │  ← untouched centre third
│                                               │
│                       ┌─────────────────────┐ │
│  scene switcher ►     │  TIMER CHIP         │ │  ← bottom-right anchor
│  (edge tabs)          │  25:00 · thesis     │ │
│                       │  ● ● ○ ○   ▶ ↻ ⏭    │ │
└───────────────────────┴─────────────────────┴─┘
```
- Mobile (≤ 720px): the timer chip becomes a full-width bottom bar; panels become bottom sheets
  covering ≤ 70vh; the diorama keeps the top 30vh minimum. Touch targets ≥ 44×44 everywhere.
- Panels are `position: fixed`, max 380px wide, never centered modals except the photo frame.

## 7. Required states (`harden`, 8b-iii)

Every interactive surface ships all of: **default · hover · focus-visible · active · disabled ·
loading · error · empty**. Specifically:
- **Shop with 0 coins** → items dim to `--ink-faint`, price chip turns `--danger`, copy reads
  "finish a session to earn 🐟" — never a bare disabled button.
- **Cat-alogue with nothing discovered** → silhouette cards with `???`, plus one line of what
  unlocks them.
- **Stats with no history** → "your first session goes here", chart axes still drawn.
- **Save import with bad JSON** → inline error naming *both* problem and recovery
  ("that isn't a Study With Cats save — paste the whole `{…}` block, including the braces").
- **Photo mode while a snack drop is mid-flight** → still captures; no half-state.

## 8. Accessibility contract

- All controls are real `<button>`/`<input>`; ARIA only where semantics are genuinely absent.
- Focus ring: `outline: 3px solid var(--ring); outline-offset: 2px` — visible on **every**
  focusable element, including the canvas (which is `tabindex=0` with keyboard cat selection).
- Live regions: timer announces mode changes politely; toasts are `role="status"`.
- Contrast, **measured against every surface each token actually lands on** — not just paper,
  which is how the first pass shipped a 3.5:1 failure. All values AA-passing for body text:

  | | on `--paper` | on `--paper-2` | on `--lav` | on `--pink` | on `--mint` | on `--butter` |
  |---|---|---|---|---|---|---|
  | `--ink` #3B2A44 | 11.9 | 10.1 | 7.5 | 7.7 | — | 8.2 |
  | `--ink-soft` #5C4767 | 7.5 | 6.8 | 4.7 | 4.8 | 5.1 | 6.3 |
  | `--ink-faint` #736080 | 5.2 | 4.7 | — | — | — | — |

  `--ink-faint` is for *dimmed* content (an item you cannot afford yet), which the reader still
  has to be able to read — so it clears 4.5:1 rather than being a decorative gray. No text on
  `--lav-deep` below 18px.
- Keyboard shortcuts are suppressed while an `<input>`/`<textarea>` has focus.


## 9. Party mode and the five venues

Party mode is local and account-free (`PRODUCT.md`: no network call after first load). A friend's
cat arrives as a **cat card** — a base64url blob with an FNV checksum, pasted in by hand — so the
roster is real without a server being real. Each member is one player and one cat, labelled
`Mochi (Alice)`.

### One builder, five places

`src/scene/environments/arena.ts` is a single builder; `src/data/venues.ts` supplies values.
The clearing, the library, the café, the rooftop and the museum are the same skeleton:

| | floor disc | seats + posts | hearth | surround |
|---|---|---|---|---|
| Moonlit clearing | stone island on water | cushions, lanterns | campfire, 5 flame tiers | treeline, open sky |
| Night library | wood, rug rings | cushions, green lamps | reading lamp, stacked shades | shelves of books |
| Late café | warm wood | cushions, warm sconces | espresso bar, rising steam | lit window panes |
| Rooftop class | rooftop tile | cushions, lanterns | rooftop lantern | city skyline, open sky |
| Quiet museum | marble | benches, uplights | exhibit crystal | colonnade + gallery wall |

This is deliberate. Five hand-built scenes would be five chances to get the party scaling wrong;
one builder means **every** venue widens with the roster, because there is only one place where
the widening is written.

### Rules the venues have to obey (and the tests that pin them)

- **`shell.ceiling` is the eye's limit, and an interior has a real lid.** Left at the open-sky
  value, the camera rig climbed *above* the ceiling while framing a break and rendered the room
  from the roof — a black screen. `arenaDefFor` derives the shell ceiling from the venue's lid.
- **A gapped surround needs a backdrop.** A colonnade you can see between leaked 29% of the
  frame's top edge to bare background. One merged wall ring behind it, one draw call.
- **Bands bucket by colour across every row before merging.** A wall of books is 150 boxes in
  7 colours: bucketed, that is 7 draw calls; merged per row it was 42, which put the arena
  exactly on its 300-call ceiling.
- **Posts take keepouts.** The laptop stand sits behind the ring, and for even party sizes a
  post gap lands in exactly that spot — the two were drawn inside each other. The stand passes
  its own circle in rather than the arena hardcoding where the furniture is.
- **The point light never casts.** A `PointLight` shadow is a cube map: six extra scene renders.
  The key light casts; the hearth only lights. In the picture you cannot tell.
