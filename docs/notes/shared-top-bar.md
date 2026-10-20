> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# The shared top bar

Built 17 September 2026. One definition of the platform bar, used by the shell
and every game.

## Why it exists

Before this, each surface had its own chrome and they had drifted badly:

| Surface | What it had |
|---|---|
| Shell | a real bar — mark, wordmark, four icons |
| Word Chain | a small "‹ PlaySapien" back-link plus five floating icons |
| Sojourner | **no bar at all** — five floating icons and a tiny brand link |

Sojourner's landing page genuinely had no `.bar` element. That was not a memory
slip; it was checked on the live page.

## Where it lives

`packages/ui/bar.html` — markup, including the `#psmark` sprite and all six
icons. `packages/ui/ui.css` — the `.psbar` styles. `packages/ui/ui.js` — the
`bar()` function that adapts it per surface.

It is inlined verbatim into all three surfaces by `sync-inline.mjs`, exactly like
`tokens.css` and `ui.css`. **A new game copied from the template gets the bar for
free**, and `check-inline.mjs` fails the build if any copy drifts.

### The sync system had to be extended

It only handled CSS and JS, whose markers are `/* ===== BEGIN … ===== */`.
Markup needs HTML comments, so both `sync-inline.mjs` and `check-inline.mjs`
gained an `HTML_SOURCES` map with `<!-- ===== BEGIN … ===== -->` markers and
their own target list — the bar goes into each surface's *body* file, which is a
different file from the one holding its styles.

Note: `check-inline.mjs` prints its summary and calls `process.exit()`, so the
new block had to go **before** those lines or its results would not be counted.

## The layout

    [mark] PlaySapien          …          ?  ◈  ⊕  ㅅ  ⚙  ☺

Left: the mark and the wordmark, set exactly as the landing page sets them —
Fraunces 600 with SAPIEN at 900.

Right, in fixed order: **About · Analytics · Add · Friends · Settings · Profile.**
Every surface shows all six.

`position: fixed`, `z-index: 40` — above the page, below the sheets, so a dialog
still covers it. Nothing may overlap it: `.psbar-pad` on a scrolling container
adds the bar's height plus the phone's safe-area inset so content starts beneath
it and scrolls under.

Below 420px the mark and type shrink; below 359px the wordmark is hidden and the
mark alone carries the brand.

## One markup, different destinations

The brand link goes somewhere different depending on the surface, and that is
decided at runtime by `PSUI.bar()` rather than by each surface shipping its own
href:

- **shell** → `/about/` (the same place the About icon goes)
- **game** → `/` (back to the front door)

This is the whole reason the markup can be shared verbatim.

## Analytics and Add

Both are real icons with nothing behind them yet. They open a sheet that says so,
because a nav item that swallows a tap reads as broken.

- **Analytics** (`#statsBtn`) — wired once in `ui.js`, so no surface can forget.
  The copy differs: the shell promises cross-game standing, a game promises its
  own leaderboards.
- **Add** (`#addBtn`) — **only the shell is wired here.** Inside a game this same
  button is that game's existing "make a puzzle" control, and the game binds it
  itself. Sojourner's `composeBtn` and Word Chain's were repointed at `addBtn`;
  without that the games' compose handlers would have bound to an element that no
  longer exists.

The Add icon (plus in a circle) replaced Sojourner's globe-with-plus and Word
Chain's chain-with-plus.

## Verified

On the shell, at 390×844: bar present, `position: fixed`, `z-index: 40`, 58px
tall, brand href `/about/` with label "About PlaySapien", wordmark in Fraunces,
all six buttons in order, Analytics sheet opens with the shell copy, no page
errors.

**The games are not yet verified.** Their builds delete files before writing, and
the bridge to the user's machine cannot delete, so they can only be built on
Cloudflare. They need checking after the next deploy.

## Still open

- `.psbar-pad` is defined but not yet applied to the games' scrolling containers.
- Sojourner's mid-round text (the round counter and the multiplier line) still
  sits under the bar; the multiplier should move into the prompt card.
- The reveal jitter in Sojourner — the bottom card hops when the answer shows.
- The invisible build stamp.
