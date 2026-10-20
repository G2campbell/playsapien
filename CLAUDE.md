# CLAUDE.md — PlaySapien

Read this first. It is written for a Claude that has never seen this project.
Last updated 20 October 2026, when the project moved to Claude Code.

---

## 1. The owner, and how to work with him

- **Kai** (GitHub `G2campbell`) owns and runs PlaySapien alone. He is **not a
  developer**. Explain things in plain words, with numbered steps he can follow
  exactly, and say what each step does. Do not assume he knows git, npm,
  wrangler, SQL or Cloudflare vocabulary.
- He pushes with **`git push` typed in a terminal**, not GitHub Desktop. Give
  terminal steps.
- His machine is **Windows**. The repo is at `C:\Users\G2Campbell\playsapien-live`.
  It must **never** be moved into OneDrive: OneDrive writes `desktop.ini` into
  `.git/` and corrupts it.
- **Identity and privacy rules (strict):**
  - Commits are authored as `G2campbell <kai@g2campbell.com>`. Do not put any other
    personal email address of Kai's in commits, code, docs or config.
  - Kai wants his **personal name off everything**. Use "PlaySapien" as the business
    name in the Terms, Privacy and other pages. An LLC is being formed; when it
    exists, these become "PlaySapien LLC".
  - **Secrets are never pasted into chat or committed.** Kai types them himself
    with `npx wrangler secret put NAME`. The secrets are `LOGIN_CODE_PEPPER`,
    `OAUTH_STATE_SECRET`, `RESEND_API_KEY` and `GOOGLE_CLIENT_SECRET`, plus
    `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET` later. Optional:
    `TRIAL_KEY_SECRET`.
  - Never sign into Cloudflare, Google, Paddle, Resend or GitHub as Kai. Ask before
    sending email or granting any OAuth consent on his behalf.
- Before building something sizeable, ask the one or two questions whose answers
  change the design (he answers quickly). Afterwards, tell him in plain words what
  changed and give the exact update steps (§5).

---

## 2. What PlaySapien is

**playsapien.com** is a daily-puzzle platform: one origin, several games, one
player account.

```
playsapien.com/            apps/shell        the front door (home page) + account UI
playsapien.com/sojourner/  games/sojourner   daily geography on an unlabelled 3-D globe
playsapien.com/wordchain/  games/wordchain   daily word chain (8 words, each pair a compound)
playsapien.com/api/*       backend           Cloudflare Worker + D1 (SQLite) database
playsapien.com/sdk.js      packages/sdk      small client the surfaces share
playsapien.com/about|sapien|refunds|privacy|terms/   apps/legal (static pages)
```

**Plans:**

- **No account:** can play today's puzzles.
- **Free account:** adds friends, ranking and Daily analytics.
- **Sapien** ($2/month, billed annually at $24): adds the past 30 days of dailies,
  full analytics, making puzzles, friend groups and starting friend challenges.
- Every account keeps every result. The plan only decides how much is shown.
- One free 2-day Sapien trial per email address, ever. No card needed.
- Promotion codes can grant Sapien.

**Sign-in:** a six-digit code by email (sent via Resend), or Google. There are no
passwords. A code is used rather than a magic link because a link opens in the
mail app's browser instead of the tab you were playing in.

---

## 3. How the files are organised

