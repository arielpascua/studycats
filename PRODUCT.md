# PRODUCT.md — Study With Cats 3D

## What it is
A Pomodoro timer that is also a place. You set a task, press start, and study inside a small
floating diorama where voxel cats doze on the rug beside your laptop. Finish a session and the
cats get a snack; over weeks the room fills with things you earned.

## Who it's for
Students and remote workers who bounce off productivity software. They have tried the app with
the streak counter that shamed them and the one with the leaderboard. They want a reason to open
the tab that isn't discipline. They are the audience for a Tamagotchi, grown up.

## Positioning
> Not a productivity tool with a mascot. A room you keep, that happens to keep time.

Competitors optimize *compliance* — streak guilt, loss aversion, notification pressure.
This optimizes *return*: the room is nicer than when you left it.

## Voice
Lowercase-warm, never cute-cloying, never corporate. Short. Slightly hand-written.
- Headings shout gently in the retro-pixel face: `SNACK TIME!`, `WHERE ARE WE STUDYING?`,
  `SEND HOME`.
- Body is calm and second-person: "your cats are waiting", not "Optimize your focus sessions."
- **Never**: "productivity", "hustle", "grind", "unlock your potential", "level up your focus",
  "don't break the chain". No exclamation marks outside the pixel-caps labels.
- Failure states apologize to *you*, never blame you. A missed day says "streak frozen ❄" and
  moves on.

## Non-negotiables
1. No real money. No ads. No analytics.
2. Nothing in the world can be lost, starve, decay, or express disappointment.
3. Missing a day is a weather event, not a verdict.
4. **Single player never needs the network or an account.** Adopt, study, feed, decorate and
   earn coins entirely offline, exactly as before. If the server is down, gone, or never
   reached, the game is unaffected — only the party is.

### Amended 2026-08-30: accounts and the network

Rule 1 used to read "No real money. No ads. No analytics. No account. No network call after
first load." The owner has deliberately reversed the account and network clauses in order to
build **real** multiplayer: a host starts a party, gets a join code, and friends on their own
devices join it live.

This is recorded rather than quietly dropped, because the old rule was load-bearing — it is why
party mode was first built as offline cat cards, and anyone reading that code needs to know it
was a constraint that changed, not an oversight.

What the reversal does and does not license:

- **Does:** accounts, a hosted database, and live sync — but *only* in service of the party.
- **Does not:** ads, analytics, telemetry, real-money purchases, or an account gate on anything
  a solo player does. Those clauses stand.
- **Data leaving the device is now real**, so it is a design surface with its own rules: the
  smallest possible payload (a cat, its outfit, a display name), never the save file; deleting
  an account deletes the rows; and the party UI must say plainly what is being shared, because
  the old copy promised "nothing leaves this device" and that promise is being retired.

## Anti-references — what this must never look like
These are the falsifiable half of the design contract. A render that resembles any of these
is a defect, regardless of whether it "looks nice".

| Anti-reference | The specific tell to reject |
|---|---|
| **Generic SaaS dashboard** (Linear/Notion clone) | Inter/Geist, neutral-gray secondary text, 8px-radius white cards on `#fafafa`, a sidebar. |
| **AI-default landing page** | Purple→violet gradient, gradient-filled headline text, glass cards with a 1px white top border, floating blurred blobs. |
| **Material Design** | Elevation shadows as the only hierarchy, FAB, ripple, Roboto. |
| **Developer dark-mode tool** | Near-black `#0d1117` chrome, cyan accent, monospace everywhere, dense data grid. |
| **Gamified productivity app** (Habitica-ish) | Progress bars as the emotional payload, XP numbers competing with the art for attention, loud badge popups that block the scene. |
| **Kids' educational game** | Comic Sans / Baloo, primary-color saturation, googly-eye characters, bouncy 3D bevels. |

The through-line: **the HUD must never out-shout the diorama.** The scene is the product; the
interface is a paper overlay resting on it.
