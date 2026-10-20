> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# Adding a game

The repo is now set up so that game three costs the game, not the furniture.
`games/_template/README.md` is the working instruction; this is the reasoning
behind it.

## Start here

```sh
cp -r games/_template games/yourgame
python3 games/yourgame/src/build.py       # it already runs
```

The template is a working game. Six things change: four constants in
`build.py`, a palette block in `packages/tokens/tokens.css`, two ground colours
in `theme.js`, the dials in `partA.html`, the markup in `partB.html`, and the
game itself in `app.js`.

## What was wrong before, and what it cost

Two things were carrying unnecessary complexity forward.

**The alias layer.** When the games were put on shared tokens, each kept its old
names (`--ink`, `--paper`, `--amber`) as aliases onto the new roles. The
justification given at the time was "several hundred call sites"; the real
number was **195 across three surfaces, 19 token names, 8 of them already
dead**. It was a find-and-replace. Keeping it meant two vocabularies for one
concept, in which `--ink` was the *background* in Sojourner and the *text* in
Word Chain — and game three would have inherited whichever it copied from.
It is gone. Role names only.

Removing it surfaced a trap worth remembering: renaming `--ink` to `--bg` turns
the alias `--ink: var(--bg)` into `--bg: var(--bg)`, which CSS treats as a
dependency cycle and makes *guaranteed-invalid* — every call site would have
silently fallen back to unset. And in the shell one alias was a **declaration**,
not a usage, so the rename quietly redefined `--bg-sink` to equal `--bg-raise`.

**The chrome.** 715 CSS declarations lived in triplicate — sheets, the corner
bar, settings rows, the segmented control, buttons, fields. A quarter of every
game's stylesheet was platform furniture copied by hand. That is why the About
icon was stroke-width 2 in one game and 1.9 in another, and why the corner gap
was 9px/2px/1px. `packages/ui` now owns it; 715 duplicated declarations became
**104**, each a documented per-game exception.

## The shape of the shared layer

**Structure, not character.** `ui.css` owns geometry, motion, focus and the
anatomy of each control. Everything a game might legitimately differ on is a
**dial** — a component token with a default. Sojourner's full-width amber
buttons and Word Chain's ink pills are the same `.btn` set differently, not two
implementations.

**Inlined, never copied.** Each surface is a standalone file with no shared
runtime, so `tokens.css`, `theme.js`, `ui.css` and `ui.js` are inlined at build
time from one canonical copy. `check-inline.mjs` fails the build if any copy
drifts — and it caught real drift twice during this work.

## What extracting it taught us

Both games hit the **same three gaps** in the first version of the shared layer,
independently. That agreement is the useful part of extracting something:

1. `.sheet p` at specificity 0-1-1 silently beat the stylesheet's *own*
   `.sethint` and `.sh-sub`, and every single-class paragraph rule in both
   games. Fixed with `:where(.sheet) p`, which contributes zero specificity.
2. A confirm dialog opened over a sheet fought it for Escape and dragged Tab
   back into the sheet underneath. Fixed with a real layer stack —
   `PSUI.open(id, {stack:true})`, and `close()` pops only the top.
3. Sojourner's round reveal lost its undimmed globe, because everything raised
   the scrim. Fixed with `PSUI.open(id, {scrim:false})`.

Each was a private workaround in a game before it became a shared feature. That
is the difference between a layer game three fights and one it uses.

## The checkers

Three, all in CI:

- `check-contrast.mjs` — every text token clears 4.5:1 on both grounds, in every
  theme. **104 checks across 8 themes.** The template's palette lives in the
  real `tokens.css`, so it was covered from its first commit with no change to
  the checker — which is the test of whether the checker actually generalises.
- `check-inline.mjs` — the inlined copies match canonical, and names the first
  differing line.
- `build.py --check` on each game — inputs present, markers intact, and the
  theme script still ahead of the font stylesheet.

## Rules a new game cannot break

- **Namespace every key.** One origin, one keyspace. `yourgame:` for your state,
  `ps:` is the platform's.
- **Days are UTC.** `PS.dayKey()`. Two games disagreeing about the date shows up
  the first time one profile lists both streaks.
- **Never block a render on the SDK.** `saveResult` writes localStorage first,
  synchronously, then syncs.
- **The backend is optional.** The game must play, score and keep a streak with
  the Worker off. That is most sessions, not a degraded mode.

## Verification standard

220 assertions pass: 56 theme × surface with a contrast sweep over every visible
text element, 44 on the shared sheet behaviour including the focus trap and the
layer stack, 14 on the template end to end, 70 backend, 36 SDK.

**The harness trap, again:** Playwright's `setContent` puts the page on an
opaque origin where `localStorage` throws, so the pre-paint theme script never
runs and every theme comes back light — which looks exactly like a broken dark
mode. Serve over real HTTP. It has now caught out this project once and been
successfully warned against four times.