| Path | What it is |
|---|---|
| `apps/shell/src/index.html` | The home page. One big standalone HTML file (inline CSS and JS). `build.sh` copies it and its assets into `cfroot/`. |
| `apps/legal/` | Static pages: `about/`, `sapien/`, `refunds/`, `privacy/` and `terms/`, plus `legal.css`. |
| `games/sojourner/` | Python pipeline (`src/build.py`) → `dist/`. The page is assembled from `src/partA.html` (CSS), `partB.html` (markup), `partC.js` and `partD.js`. The baked globe textures (`baked/`, ~40 MB) and three.js are **not in git**. |
| `games/wordchain/` | `src/build.py` inlines `part-a-style.html`, `part-b-body.html`, `part-c-app.js`, `composer.js`, `gamedata.json`, `pairs.json` and `dict.txt` into one `dist/index.html`. See §7. |
| `games/wordchain/chain-tools/` | How the October 2026 chains were written, checked and scheduled (briefs, `check_chains.py`, `schedule.py`). |
| `games/_template/` | A working starter game. **Start a new game here**; see its README. |
| `backend/` | The API Worker. `src/index.js` holds the route table. `src/routes/` holds auth, player, friends, groups, play, wordchain and admin. `src/lib/` has helpers. `migrations/0001…0007_*.sql` is the database schema history. `test/` uses node:test with better-sqlite3 standing in for D1. |
| `packages/ui/` | **The shared chrome**: `bar.html` (top bar plus all shared sheets: Analytics, gate, upgrade/payWall, Profile, Friends and confirm cards), `ui.css` and `ui.js` (sheets, sign-in, profile, friends, avatars, gate, toasts). |
| `packages/tokens/` | Design tokens (`tokens.css`), the theme script (`theme.js`) and the checkers: `sync-inline.mjs`, `check-inline.mjs` and `check-contrast.mjs`. |
| `packages/sdk/` | Offline-first client (`PS`): sessions, day key, a result queue. Bundled to `deploy/sdk.js` with esbuild. `saveResult` can carry a game's `moves` and map `key`. |
| `packages/scoring/wordchain.cjs` | **Word Chain's rules the server checks**: inflection, "is this guess the answer", Lifeline costs, the calendar, `verify(data, moves, day, isWord)`. Inlined into `part-c-app.js`; the Worker imports it (`backend/src/lib/wordchain.js`, which also holds the run stamp). |
| `packages/scoring/sojourner.cjs` | **Sojourner's rules in one file**: daily picks, country rounds, sprint bag, scoring curve, `verify(moves, day)`. The game runs it inlined into `partD.js`; the Worker imports it (`backend/src/lib/sojourner.js`). See §6 and §8. |
| `packages/offline/sw.js` | One service worker, copied into every surface by its `build.sh`. |
| `packages/avatars/{monsters,robots,animals}/` | 192px `.webp` avatar pictures, served at `/avatars/` by the shell build. The originals are in Kai's OneDrive (`Game Apps/Avatars/`). |
| `packages/build/` | Python helpers shared by the game builds (`head.py`, `paths.py`). |
| `deploy/` | `sdk.js` bundle, root `_headers`/`_redirects`, `assemble.sh` (local preview only). |
| `docs/` | `BACKEND-SPEC.md` and `INTEGRATION-AUDIT.md`: older but still the deepest reasoning. |
| `docs/notes/` | Design notes copied from the earlier claude.ai project (see §10). Some are dated. |
| `_to_delete/` | Scratch left by an earlier tool that could not delete files. Git-ignored and safe to delete. |

### Shared code is inlined, never imported (important)

Every surface is a standalone file with no shared runtime, so the canonical
`packages/tokens/{tokens.css,theme.js}` and `packages/ui/{ui.css,ui.js,bar.html}`
are **copied into 15 places** (and the two scoring engines into a 16th and 17th) between marker comments
(`/* ===== BEGIN … ===== */` or `<!-- ===== BEGIN … ===== -->`). Those places are
the shell's `index.html`, Sojourner's `partA`/`partB`, Word Chain's
`part-a-style`/`part-b-body`, and the template. The 16th is `packages/scoring/sojourner.cjs`
inside `games/sojourner/src/partD.js`, the 17th is `packages/scoring/wordchain.cjs` inside
`games/wordchain/src/part-c-app.js`. Edit the canonical file, never the inlined copy.

**After editing any canonical file, run:**

```sh
node packages/tokens/sync-inline.mjs     # copies canonical → all surfaces
node packages/tokens/check-inline.mjs    # must say "17 inlined copies checked — all in sync"
```

