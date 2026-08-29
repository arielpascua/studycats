# STUDY WITH CATS 3D — Project Spec for Claude Code

> A cozy, game-like Pomodoro timer where you study alongside a diorama of pixel-voxel cats.
> This document is the single source of truth. Build it phase by phase (see **Milestones**).
> A working 2D HTML prototype exists (`study-with-cats-hd.html`) — treat it as the reference
> for timer logic, cat behavior states, break-time feeding, and generative audio. This project
> ports that experience into a Three.js 3D diorama with real game systems on top.

---

## 1. Vision

- **One-line pitch:** Tamagotchi × Pomodoro. Focus sessions earn you fish coins; fish coins grow
  your cat café. The longer you consistently study, the cozier and more alive your world becomes.
- **Aesthetic:** pastel lavender "lofi study girl" poster style — but as a 3D voxel/low-poly
  diorama with a retro pixelated render (HD-2D feel, like Octopath Traveler's cozy cousin).
- **Emotional goal:** the user *wants* to come back tomorrow — not because of guilt, but because
  their cats will be there, the room will be golden-hour lit, and there's a new snack to unlock.
- **Never hostile:** no punishments for missing days. Streaks pause, cats never die or get sad
  in a guilt-trip way. This is a sanctuary, not a slot machine.

## 2. Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Bundler/dev | **Vite + TypeScript** | fast HMR, single-page app |
| 3D | **Three.js** (latest) | core renderer; no physics engine needed |
| Post-processing | `EffectComposer` + custom **pixelation pass** + bloom | this creates the "HD pixel" look |
| State | **Zustand** | one store per domain: timer, cats, economy, settings |
| Persistence | `localStorage` (wrap in a versioned `save/load` module) | full save system, see §10 |
| Audio | **Web Audio API** (port the generative engine from the prototype) | no audio files needed; optional: add Howler later for music tracks |
| UI overlay | HTML/CSS on top of the canvas (no 3D text for menus) | Quicksand + Silkscreen fonts, same palette vars as prototype |
| Charts (stats page) | plain `<canvas>` 2D (keep deps minimal) | |
| Tests | Vitest for timer math, economy math, save migration | |

**No React** unless it clearly simplifies the HUD — a small custom DOM layer is fine and keeps
the game loop simple. If you do use React, keep Three.js OUTSIDE React (no react-three-fiber;
imperative scene code is easier to tune here).

## 3. Repo Layout

```
study-with-cats-3d/
├── index.html
├── src/
│   ├── main.ts                 # boot, game loop, resize
│   ├── core/
│   │   ├── timer.ts            # pomodoro state machine (pure, tested)
│   │   ├── economy.ts          # coins, XP, streaks (pure, tested)
│   │   ├── save.ts             # versioned localStorage save/load/migrate
│   │   └── events.ts           # tiny event bus (timer → scene reactions)
│   ├── scene/
│   │   ├── renderer.ts         # renderer, composer, pixelation+bloom passes
│   │   ├── camera.ts           # framing, gentle idle drift, focus zoom
│   │   ├── environments/       # room.ts, picnic.ts, bonfire.ts, cafe.ts
│   │   ├── props/              # laptop.ts, plant.ts, snacks.ts, furniture.ts
│   │   ├── cats/
│   │   │   ├── catFactory.ts   # builds a voxel cat mesh from a breed def
│   │   │   ├── catAnimator.ts  # procedural pose/keyframe animation
│   │   │   └── catBrain.ts     # behavior state machine (port from prototype)
│   │   ├── fx/                 # particles: fireflies, sparks, rain, motes, hearts
│   │   └── picking.ts          # raycast drag/pet interactions
│   ├── audio/engine.ts         # generative lofi/rain/purr/chime/nom (port)
│   ├── ui/
│   │   ├── hud.ts              # timer chip, dots, start/reset/skip
│   │   ├── panels.ts           # cats / scene / sound / setup popovers
│   │   ├── shop.ts             # snack & furniture & adoption shop
│   │   ├── stats.ts            # dashboard + charts
│   │   └── toasts.ts           # achievement & reward toasts
│   └── data/
│       ├── breeds.ts  snacks.ts  furniture.ts  achievements.ts  quests.ts
└── SPEC.md (this file)
```

## 4. The Look: "HD-Pixel Diorama"

1. **Scene = a small floating diorama** (like a chunky island slab, ~16:10 footprint) viewed from
   a fixed, slightly-high 3/4 angle. Orthographic-ish perspective (`fov ≈ 28`) so it reads flat
   and illustrative, not gamer-y.
2. **Geometry style:** voxel/box-based. Cats, furniture, and props are built from `BoxGeometry`
   clusters (rounded via `BoxGeometry` + subtle scale, or use `RoundedBoxGeometry` from examples).
   NO smooth character meshes — chunky is the brand.
3. **Materials:** `MeshToonMaterial` (2-step gradient map) or flat `MeshLambertMaterial`, pastel
   palette from the prototype (`#C7BFEA` walls, `#FBF2F4` cat cream, `#F0B7C9` pink patches…).
4. **Pixelation pass:** render at ~1/4 resolution and upscale with nearest-neighbor
   (`RenderPixelatedPass` from three/examples works). Expose a "Crisp ↔ Chunky" slider in settings.
5. **Lighting:** one warm key `DirectionalLight` + ambient; per-environment accents
   (fire = flickering orange `PointLight`; café = two warm lamp point lights; room = window light
   shaft). Soft shadow map ON (512–1024) — shadows sell the diorama.
6. **Camera life:** slow 3–5px orbital sway when idle; on focus start, a 1s ease-in dolly toward
   the laptop; on break, dolly back + slight lift ("stretch and look around" feeling).
7. **Day/night tied to the user's real clock:** sky color, window light, and lamp states shift
   across morning / afternoon / golden hour / night. Studying at 11pm should FEEL like 11pm.

## 5. Pomodoro Core (port exactly, then extend)

State machine (pure module, no DOM):

```
idle → focus(25m) → shortBreak(5m) → focus → … → longBreak(15m after 4 rounds) → …
```

- Editable durations (1–120 / 1–60 / 1–60), auto-start toggle, session dots (4).
- Space = start/pause, R = reset, S = skip. Tab title shows `MM:SS · task`.
- Task input ("What are you studying today?") — shown on the laptop screen in 3D as tiny
  pixel text (render to a `CanvasTexture`).
- **Tick source:** `performance.now()` deltas, never `setInterval` drift. Timer must survive
  tab-throttling (recompute remaining from a timestamp on visibilitychange).
- End-of-session chime (generative, port from prototype).

## 6. Cats

### 6.1 Construction
- `catFactory(breed)` assembles: body (capsule of boxes), head (oversized box, poster-style),
  2 triangle-prism ears (one patch-colored), 4 leg boxes, segmented tail (4–5 boxes, tip in
  accent color), face decal via small dark boxes or a `CanvasTexture` face plane
  (eyes/nose/blush swap per emotion).
- 8 breeds from the prototype (Strawberry, Snow, Calico, Latte, Peach, Mist, Shadow, Matcha)
  + 4 **unlockable rares**: Void (all-black, glowing eyes), Boba (spots like tapioca pearls),
  Sakura (petal pattern), Robo (slightly metallic, antenna — Easter egg).

### 6.2 Animation (procedural, no imported clips)
- Poses: stand/walk (leg swing + body bob), sit, loaf-sleep (breathing scale), play-bow
  (batting a yarn ball with physics-lite spring), eat (head-down bob), lounge (on side, tail
  flick), pet (squash + ^‿^ face + blush), stretch.
- Tail = ideal candidate for per-segment sine chains; ears twitch randomly every 6–14s.
- Walk = actual movement across the diorama floor with obstacle avoidance (simple: waypoints
  avoid prop bounding circles).

### 6.3 Behavior brain (port from prototype)
- Focus running → mostly sleep/sit (they study with you, calmly).
- Break → **feeding scene** (see §7).
- Otherwise → wander/sit/sleep/play mix.
- **Interactions:** click = pet (purr + hearts + bond XP), drag via raycast onto floor or onto
  furniture surfaces (shelf, cushion, log…), double-click = cat does a trick if bonded (see §8.4).

## 7. Break Time = Snack Time (signature moment — polish this hard)

When a focus session completes:
1. Laptop lid animates closed (hinged rotation), screen light goes out.
2. "SNACK TIME!" toast + soft chime.
3. Two bowls (milk, kibble) slide in; 4–6 random snacks **drop with a bounce** onto the floor
   (scale-punch on landing). Snack pool is per-environment (onigiri/melon/marshmallow/croissant…).
4. Cats stretch, then pathfind to claimed snacks and eat (nom blips). Snacks shrink per bite
   and pop away with a sparkle.
5. Bonfire scene special: one cat roasts a marshmallow on a stick at the fire.
6. When break ends: leftovers pop away, laptop reopens with a little boot-up flicker, cats
   settle back down. Fully deterministic cleanup — no orphaned snack meshes.

## 8. GAME SYSTEMS (the "fun to visit" layer)

### 8.1 Economy — Fish Coins 🐟
- +10 coins per completed focus session (+streak multiplier: ×1.1 per consecutive day, cap ×2).
- +2 coins per break where you actually let it run (don't skip).
- Spend on: adopting cats (rares cost more), snack varieties, furniture, scene decorations,
  radio stations, camera filters for photo mode.
- **No purchases with real money. Ever. No ads. This is a gift, not a funnel.**

### 8.2 Bond & XP
- Petting, feeding-time presence, and completed sessions raise each cat's **bond level** (1–10).
- Bond milestones unlock: name tag color, a trick (spin, high-five, flop), a unique idle
  animation, and at max — the cat brings you a "gift" (random cosmetic) once per day.

### 8.3 Streaks & Quests
- Daily streak = at least 1 completed pomodoro. Missed day → streak "freezes" (one free freeze
  per week, shown as a snowflake) instead of resetting. Kindness-first.
- 3 rotating daily quests, e.g. "finish 3 pomodoros", "study 50 min in the café",
  "pet every cat once". Each pays coins.

### 8.4 Collection & Discovery
- **Cat-alogue:** a Pokédex-style book of breeds, tricks seen, snacks tasted, and visitors met.
- **Rare visitors:** ~8% chance per completed pomodoro that a wild visitor appears at the
  diorama edge (pigeon, hedgehog, a mysterious black cat in the rain). Click to log it.
- **Seasonal touches** by real date: sakura petals (Mar–Apr), rain season, snow + scarf cats
  (Dec–Jan), fireflies peak in summer evenings.

### 8.5 Furniture & Room Customization
- Shop: rugs, wall art, cat tower (a NEW climbable surface!), fairy-light colors, mug designs,
  window view variants. Placement = drag from a tray onto valid floor/wall slots (slot-based,
  not freeform — avoids jank).

### 8.6 Photo Mode
- Pauses brains, hides HUD, free-ish camera on rails, filters (film grain, warm, night),
  optional frame with "STUDY WITH CATS · {date} · {n} pomodoros". Export PNG (renderer
  `preserveDrawingBuffer` snapshot). This is the shareable/viral artifact.

### 8.7 Stats Dashboard
- Today / week / all-time: pomodoros, minutes, best streak, favorite scene, most-petted cat.
- Heatmap calendar (GitHub-style) + minutes-per-day bar chart on 2D canvas.

### 8.8 Achievements (toast + Cat-alogue page)
Examples: "First Focus", "Night Owl" (finish a session after midnight), "Full House" (8 cats),
"Gourmet" (all snacks tasted), "Marathon" (8 pomodoros in a day), "Best Friends" (bond 10),
"Weather Watcher" (study in all 4 scenes), "???" (Konami code → Robo cat visits).

### 8.9 Juice & Delight (small, constant)
- Every button: squash/stretch + soft blip. Timer chip pulses on the last 10 seconds.
- Confetti of tiny fish when a session completes.
- Cats occasionally: knock the mug over (it rights itself), chase a butterfly, sit ON the
  laptop keyboard during breaks (typing gibberish appears on screen).
- Idle > 2 min with timer off → a cat walks to the camera and paws at the screen.

## 9. Audio
Port the generative engine wholesale: lofi chord pads (Cmaj9/Am7/Fmaj7/G7sus, ~3.4s bar,
vinyl crackle), brown-noise rain, chimes, purr, nom. Add: per-scene ambience layers
(birds for picnic, crackle for bonfire, café murmur = filtered noise bursts), and 3 unlockable
"radio stations" (different chord sets/tempos). Master volume + per-bus sliders. All synthesized.

## 10. Save System
- Single JSON blob in `localStorage`, `{version, timer, cats[], economy, unlocks, stats, settings}`.
- Save on every meaningful event + `beforeunload`. Migrations keyed by version int.
- "Export save / import save" buttons (copy-paste JSON) — users love not losing their cats.

## 11. Accessibility & Performance Budgets
- Respect `prefers-reduced-motion`: no camera sway, no particles, instant transitions.
- Full keyboard operation of the HUD; focus rings; ARIA on all controls (port prototype patterns).
- 60fps on a mid laptop: ≤ 300 draw calls, merged static geometry per environment,
  particle pools (no per-frame allocation), pixelated render pass keeps fill-rate cheap.
- Works offline after first load (optional: vite-plugin-pwa, nice-to-have).

## 12. Milestones (build in this order; each ends runnable)

1. **M1 Skeleton:** Vite+TS+Three boot, pixelation pass, Cozy Room diorama (static), HUD with
   full working pomodoro (port `timer.ts` logic + tests). Laptop + plant props.
2. **M2 Cats alive:** catFactory + 3 poses (sit/walk/sleep) + brain + pet/drag raycasting +
   purr/hearts. Generative audio engine in.
3. **M3 Snack time:** break scene choreography end-to-end (laptop lid, bowls, snacks, eating).
4. **M4 Worlds:** picnic, bonfire (fire light + particles), café (rain) + day/night cycle.
5. **M5 Game layer:** economy, bond, streaks, quests, shop (snacks+furniture), save system.
6. **M6 Delight:** photo mode, achievements, visitors, stats dashboard, seasonal FX, Easter eggs.
7. **M7 Polish pass:** perf audit, a11y audit, reduced-motion path, save migrations test.

## 13. Acceptance Checklist (QA before "done")
- [ ] Timer is drift-free across tab suspend/resume; title always correct.
- [ ] Break → snack scene always spawns and always fully cleans up (skip mid-break too).
- [ ] Dragging a cat mid-eat never leaves a claimed-snack deadlock.
- [ ] Refresh mid-session restores mode, remaining time, cats, coins.
- [ ] `prefers-reduced-motion` produces a calm, static-but-usable app.
- [ ] No console errors; no memory growth across 30 min (particle pools verified).
- [ ] Lighthouse a11y ≥ 95.

---

### Reference notes from the 2D prototype (for parity)
- Behavior weights: focusing → sleep .45 / sit .37 / walk .18; break → seek-snack .7 else lounge/walk.
- Feeding rules: bowls are infinite, snacks have 2 bites, max 2 cats per bowl, 1 per snack.
- Breed palette + UI palette variables are in the prototype's `:root` and `BREEDS` array — reuse hexes.
- Keep the voice: labels like "WHERE ARE WE STUDYING?", "SNACK TIME!", "SEND HOME".
