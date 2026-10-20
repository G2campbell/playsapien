> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# PlaySapien design system

One theme language across the shell and both games. `packages/tokens/` is the
source of truth; its README is the working reference. This doc is the why.

## The shape of it

**Two layers, not one.** A flat shared stylesheet could not work, because
`--ink` is the *background* in Sojourner and the *text* in Word Chain. Sharing
those names would have silently inverted one game. So:

- a **palette layer** holds the brand's actual colours, which do not change with
  theme (`--brand-steel`, `--brand-navy`, and so on);
- a **role layer** holds what they are *for* (`--bg`, `--fg`, `--accent`,
  `--line`), and that is what changes.

There is no alias layer any more: all 195 legacy call sites were renamed to
roles. Watch for self-reference when renaming — turning `--ink: var(--bg)` into
`--bg: var(--bg)` is a guaranteed-invalid cycle that silently kills every call
site downstream. It happened three times during that pass.

**Three themes everywhere**, one mechanism: `ps:theme` in localStorage (one key
for the whole platform, so choosing dark in Word Chain leaves the shell dark),
a pre-paint script that stamps `data-theme`, and three CSS blocks — `:root` for
light, `[data-theme="dark"]` for explicit dark, and
`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` for
system. The `:not()` is what lets an explicit light choice beat a dark machine;
leave it out and "light" silently stops working.

**Light is the default, not system** (changed 15 Sept). Defaulting to the OS
meant one person saw a light desktop and a dark phone and read it as a bug.
"System" is now something you choose.

**Wire the control.** `PSTheme.bindControl` existed from the start and was never
called, so the segmented control in Settings did nothing and the choice could
never leave its default. It is now bound on `DOMContentLoaded` in the same plain
script as `PSTheme.init` — deliberately **not** in the module that imports
`/sdk.js`, because appearance must not stop working when the account layer
fails to load.

## `--stage`, and why Sojourner has one

Sojourner's globe is baked textures designed against black. A light theme that
lightened its ground would wreck the artwork. `--stage` is a ground that stays
dark in **both** themes: dark stage, light room, like a gallery. The chrome —
sheets, settings, the intro and results pages, legal — re-themes; the globe does
not.

The split was decided on **translucency**, not proximity: the top bar and the
prompt chip are smoked glass laid on the artwork, so going light would either
turn them into slabs on top of the picture or let the globe bleed through where
contrast depends on which bit of ocean is behind the text. They are the
instrument, not the room.

## The palettes

| Surface | Light | Dark | Character |
|---|---|---|---|
| PlaySapien | `#C5C6C1` | `#3D352A` | flat brand grey, steel-blue mark, navy ink |
| Sojourner | `#F0E8DA` | `#0C0B0A` | cream and near-black, amber |
| Word Chain | `#E8D1DA` | `#3C2F34` | dusty rose and plum |

Word Chain moved off its old clay ochre because it sat close enough to
Sojourner's amber that side by side on the shell's rail the two read as one
product.

## The shell's identity

**The ground is flat.** It used to simulate a sheet of heavy cold-press
watercolour paper — a photographed 192px tile laid twice at two scales in
multiply and soft-light, plus radial washes and a vignette. All removed 15 Sept.
The paper now survives only where it belongs: inside the mark. Dropping it took
36 KB off the page and made the fixed bar and the page agree, which they never
quite did while one was translucent over a mottled ground.

**The mark is the proof itself, not a tracing.** The earlier version was drawn
as SVG from measurements, and it was wrong in a way that mattered: two full
circles, so the rings ran straight through the middle and the wordmark sat on
top of them. On the real artwork **the middle band is clear** — the arcs stop at
the bars. The shapes are ovals, not circles; there are weave gaps where lines
cross, so they read as passing over and under; the blue carries a tooth; and
the whole thing is embossed into the sheet.

So the hero now uses the photograph, processed:

- the baked serif wordmark lifted out of the middle band (nothing else lives
  there, so masking the band between the bars removes it cleanly);
- the sheet dropped to transparency. The vignette defeats a single background
  colour and even a local max-filter estimate, so the final gate is **blueness**:
  strokes run `b - r ≈ +35`, lit paper ≈ 0, shadowed corner paper negative.
  That separates ink from sheet where brightness alone cannot;
- two variants. `mark-light.png` keeps the emboss ring, which reads as depth on
  a ground close to the original paper. `mark-dark.png` clips to the stroke,
  because that ring is paper-coloured and reads as a pale halo on a dark ground.
  CSS picks by theme.

`#psmark`, the small crisp version for the bar and footer, is drawn as two
ellipses **clipped** by a two-rect `clipPath` that excludes the middle band —
rather than as hand-drawn arcs — so no future edit can put a stroke back across
the wordmark.

**The wordmark is real text.** Always all caps, always Montserrat: `PLAY` at 400
in `--fg-2`, `SAPIEN` at 800 in `--fg`. It sits absolutely positioned in the
mark's clear band, sized off the lockup width (`calc(var(--lk) * .104)`) so type
and artwork scale together. The tagline is Montserrat 600 at
`clamp(12.5px, 2.5vw, 15px)` — it was previously a script face at up to 27px,
the only place that face appeared.

The page is therefore **no longer a single portable file**: it needs
`/mark-light.png` and `/mark-dark.png` beside it. `apps/shell/build.sh` copies
them and asserts they arrived.

**The front door fits one phone screen.** At 375×812 and 390×844 the whole page
— mark, tagline, date, the games accordion, and About/Privacy/Terms — fits with
no scroll. On a phone the hero gives up decoration rather than the games giving
up room: the rule is hidden, the footer drops its mark, the open panel is 16rem
rather than 21.5rem.

## Two checkers, both in CI

- `check-contrast.mjs` — every text token clears 4.5:1 against **both** its
  grounds (`--bg` and `--bg-raise`), in all eight themes.
- `check-inline.mjs` — the surfaces inline `tokens.css`, `theme.js`, `ui.css`
  and `ui.js` verbatim, because each is a standalone file with no shared
  runtime. This diffs every copy against the canonical file. Run
  `sync-inline.mjs` after editing any canonical file or CI will fail.

## How this is verified, and the traps

Every theme × surface combination of (stored choice × system preference), with a
contrast sweep over every visible text element, compositing backgrounds up the
ancestor chain. Plus a click-through test that actually presses all three
buttons in Settings and asserts the stored value, the `data-theme` attribute and
`aria-pressed` — which is what would have caught the unbound control.

**The trap:** Playwright's `setContent` puts the page on an opaque origin where
`localStorage` throws. The pre-paint script never runs and every theme comes
back light, which looks exactly like a broken dark mode. Serve over real HTTP.

Two more: `getComputedStyle().backgroundColor` is `rgba(0,0,0,0)` for a
gradient, so a naive sweep walks past every sheet; and a test page missing a
dependency the page imports (`/sdk.js`) makes the whole module silently not run,
which looks like a logic bug in whatever that module was supposed to do.

## Still outstanding

- `games/wordchain/src/og.png` and `icon-512.png` are still in the old clay
  ochre. `og.js` is updated so a regeneration comes out right; it needs
  `npm install playwright @fontsource/fraunces` then `node og.js`.
- Word Chain's `.row .num` / `.crow .num` are a pre-existing opacity-dimmed
  secondary at ~2.5:1 — not a regression, but the same anti-pattern.
- The games still need a local rebuild and redeploy to pick up the light
  default; only the shell rebuilds from Git.
