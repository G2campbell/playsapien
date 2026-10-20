> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# PlaySapien — where the platform stands

Last updated: 15 September 2026.

> **Partly out of date.** playsapien.com is now registered and live, and the
> account tiers, Sapien grants, promotion codes and the admin direction are
> recorded in `claude/accounts-and-admin.md` (21 Sept), which supersedes the
> leaderboard decision below.

## The shape

Three separately-built things became one product. **PlaySapien is the platform,
not a game** — what was called the DailySapo shell is the front door. Two games
sit under it, and a template sits beside them for the third.

    playsapien.com/            apps/shell        the front door + account layer
    playsapien.com/sojourner/  games/sojourner   daily geography
    playsapien.com/wordchain/  games/wordchain   daily word chain
    playsapien.com/api/*       backend           Worker + D1
    playsapien.com/sdk.js      packages/sdk      the shared client

Paths on one origin, not subdomains. One cookie, one localStorage keyspace, one
cached SDK. This is the decision everything else follows from.

The monorepo now lives at `C:\Users\G2Campbell\playsapien-live` and deploys per
surface from GitHub to Cloudflare.

## Decisions made

- **Auth: email six-digit codes plus Google. No passwords, no Apple.** The code
  rather than a magic *link* is the point — a link tapped in a mail app opens in
  that app's browser, not the one you were playing in, and the session lands in
  the wrong place. A code is typed into the tab already open. Full reasoning in
  `docs/BACKEND-SPEC.md` §1. Apple is deferred on the developer fee; note that
  Apple *requires* Sign in with Apple alongside Google if PlaySapien is ever
  wrapped for the App Store. That is a store rule, not a web rule.
- **Design tokens are two layers.** A palette layer (the brand's actual colours,
  theme-independent) and a role layer (`--bg`, `--fg`, `--accent`, which change
  with theme). `packages/tokens/tokens.css`.
- **One vocabulary, enforced.** There is no `--ink` or `--paper` anywhere any
  more. They meant *opposite* things in the two games — `--ink` was the
  background in Sojourner and the text in Word Chain — which is exactly why they
  are gone. 195 call sites across three surfaces were renamed to roles rather
  than papered over with an alias layer. Worth knowing for next time: renaming
  `--ink` → `--bg` turns a line like `--ink: var(--bg)` into `--bg: var(--bg)`,
  a self-reference cycle that is *guaranteed invalid* and silently breaks every
  call site downstream. That happened three times during the pass and each one
  had to be found and removed.
- **Every surface has light, dark and system.** Pinning is no longer used. The
  choice lives in one shared `ps:theme` key, so setting dark in Word Chain means
  the shell and Sojourner are already dark. A small pre-paint script in the
  `<head>` stamps `data-theme` before first paint, which is what stops the flash
  of the wrong theme; on "system" it deliberately removes the attribute and lets
  the media query do the work.
- **Sojourner's globe stays dark in both themes.** `--stage` / `--stage-fg` are a
  ground that does not re-theme. The artwork is baked into WebGL textures, so the
  room changes around it rather than the globe re-colouring. Dark stage, light
  room.
- **Anchors:** shell `#C5C6C1` / `#3D352A` (sampled from the letterpress proof —
  greys, tans and blues on rag paper), Word Chain `#E8D1DA` / `#3C2F34`,
  Sojourner `#F0E8DA` / `#0C0B0A`, template sage `#DCE3D9` / `#2F3A33`.
- **Shared code is inlined, never imported.** Each surface is a standalone file,
  so `tokens.css`, `theme.js`, `ui.css`, `ui.js` and `bar.html` are inlined at
  build time from one canonical copy, with marker comments. `check-inline.mjs`
  fails the build if any of the 15 copies drifts.
- **Structure is shared; character is not.** `packages/ui/` carries the chrome
  every game repeats — sheets, the top bar, settings rows, controls — and each
  game tunes it through component "dials" with defaults.
- **Days are UTC everywhere.** Sojourner already was; Word Chain has not moved
  yet — see open items.
- **Streaks are derived, never incremented.** Recomputed from results on every
  write, so a bug cannot permanently corrupt someone's proudest number.
- ~~**Leaderboards are friends-only.**~~ *Reopened 21 Sept — see
  `accounts-and-admin.md`, open question 1.* The original reasoning still
  stands and is why it is a question: scores are client-reported and a web game
  cannot stop a determined cheat; friends-only keeps the blast radius to people
  who know each other.
- **The backend is additive.** Both games must still play, score and keep a
  streak with the Worker switched off.

## Built and tested

- **backend/** — Worker + D1. Auth (email codes, Google OAuth with PKCE and real
  JWKS verification), players, friends, results, streaks, chain queue, admin
  behind Cloudflare Access, Sapien grants and promotion codes. 78 tests.
- **packages/sdk/** — offline-first client. Never throws into game code.
- **packages/tokens/** — palette, roles, the theme mechanism, two CI checkers.
- **packages/ui/** — the shared chrome, the top bar, the sign-in gate, the
  Analytics card and the upgrade card.
- **packages/build/** — the genuinely shared part of the game builds.
- **games/_template/** — a working, playable starter with all of the above wired.
- **apps/shell/** — the front door and the account layer.
- **apps/legal/** — platform about/privacy/terms.

## The audit

`docs/INTEGRATION-AUDIT.md` carries a status block at the top. Open:

1. **S3 — the games do not call the SDK yet** to post results. (They do now
   ask the API who is signed in, via the shared bar.)
2. **S1 — Word Chain still uses local time for its day key.** Moving to UTC
   shifts which chain is served at the boundary, so it needs either a
   `wordchain:daily:*` migration or one deliberately accepted odd day.

## Two verification techniques worth reusing

- **Serve over real HTTP, never `setContent`.** A blank origin is opaque, so
  `localStorage` *throws*, so the pre-paint theme script never runs, so every
  theme comes back light.
- **Don't trust `getComputedStyle().backgroundColor`.** It returns
  `rgba(0,0,0,0)` for a gradient, so a naive contrast sweep walks straight past
  every sheet without noticing.

Related: when a shared rule needs to lose a specificity fight, `:where()`
contributes zero specificity.

## Still to do before launch

- Fill the legal placeholders — see `accounts-and-admin.md`, question 6.
- Regenerate Word Chain's `og.png` and `icon-512.png` — still the old clay ochre.