CI fails if they drift. Never hand-edit the inlined copy inside a surface. Edit the
canonical file and sync.

### Rules for `packages/ui/ui.js`

- **ES5 only**: no arrow functions, `let`/`const`, template literals, classes or
  spread. It runs inline on every surface. Check it with
  `node -e "new Function(require('fs').readFileSync('packages/ui/ui.js','utf8'))"`.
- Public API: `window.PSUI`. The main functions are:
  - `init`, `bar`, `open(id, {stack, scrim})`, `close`, `toast`
  - `setUser`, `whenUser`, `openFriends(code)`
  - `dayButtons`, `wireDayRow`, `pastDays`, `setFriendGroups`
- Sheets that live in `bar.html` are moved to `document.body` at start-up (the
  "lift list" in `bar()`) so they sit above the page's stacking contexts. **Add any
  new shared sheet id to that list.**
- The sign-in/plan gate is a capture-phase click handler. Mark a control with
  `data-gate="account"` or `data-gate="sapien"` (plus `data-gate-label`). The server
  enforces the same rules independently.
- User state: `setUser(user)` → `learnUser` repaints the who-strip, Profile and
  Friends, then dispatches the `ps:user` event. The shell listens for `ps:user` and
  **must not** call `setUser` back (that would loop).

### Line endings

`.gitattributes` pins LF. Some files in Kai's Windows checkout are CRLF on disk
(e.g. `dict.txt`, some READMEs). **Preserve each file's existing line endings when
editing.** A CRLF `build.sh` dies with `set: Illegal option -`.

---

## 4. Running and testing locally

```sh
# Backend (needs Node 22). 139 tests, no Cloudflare account needed.
cd backend && npm install && npm test
npx wrangler dev                      # local Worker + local D1 (optional)

# NOTE: on Kai's Windows machine `python3` is a Microsoft Store stub that does
# nothing. Python 3.12 is installed: use `py -3` instead of `python3` below.

# Word Chain
python3 games/wordchain/src/build.py --check   # validate, write nothing (CI runs this)
python3 games/wordchain/src/build.py           # -> games/wordchain/dist/index.html

# Sojourner (needs the untracked baked/ folder and three.js for a full build)
python3 games/sojourner/src/build.py --allow-missing

# Shared code
node packages/tokens/sync-inline.mjs && node packages/tokens/check-inline.mjs
node packages/tokens/check-contrast.mjs

# SDK
cd packages/sdk && npm test
npx esbuild src/index.js --bundle --format=esm --minify --outfile=../../deploy/sdk.js
```

CI (`.github/workflows/`) runs the backend tests, SDK tests, token checkers, the
template build and the Word Chain build on every push.

### Browser-testing traps (learned the hard way)

- **Serve over real HTTP; never use Playwright `setContent`.** An opaque origin
  makes `localStorage` throw, the theme script never runs, and every theme comes
  back light.
- The shell's main script is an ES module that imports `/sdk.js`. If `/sdk.js` is
  missing in a test, **the whole module silently does nothing**. Serve or stub it.
  A useful stub provides `init`, `dayKey`, `today`, `queueLength`, `me` and
  `verifyEmail`.
- API responses are wrapped: `{ ok, data }` on success and
  `{ ok:false, error:{code,message} }` on failure. Mocks must match that shape.
- `getComputedStyle().backgroundColor` is transparent for gradients, so naive
  contrast sweeps miss sheets.
- Word Chain picks the daily from the clock. Use Playwright `page.clock` to test
  dates.

---

## 5. Deploying (how Kai updates the live site)

**Surfaces and how they deploy:**

