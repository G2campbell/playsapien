# Platform integration audit

Two games and a shell, built independently, about to become one product on one
origin. This is what breaks, what is merely inconsistent, and what was checked
and found already correct.

Audited at the point the monorepo was assembled. Every finding cites
`file:line` against the paths in this repo.

> **Status, 14 September 2026.** Every blocker is closed. Of the should-fixes,
> S4, S5, S6, S7, S10, S11 and S12 are closed, and S2 is closed for Word Chain
> with the general fix living in the SDK. Three remain open and each is open for
> a reason, not by omission:
>
> | Open | Why it is still open |
> |---|---|
> | **S1** — Word Chain uses local time, Sojourner UTC | Changing it shifts which chain is served at the boundary. Needs a `wordchain:daily:*` migration or one deliberately accepted odd day. The decision is yours. |
> | **S3** — the cross-game state the copy promises | The backend and SDK now exist; the games do not call them yet. This is the gap between built and working. |
> | **S8** — neither game build runs from the repo | Sojourner hard-codes `/tmp` paths, Word Chain needs a `dict.txt` that is not checked in. Blocks CI for the games and is why the verification in this pass was static plus a rendered-CSS harness rather than a real build. |
>
> Corrections found while fixing, which the text below has not been rewritten to
> reflect: Word Chain's theming was **not** entirely correct — two dark rules
> (`.corner .iconbtn:hover` and `#homeSolution`'s border) were scoped to
> `[data-theme="dark"]` with no `prefers-color-scheme` counterpart, so they broke
> on exactly the "system" setting. Sojourner's `--amber-dim` and `--signal` have
> zero call sites. And S7's stroke-width note has the games the wrong way round:
> About was `2` in Word Chain and `1.9` in Sojourner; all five corner icons are
> now `1.8`, enforced from `--icon-stroke` rather than per-glyph.

Target layout:

    playsapien.com/            the shell
    playsapien.com/sojourner/  games/sojourner
    playsapien.com/wordchain/  games/wordchain

---

## What was already right

Worth saying first, because it determines how much work the move actually is.

- **Every localStorage key in both games is already namespaced.** Sojourner
  writes `sojourner:seen`, `sojourner:settings`, `sojourner:<dayKey>`
  (`partD.js:252,436,1474`). Word Chain funnels every read and write through one
  helper that prepends `wordchain:` (`part-c-app.js:19-25`), and the one place
  that bypasses it — the pre-paint theme bootstrap at `part-a-style.html:517` —
  hard-codes the same prefix. **No key collides.** The single-origin move, which
  is the whole reason for the path-based layout, costs nothing here.
- **No cookies, no service worker, no manifest, no IndexedDB, no analytics.**
  Nothing with an origin-wide scope to fight over.
- **Sojourner's asset base is relative** — `partC.js:3` is `'./assets/'` and
  everything goes through `A()` at `partC.js:5`. Terrain, tiles, borders, facts,
  audio, flags and emblem all resolve correctly under `/sojourner/`. Script tags
  are relative too (`build.py:67-68`).
- **Word Chain has no runtime fetches at all** — `build.py:79-83` inlines
  everything into one file. It is immune to the path prefix.
- **The three font stacks are byte-identical** across shell, Sojourner and Word
  Chain. A shared token file can lift them verbatim.
- **The shell's per-game card palettes already match each game's real tokens**
  exactly (`index.html:359,364`). The values agree; only the names diverge.
- **Four of the five corner icons are character-for-character identical** in all
  three files, at the same `viewBox` and the same `38px` button.

---

## Blockers — these break at the new origin

### B1. The shell links to a path that will 404

`apps/shell/src/index.html:362` declares `slug:'word-chain'` and
`index.html:336` builds `/${g.slug}/`, producing `playsapien.com/word-chain/`.
Every other spelling in the repo — the directory, the storage prefix, the build
output, the target route — is `wordchain`.

**Fix:** `slug:'wordchain'`.

### B2. Sojourner's `_headers` is root-anchored and lands in the wrong place

`games/sojourner/src/build.py:116-121` writes `DIST/_headers` with patterns
`/assets/*`, `/app.js`, `/og.png`. Cloudflare Pages honours only a `_headers` at
the deployed root, so under a unified site this file sits at
`/sojourner/_headers`, is inert, and is itself publicly fetchable. Every pattern
is also wrong by one path segment.

**Fix:** one root `_headers`, patterns prefixed with `/sojourner/`. Add the two
lines Word Chain never had for its `og.png` and `icon-512.png`.

### B3. No trailing-slash guarantee

Because Sojourner's asset base is `'./assets/'`, a request to
`playsapien.com/sojourner` *without* the slash resolves assets against the
platform root and the globe never loads. Pages normally normalises this; it is
the highest-consequence unverified assumption in the move.

**Fix:** explicit `_redirects` entries, and verify with `curl -I` on the first
deploy. Word Chain is immune — it has nothing relative to load.

### B4. Sojourner's legal pages link back to the platform root

`pages/terms.body.html:68` and `pages/privacy.body.html:99` both render
`href="/"` under the label "← Back to Sojourner". At the new origin that lands
on the PlaySapien landing page.

**Fix:** `href="./"` — the pages are emitted as `/sojourner/privacy.html`.

### B5. The shell's footer links to three pages that do not exist

`apps/shell/src/index.html:316` points at `/about/`, `/privacy/`, `/terms/`.
Nothing in the repo builds any of them. The only legal pages that exist are
Sojourner-specific, at `/sojourner/privacy.html`.

**Fix:** author platform-level legal pages. Sojourner's two body files
generalise with little work, and a platform with accounts needs platform-level
terms regardless.

### B6. The shell's four buttons do nothing

`index.html:281-292` renders four `<button>` elements with no `id`, and the
page's entire script wires up only the game panels and the date line. Four
visibly interactive controls, inert, on the platform's front door.

**Fix:** wire them to real sheets. Removing them is the honest interim; leaving
them is not.

### B7. Word Chain leaks 107 globals

`sojourner/src/partC.js` and `partD.js` are both wrapped in an IIFE and export
exactly one symbol, `window.__M__`. Word Chain's `part-c-app.js` and
`composer.js` have no wrapper, so every declaration is a global — including
`$`, `S`, `SET`, `DATA`, `SITE`, `store`, `drop`, `toast`, `save`, `finish`,
`pick`, `hit` and ninety more.

This is harmless while each game is its own top-level document, and becomes a
real collision the moment anything is embedded or bundled. The same applies to
twelve duplicate element ids (`app`, `scrim`, `toast`, `clock`, `homeBtn`,
`shareBtn`, and the four corner buttons) and fourteen duplicate class names with
different CSS behind several of them — `.btn` is an amber block in one game and
an ink pill in the other.

**Fix:** wrap Word Chain's two files in one IIFE. They are already concatenated
at `build.py:21-22`, so one wrapper covers both. Cheap, and it closes the whole
category.

---

## Should-fix — works, but wrong or inconsistent

### S1. The two games disagree about what day it is

`sojourner/src/partD.js:397-400` derives the day key from **UTC**;
`wordchain/src/part-c-app.js:104-107` derives it from **local time**. A player in
UTC+10 sees a Word Chain "today" that Sojourner still calls yesterday, for ten
hours a day.

Invisible while they are separate products. The moment one profile page shows
both streaks, it is a bug the player can see. Sojourner's UTC is the right
choice — its own copy promises "midnight UTC" in two places.

**Fix:** one shared `dayKey()`. Note this changes which chain Word Chain serves
at the boundary, so either migrate the `wordchain:daily:*` keys or accept one
odd day.

### S2. Per-day keys accumulate forever, now against one shared quota

`partD.js:1474` writes `sojourner:<dayKey>` and never deletes it — there is no
`removeItem` in the file. Word Chain's `daily:<todayKey>` is never pruned
either. Two unbounded per-day series in one 5 MB keyspace.

**Fix:** on load, drop keys whose date part is older than ~90 days.

### S3. The cross-game state the product promises does not exist

`index.html:326-331` justifies the whole path-based deploy on shared
localStorage — "streaks, profile and the cross-game ranking". Sojourner's
Friends sheet tells the player friends are "shared with Word Chain, so a friend
is a friend across both games" (`partB.html:311`). In fact Word Chain's friends
live at `wordchain:friends` and Sojourner's sheet is a stub marked "Coming
soon". The shell writes nothing at all.

This is the gap the backend closes. Until it does, the copy is a promise the
product does not keep.

**Fix:** a third, game-neutral prefix — `ps:` — for anything cross-game, and
migrate `wordchain:friends` into it. Per-game progress stays where it is.

### S4. Hard-coded domains

Every occurrence, and what it becomes:

| File:line | Current | Becomes |
|---|---|---|
| `sojourner/src/build.py:7` | `https://sojourner.g2campbell.com` | `https://playsapien.com/sojourner` — feeds og:url, og:image, canonical and `GAME_URL` |
| `sojourner/src/partD.js:1005` | literal `'sojourner.g2campbell.com'` painted on the share card | must be injected, not a second literal |
| `sojourner/src/mkog.py:28` | same domain baked into `og.png` | regenerate |
| `sojourner/src/pages/*.body.html:8-9` | "applies to sojourner.g2campbell.com" | platform domain |
| `wordchain/src/build.py:6` | `https://wordchain.g2campbell.com` | `https://playsapien.com/wordchain` |
| `apps/shell/src/index.html:334` | `domain:'dailysapo.com'` | `playsapien.com` |

`partD.js:1005` is the one to watch: it is a **separate literal** from
`GAME_URL`, so fixing the build config alone leaves the old domain painted on
every shared card. Word Chain already solved this — `build.py:6` injects
`window.__WC_SITE__`, read once at `part-c-app.js:14` and used for both the share
link and the printed footer. Sojourner should copy that.

### S5. `--ink` and `--paper` mean opposite things in the two games

- Sojourner: `--ink:#0C0B0A` is the **background**, `--paper:#F0E8DA` is the **text**.
- Word Chain light: `--ink:#1F1A14` is the **text**, `--paper:#FAF9F7` is the **background**.
- Word Chain dark: the same two hex values as Sojourner, with the names swapped.

Merging these into a shared stylesheet without renaming silently inverts one
game. Several other pairs are the same value under different names
(`--paper-dim`/`--ink-2`, `--amber`/`--accent`, `--verdigris`/`--good`,
`--line2`/`--line-2`), and `--line` is an opaque hex in both games but an rgba in
the shell — substituting one for the other makes a solid rule see-through.

**Fix:** role-based names (`--bg`, `--fg`, `--fg-2`, `--line`, `--accent`) in a
shared token file, with per-game brand ramps kept local. Rename before merging,
not after.

### S6. Three different theming models

Word Chain has correct three-state theming: light base, dark under both
`prefers-color-scheme` and `[data-theme="dark"]`, and a pre-paint script that
stamps the attribute before first paint to avoid a flash. Sojourner has no
theming at all — permanently dark, and because it never declares
`color-scheme:dark`, its native range inputs and scrollbars render in light UA
chrome on a black page (one-line fix at `partA.html:8`). The shell is
`color-scheme:light` only, so a player who set Word Chain to dark lands on a
white front door.

`theme-color` is also inconsistent: the shell has one value, Word Chain has two
media-scoped values, Sojourner has none.

### S7. Corner-bar drift

The bars are remarkably close — same classes, same order, same `38px` buttons,
four of five glyphs identical. What differs is arbitrary: two button ids
(`helpBtn`/`aboutBtn`, `makeBtn`/`composeBtn`), the gap (`9px` / `2px` / `1px`),
the hover treatment (colour / opacity / opacity), and the About icon's
stroke-width (`1.9` vs `2` — a visible weight difference on the same glyph).

More structurally: Sojourner's bar is always visible including mid-round, Word
Chain's disappears once play starts and is replaced by a different bar, and the
shell's is a fixed full-width bar. Three chrome models for one product.

**Neither game offers a way back to the platform.** Both `homeBtn` handlers go
to that game's own intro screen. Nothing links to `playsapien.com/`.

### S8. Neither build script runs from the repo

`sojourner/src/build.py:2` hard-codes `/tmp/out/`, `/tmp/build/`, `/tmp/three/`,
`/tmp/flags/`. `wordchain/src/build.py` is cwd-relative but reads `dict.txt`,
which is not in the repo. Neither produces a deployable `dist/` as checked in.

This has to be fixed before any CI is wired up, and it is the reason the build
verification in this pass is partial.

### S9. Plan the `/api` namespace before writing either backend

`SUBMISSION-PIPELINE.md:53` proposes `POST /api/chains`. Sojourner's leaderboard
hook is `window.SOJOURNER_API` + `fetch(api + '/score')` (`partD.js:39-42`). On
one origin these must not fight.

**Fix:** `/api/wordchain/*` and `/api/sojourner/*` for game-specific routes,
`/api/player/*` for anything cross-game. Cheap now, painful later. (Sojourner's
gate is good design — no traffic leaves the device until the constant is set.)

### S10. Three overlapping Google Fonts requests

Three different URLs for largely the same faces, so navigating shell → game
re-downloads rather than hitting cache. Worse, **Sojourner asks for Fraunces 700
where the others ask for 900**, so its headings are a visibly different weight —
and its share card paints at `600` where Word Chain's paints at `900`.

**Fix:** one union URL from a shared head builder, and pick 700 or 900
deliberately.

### S11. No favicon for two of three surfaces

Word Chain sets an inline-SVG icon and an apple-touch-icon. Sojourner and the
shell set neither, so on a shared origin both fall back to a `/favicon.ico` that
does not exist. The nyansapo mark is already defined as a `<symbol>` in the
shell and is the obvious platform icon.

### S12. Sojourner blocks pinch-zoom

`partA.html:2` sets `maximum-scale=1`. That defeats zoom for low-vision users,
modern iOS ignores it anyway, and the other two surfaces omit it.

---

## Duplication worth extracting

Ranked by how real the reuse is, because overclaiming here creates a shared
component that fits nothing.

**Extract now, zero risk.** The four shared corner icons are
character-for-character identical in all three files — the Settings glyph alone
is a ~500-character path duplicated three times. One `<symbol>` sprite; the
shell already demonstrates the pattern for its own mark. The fifth glyph differs
per game but both end with the *same* plus decorator, so that can be shared over
a per-game base.

**Extract with a small config surface.** The sheet/modal CSS is near-identical
down to the same easing string and the same `38×4px` grab handle; the
differences are padding and z-index. The toast is the same three lines in both.
The settings row components match within a hair (`16px`/`15px` padding,
identical `:last-child` rule). The share *dispatch* has the same architecture in
both — build the card before the tap so the user-gesture permission survives —
and each has a refinement the other lacks: Word Chain handles `AbortError` so a
dismissed sheet doesn't fire the clipboard fallback; Sojourner adds a `text/html`
clipboard flavour so the card pastes into Mail as a clickable image. The merged
helper wants both.

Sojourner's settings loader hand-writes eight `if(s.x)` clauses where Word Chain
does `Object.assign(defaults, store('set') || {})`. Word Chain's generic
primitive is the right one — but Sojourner's per-field clamping is real
defensive value that a naive `Object.assign` loses. Extract the primitive, keep
a per-game validator on top.

**Do not extract.** The two share-card painters are both canvas routines that
end in `toBlob`, and that is the whole resemblance — different dimensions,
different content model, different spoiler rules. The two `build.py` files
overlap on about four lines. What *is* worth sharing from the builds is the
head/meta emission: the same tag set with different gaps — Sojourner has
`canonical` and `og:image:alt` but no `theme-color` or icons, Word Chain has the
reverse. One `head()` builder closes both gaps at once.

**One stray file.** `wordchain/src/sj-og.js` is a Sojourner OG generator sitting
in the Word Chain directory, near-identical to `og.js` beside it — and it is not
what actually generates Sojourner's OG image, which is `mkog.py`, a completely
different technology producing a different design. Three OG paths for two games.
Port Sojourner to the Playwright approach (it uses the real webfont rather than
a DejaVu fallback) and delete `mkog.py`, or delete the stray. Not all three.

---

## Two quality notes, not defects

**Word Chain's near-miss judging degrades on a plain host.** `part-c-app.js:285`
guards on `window.claude`, which will never exist at `playsapien.com/wordchain/`.
The model-judged path is permanently dead there and every near miss falls back to
the bundled lexicon that the spec itself calls noisy. Nothing breaks; it is a
real quality reduction relative to the artifact build, and the platform Worker is
now the obvious place to proxy it.

**Focus handling is thin in both games.** Word Chain never moves focus into an
opened sheet, so a keyboard user tabs behind the scrim. Sojourner focuses one
dialog button. Both Escape handlers are fine. The shared sheet component should
carry a focus trap when it is extracted.
