# Starting a new game

Copy this directory. It is a working game — build it and it runs — with
everything platform-shaped already done, so the only thing left is the game.

```sh
cp -r games/_template games/yourgame
python3 games/yourgame/src/build.py       # -> games/yourgame/dist/index.html
```

## What you get for free

| | Where it comes from |
|---|---|
| Light, dark and system themes, chosen once for the whole platform | `packages/tokens/theme.js` |
| Every colour, contrast-checked in CI | `packages/tokens/tokens.css` |
| Sheets with a focus trap, a layer stack, Escape, a scrim, a toast | `packages/ui/ui.js` |
| The corner bar, settings rows, the segmented control, buttons, fields | `packages/ui/ui.css` |
| A correct `<head>`: meta, OG, icons, fonts, and the pre-paint ordering | `packages/build/head.py` |
| Accounts, streaks, friends, offline-first with a retry queue | `packages/sdk` |

None of it is copied into your game. It is inlined at build time from one
canonical file, and `packages/tokens/check-inline.mjs` fails the build if a copy
drifts. When the platform's sheet gains a fix, your game gets it on its next
build.

## The six things you change

**1. `src/build.py`** — the constants at the top:

```python
SLUG    = 'yourgame'      # the path: playsapien.com/yourgame/
SURFACE = 'yg-game'       # the class in packages/tokens/tokens.css
TITLE   = 'Your Game'
DESC    = 'One line that says what the player does.'
```

**2. `packages/tokens/tokens.css`** — copy the `.tp-game` block, rename it to
your `SURFACE`, change the twelve colours. Then:

```sh
node packages/tokens/check-contrast.mjs
```

It will tell you which of your values are not legible, on which ground, and by
how much. Every game in the repo passes; yours should too before you commit it.
Give it a palette that is clearly none of the others — two games that look alike
read as one product on the shell's rail.

**3. `packages/tokens/theme.js`** — add your surface's two ground colours to the
`BAR` map so the phone's status bar matches your page.

**4. `src/partA.html`** — the dials at the top, then your game's own CSS. Do not
restate anything ui.css already owns; if you find yourself writing `.sheet` or
`.btn`, check the dial list in `packages/ui/ui.css` first.

**5. `src/partB.html`** — your markup. Keep the corner bar ids (`aboutBtn`,
`settingsBtn`, and `composeBtn` / `friendsBtn` / `profileBtn` if you use them) so
a player learns them once. Keep the `.scrim` and `.toast` elements; PSUI needs
them.

**6. `src/app.js`** — the game. The platform wiring at the top is four lines and
is the same in every game.

## Rules that are not negotiable

- **Namespace every storage key.** One origin means one keyspace. `yourgame:`
  for your own state, `ps:` is the platform's. A bare `streak` collides.
- **Days are UTC.** `PS.dayKey()`, never `new Date().getDate()`. Two games
  disagreeing about what day it is shows up the moment one profile page lists
  both streaks.
- **Never block a render on the SDK.** `PS.saveResult()` writes localStorage
  first and synchronously, then syncs. Do not await it to paint.
- **The backend is optional.** Your game must play, score and keep a streak with
  the Worker switched off. That is not a degraded mode; it is most sessions.
- **Wrap your JS.** `app.js` is a module, so it has its own scope. Keep it that
  way.

## Before you ship

```sh
python3 games/yourgame/src/build.py --check
node packages/tokens/check-contrast.mjs
node packages/tokens/check-inline.mjs
```

Then add your game to the shell's `GAMES` array in `apps/shell/src/index.html`,
with a `field` / `fg` / `fg2` / `accent` taken from your own tokens so the rail
card looks like the game it opens.