| Surface | Cloudflare Worker | How it deploys |
|---|---|---|
| Home page (`apps/shell`) | `playsapien` (custom domain) | Rebuilds automatically from GitHub on push. Takes about 10–15 minutes to appear. |
| `/wordchain/`, `/sojourner/` | `playsapien-wordchain`, `playsapien-sojourner` (routes) | Rebuild from GitHub on push (`sh build.sh` then `npx wrangler deploy`, root dir `games/<game>`). `cfroot/` is a build output, never committed. |
| `/api/*` (`backend`) | `playsapien-api` (route) | **Manual.** Not connected to Git. |

Routes win over the custom-domain Worker, which is how the API and the games share
the hostname with the shell.

**The standard update steps to give Kai:**

```
1. cd C:\Users\G2Campbell\playsapien-live\backend
2. npx wrangler d1 migrations apply playsapien --remote     (only if there is a new migration; type y)
3. npx wrangler deploy                                       (only if backend/ changed)
4. cd ..
5. git push
```

- **Run migrations before deploying** the code that needs them.
- If wrangler says "account not valid / not authorized", have Kai run
  `npx wrangler logout` then `npx wrangler login`.
- `backend/wrangler.toml`: the D1 binding must stay `binding = "DB"`. The code
  reads `env.DB`.
- Health checks:

  ```
  curl -sI https://playsapien.com/api/auth/session   # 200 with user:null when signed out
  curl -I  https://playsapien.com/wordchain          # 301 to /wordchain/
  ```

**State (20 Oct 2026):** commit `f40799a` (friend groups, migration **0007**) is
live and checked by Kai. Later commits are committed but **not yet pushed or
deployed**: `780d916` (friends see each other's uploaded avatars), `e09cb28`
(Analytics), option D stage 1 (Sojourner sends moves, the server replays them;
**migration 0008**) and option D stage 2 (Word Chain, ranked on server-kept time;
no further migration). Both stages deploy together with the steps below.

**Deploy order matters for option D.** Backend first, then `git push`:

```
1. cd C:UsersG2Campbellplaysapien-liveackend
2. npx wrangler d1 migrations apply playsapien --remote     (migration 0008; type y)
3. npx wrangler deploy
4. cd ..
5. git push
```

If the game went live first, its results would be refused by the old server
(wrong maximum, unknown `moves`) and the game's queue would drop them. If the
backend is deployed and the game is not, nothing changes for players. If Sojourner's
map data (`games/sojourner/baked/assets/meta.json`, `pool.json`) is ever re-baked,
the backend must be redeployed with it; until then the server answers 503
`key_mismatch` and the game's queue keeps the result and retries.

---

## 6. Backend essentials

- One Worker (`backend/src/index.js`) with a table-driven router. A path can hold
  several `:param` segments.
- **Data model:**
  - `users`: plan, `plan_since`/`plan_until`, avatar, `display_name`, `name_chosen_at`.
  - `identities`: email or Google.
  - `sessions`: a cookie holding a hashed id; sliding one-year expiry.
  - `results`: per game, per day, per mode.
  - `streaks`: derived, never incremented.
  - `friendships`: one row per pair with `a_id < b_id`; state is
    pending/accepted/blocked; also `blocked_by` and `later_at`.
  - Invites and limits: `friend_rejections`, `email_invites`, `email_optouts`.
  - Groups: `friend_groups` and `friend_group_members`.
  - Other: `invite_codes`, `trial_claims`, `promo_codes`, `chains` (player-submitted
    Word Chain chains), `notices`, `incidents`.
- **Plan logic:** `lib/plan.js` (`effectivePlan` at read time; `planStarted`).
  `ctx.user.plan` is already the effective plan.
- **Email keys:** addresses used for trials and invites are stored only as HMACs
  of the normalised address (`lib/trial.js`: lowercase, strip `+tag`, Gmail dots,
  googlemail→gmail). They are keyed by `LOGIN_CODE_PEPPER`, or `TRIAL_KEY_SECRET`
  if set. **Do not rotate the pepper without setting `TRIAL_KEY_SECRET` to the old
  value**, or every trial and invite record is orphaned.
- **Rate limits:** `middleware/ratelimit.js` `LIMITS` / `consume()`.
- **Nightly cron (`17 4 * * *`):** deletes email invites older than 90 days and
  friend rejections older than 30 days.
- **Admin routes** (`/api/admin/*`) exist but are **closed** until `ACCESS_TEAM_DOMAIN`
  and `ACCESS_AUD` (Cloudflare Access) are set. There is no admin UI yet.

---

## 7. Word Chain specifics

- **The bank is scrambled in the shipped page** (Kai asked that it not be easy to see). The
  built page carries each chain as one scrambled string (`build.py` `scramble_bank`, XOR with
  an xorshift32 stream keyed by `BANK_KEY` and the chain's position, then base64); the game
  unscrambles one on demand (`bank(i)` in `part-c-app.js`) and removes `window.__WC_DATA__`.
  View-source shows no words from any chain. It is a screen, not a lock: the game must read the
  chains, so a developer with the page open still can. `BANK_KEY` must match in both files
  (the build checks that and the round trip). Nothing else reads the shipped chains; the
  server uses `gamedata.json` directly. Not hidden: the `pairs` list (what can follow each
  word) and the word list, which are not answers; and an *unfinished* daily is kept in
  `localStorage` with its words so it can be resumed (a player with devtools could read it).

- **The bank.** `src/gamedata.json` → `chains` holds the 34 original hand-graded
  chains (made by `bank.py` + `finalize.py`) **followed by 390 new chains in
  calendar order**, from `src/chains-2026-10.jsonl` via `src/make_bank.py`.
- **`gamedata.json` → `calendar`** is `{start: <UTC day 21 Oct 2026>, legacy: 34}`:
  - Days before the start use the old `day % 34` rotation, so past days still show
    the chain they showed at the time.
  - From the start, day `d` plays new chain `(d - start) % 390`.
  - The order keeps any repeated word pair at least 56 days apart and never within
    a week.
  - **`finalize.py` overwrites `gamedata.json`. Re-run `make_bank.py` after it**, or
    the 390 chains are lost.
- **Practice** only serves chains that have already been a daily (the 34 originals,
  plus each new one once its day has passed), never today's. So practice cannot
  spoil a future daily.
- **Judging wrong guesses.** On the live site there is no model, so wrong guesses
  are judged by `src/pairs.json`: for each head word, `"STRONG WORDS|WEAK WORDS"`.
  There are 1,953 heads, about 13k strong and 19k weak pairs.
  - Built by `make_pairs.py` from three inputs: `pairs-graded.jsonl` (graded by
    Claude A–Z per head), `pairs-additions.txt` (hand additions) and the old `lex`.
  - A leading `~` marks a partial head that was never swept A–Z. A miss on a partial
    head gets a neutral reply instead of a mocking one.
  - Plurals and singulars count as matches.
  - The reply buckets in `part-c-app.js` `REPLY` are: correct, strong, weak, none,
    unsure, notword, letter, number, repeat.
- **Dictionary.** `src/dict.txt` (~66k words) is used for "not a word". The backend
  keeps its own copy at `backend/src/lib/wordlist.js`. Regenerate it with
  `node backend/scripts/make-wordlist.mjs` after any change to `dict.txt`; a
  backend test fails if they differ. `pairs-extra-words.txt` lists words added to
  `dict.txt` by hand.
- **The composer (making a puzzle).** Two-letter words are allowed. Unknown words
  are flagged, and saving asks for confirmation. The server
  (`POST /api/wordchain/chains`) refuses any chain with a non-dictionary word, so it
  never enters the general pool.
- **Day key.** Word Chain's `todayKey()` still uses **local** dates; everything else
  is UTC (audit S1, still open).

---

## 8. Key decisions and why

1. **One origin, paths not subdomains.** This gives one cookie, one `localStorage`
   (keys namespaced: `ps:` for the platform, `<game>:` for each game) and one SDK
   cache.
2. **The backend is additive.** Games must play, score and keep a streak with the
   API down. Never block a render on the network.
3. **Days are UTC** (except Word Chain's leftover local key). **Streaks are
   derived** from results, never incremented.
4. **Theme:** light, dark and system, stored in one shared `ps:theme`. Light is the
   default. A pre-paint script prevents a flash of the wrong theme. Tokens are in
   two layers, palette and role (`--bg`, `--fg`, `--accent`, …). There are no
   `--ink`/`--paper` names. Watch for self-referencing vars when renaming. In
   Sojourner, `--stage` stays dark in both themes.
5. **Auth** is an email code or Google; no passwords and no Apple (Apple is only
   required if the site is ever wrapped as an App Store app).
6. **Scores and offline play: option D** (decided 19 Oct). Play works offline. Games
   upload *moves* and the server recomputes the score; a result a client merely
   reports is stored (it counts for the player's own streak) but is never ranked.
   - **Built for Sojourner (stage 1, 20 Oct).** The game records each guess and each
     sprint answer, then sends `{v:1, focus, rounds:[regionId×5], sprint:{answers,
     secs}}` through `PS.saveResult({moves, key})`. The Worker replays it with the
     same engine (`packages/scoring/sojourner.cjs`) and stores the *server's* score
     as a **verified** result (`results.verified = 1`, `moves` kept so it can be
     replayed again if scoring is corrected). The client's own score is ignored.
   - The one number it cannot check is `secs` (the sprint clock bonus): clamped to
     60 and counted only for a finished sprint. Sojourner's real maximum is **1155**
     (750 + 320 + 25 + 60), not 1000.
   - Rankings (friends' leaderboards, standings, Analytics) read **verified** rows
     only. `key` is a fingerprint of the map data (only fields scoring reads); a
     mismatch is a retryable 503.
   - **Word Chain (stage 2, built 20 Oct): ranked on time, lowest wins, on the GAME'S OWN
     clock.** Kai's rule: a pause must never cost anyone time (a phone call, switching
     windows), so the ranked time is the clock the player watched. That clock stops while the
     player is paused or the window is in the background. The server does not measure the time;
     it keeps the claim honest.
   - Flow: when a fresh daily starts the game calls `POST /api/play/run` and gets a signed
     token (day + the server's moment; nothing stored). At the end it sends
     `{v:1, finals:[accepted guess per word|null], hints:[Lifelines per word], baseMs}` plus the
     token through `PS.saveResult` (`baseMs` = playing time, penalty NOT included). The Worker
     replays the chain with the same engine, works out the Lifeline penalty itself (15+25+40 s
     per word) and ranks **baseMs + that penalty**. Platform `score` is the 7 links solved; the
     time is `results.duration_ms`. It equals what the result screen showed.
   - **Ranked only if** the run has a genuine stamp for this day, `baseMs` is 10 s to 1 hour
     of play, and `baseMs` is no longer than the server's start-to-finish gap (+5 s of network
     delay). Pauses make the playing time shorter than the gap, never longer, so they are
     free. Otherwise the daily is stored **unranked** (own record and streak only): no token
     (offline or server down), another day's token, too fast, too long, or a held-back start.
     A chain that was not actually solved is refused outright.
   - **Known limit, chosen on purpose:** the server cannot catch a player who claims a shorter
     time than they played, and the whole bank is in the page the game ships, so a determined
     cheater can solve any chain in seconds on any clock. Rankings are friends-only, where an
     unbelievable time is not believed. Server-recorded pauses (pause/resume pings, tokens
     carrying the paused total) were considered and rejected: much more machinery, fragile
     offline, and no real extra protection. Revisit only if rankings ever become public.
   - The server uses the game's own `gamedata.json` calendar for the daily chain. If the game
     ever fetches its daily from the database bank (`GET /api/wordchain/bank/:day`) instead,
     `backend/src/lib/wordchain.js` must follow.
   - **Analytics:** a points game (Sojourner) is "higher is better, score ÷ max"; Word Chain
     is "lower time is better" and its card shows m:ss. The front-door card averages the
     *points* games only (labelled so); Word Chain is not in it until the Intellisense
     categories say how a time and a score combine.
7. **Leaderboards:**
   - Decided: public by default, verified scores only (the Terms say so).
   - Built: the API's leaderboards are **friends-only** (`play.js`).
   - Percentiles; with fewer than 20 players in a group, show rank; provisional
     until midnight UTC.
8. **Payments: Paddle** as merchant of record (it handles tax worldwide and
   supports partial refunds through `POST /adjustments`). The account is being set
   up.
   - Price: $24/year.
   - Refund rule: whole unused months, but a month begun within the last 2 days
     doesn't count as used. Example: bought Oct 15, cancelled Nov 17 → 11 months
     back.
   - The `/sapien/` and `/refunds/` pages and the Terms' Sapien section are written
     for Paddle's review.
9. **Display names:**
   - Unique, case-insensitive. A clash gives a 409 and a red note.
   - Names that come from Google and are already taken get a random tag
     ("John Smith 39K"; two digits plus a letter, no I or O).
   - New accounts get a proposed name: the part of the email before the "@" plus a
     tag, or the Google name. A "Choose your display name" card asks them once per
     visit until they save one.
   - An unconfirmed proposal is never shown publicly as a chain's byline.
10. **Friends** (decided with Kai, 19–20 Oct):
    - **Inviting:** the invite box takes an email or an invite code and **always
      answers "Sent."**, so it can't be used to discover who plays. An address that
      already has an account gets the invite in-game with no email. Otherwise it
      gets at most one invitation email per 30 days (from anyone), and every
      inviter's invite is turned into a friend request if that person joins within
      90 days.
    - **Limits:** typed emails 20/day and 50/month; codes 40/day and 100/month.
      Typed emails count against the email limits however they're delivered, so
      the limits can't leak who has an account.
    - **The queue:** a player sees at most 30 incoming invites; extras wait unseen.
      Actions are Accept, Later, Reject and Block. Three rejections in 7 days, or 5
      in 30, pause the sender's invites.
    - **Blocks** are seen only by the blocker, who can unblock. The blocked player is
      never told.
    - **Stop link:** invitation emails carry a "stop invitation emails" link,
      because non-members can't use a block list.
    - **Friend groups** are **private lists owned by one player**; friends aren't
      told. Making a group or adding to one is **Sapien**; removing and deleting are
      open to everyone. Removing or blocking a friend un-groups them on both sides.
      (Older notes saying Free players can "join groups" are superseded.)
11. **Avatars:**
    - The sets are 6 icons plus Monsters, Robots (whole robot `robot-NN` and head
      close-up `robot-NNb`) and Animals (`animal-NNx`, where x is group a–f: a
      dogs/foxes, b cats, c birds, d cows/bulls/hippos, e bears/zebras/giraffes,
      f other).
    - Each player sees a stable random 12 per set, seeded by user id (`DEAL` and
      `DEAL_SIZE` in `ui.js`). Change `DEAL` to re-deal everyone.
    - Players can upload their own picture (a square data URL).
12. **Phone layout:** `overflow-x: clip` on html/body; the fixed top bar must never
    cover content; pages should fit one phone screen.

---

## 9. Half-finished, broken, or known gaps

- **Analytics card is built but will show "play today's puzzle" until games post
  results.** `GET /api/player/analytics` (`backend/src/routes/analytics.js`) ranks
  Daily, Last dozen (from 12 results) and Lifetime (from 13) against all players,
  all friends and the picked friend group; Free sees Daily only. A game's card shows
  that game's raw score; the front door's card averages every game as a percentage
  of its maximum (a stand-in until the Intellisense categories exist). It reads the
  `results` table, which no game writes to yet (next item).
- **Both games now send their dailies** (option D, §8 item 6): at the end of a daily the
  game sends its moves, and a saved day not yet sent (today and yesterday) is retried the
  next time it opens. Practice and past days are never sent. Sojourner's old
  `SOJOURNER_API` hook is gone. Not yet tried by Kai on the live site. Word Chain's
  open items: the day key is still local (S1), and a daily played before this change has
  no stamp or moves, so it is not sent.
- **Friend challenges** (timed and 1v1) are **not built**: there is no server side.
  The "New challenge" buttons only show a "coming soon" toast.
- **Payments** are not wired. There is no Paddle checkout and no webhook.
  `PATCH /api/player/me` still accepts `plan` from the browser (marked
  `TODO(billing)` in `bar.html`); it must stop once the webhook exists. The upgrade
  card says "Payment is not switched on yet."
- **Admin page** does not exist, and the admin API is closed (Access not configured).
  Planned: a review queue for submitted chains and a refund calculator.
- **Word Chain:**
  - The composer's "send to friends" still uses a local placeholder list.
  - Player-made chains are kept on the device; nothing in the composer posts them
    to the server queue yet.
  - The day key is local, not UTC.
  - `og.png` and `icon-512.png` are still the old clay-ochre palette (regenerate
    with `og.js`).
  - Some strong pairs in `pairs.json` are suffix accidents (LEADER SHIP, WRECK AGE).
  - Some common words (e.g. STATION, MUSIC) are only partial heads.
- **Leaderboards:** public-by-default was decided but only friends-only exists.
- **Sojourner:** older notes list `.psbar-pad` not applied, mid-round text under the
  top bar, and a reveal-card jitter. Some layout fixes landed on 19 Oct; re-check
  before relying on those notes.
- **Safe Browsing:** the domain inherited a Google "deceptive site" flag from a
  previous owner. The fix is Google Search Console → Security Issues → Request
  Review, plus Microsoft SmartScreen. Status unknown; check with Kai.
- **Legal:** switch to "PlaySapien LLC" once the LLC exists; the Privacy page's
  date needs refreshing.
- Some Monster and Animal avatars may look close to well-known characters. Kai to
  review.

---

## 10. What Kai was planning next (in rough order)

1. **Deploy the backend for** `f40799a` (migration 0007 + `wrangler deploy`), if not done.
2. **Analytics steps 1 and 2: built (20 Oct 2026, commit `e09cb28`).** The card is
   fills as results arrive (option D, both stages, is built, item 5). Word Chain shows
   times; Sojourner shows points.
3. (Done: friend-group comparisons are part of item 2.)
4. **Paddle integration** once Paddle approves the account:
   - checkout button;
   - webhook that sets `plan_until` +12 months;
   - remove client-set `plan`;
   - refund calculator on an Admin page.
5. **Results pipeline (option D): built, both games (20 Oct).** Next: Kai checks it live; then
   friend challenges (item 6), which can reuse the run stamp for timed ones.
6. **Friend challenges:** 1v1 (turns through the server, so verified for free) and
   timed groups (need a server-stamped start and finish).
7. Small open offer: shrink "Share your code" on the Friends card into one "Or share
   your invite link" button (Kai asked why it exists; no decision yet).
8. LLC paperwork, then the legal-name updates.

---

## 11. More reading

- `docs/notes/`: design notes copied from the claude.ai project, with dates. Treat
  older ones as history. The most current is `accounts-and-admin.md`.
- `docs/BACKEND-SPEC.md` and `docs/INTEGRATION-AUDIT.md`: original reasoning.
- `games/wordchain/spec-v3.md` (game design), `games/wordchain/chain-tools/README.md`,
  `games/_template/README.md`, `backend/README.md` and `packages/tokens/README.md`.
- The top-level `README.md` is partly out of date: it describes Pages, and its test
  counts are old. Prefer this file.
