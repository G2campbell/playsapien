# PlaySapien

Daily puzzles at **playsapien.com**, on one origin, sharing one player.

```
playsapien.com/            apps/shell        the front door
playsapien.com/sojourner/  games/sojourner   daily geography, on a bare globe
playsapien.com/wordchain/  games/wordchain   daily word chain
playsapien.com/api/*       backend           Worker + D1
playsapien.com/sdk.js      packages/sdk      the client all three share
```

## Why one origin

Paths rather than subdomains, and everything follows from it. One origin means
one cookie, so signing in on the front door signs you in inside both games with
no CORS and no token passing. It means one `localStorage` keyspace, so a streak
is a streak. It means one cached copy of `sdk.js` for all three surfaces.

The cost is that the games have to agree about things they previously did not —
key prefixes, what "today" means, whose `_headers` wins. `docs/INTEGRATION-AUDIT.md`
is the list of everywhere they disagreed and what was done about it.

## Layout

| Path | What it is |
|---|---|
| `apps/shell/` | The landing page. One standalone HTML file, no build step. Carries the account layer — sign in, profile, friends, settings. |
| `apps/legal/` | Platform `/about/`, `/privacy/`, `/terms/`. Static HTML. |
| `games/sojourner/` | Five places a day on an unlabelled terrain globe. Python pipeline emits a hosted `dist/` and a single-file build. |
| `games/wordchain/` | Link every word to the next. Python build inlines everything into one `index.html`. |
| `backend/` | Cloudflare Worker + D1. Auth, players, friends, results, the chain queue. 70 tests. |
| `packages/sdk/` | The dependency-free client both games and the shell call. Offline-first. 36 tests. |
| `packages/tokens/` | Every colour, and the theme mechanism. Two checkers gate it in CI. |
| `packages/ui/` | The chrome every game repeats: sheets, the corner bar, settings, controls. Structure only — each game keeps its character through dials. |
| `packages/build/` | The part of the game builds that is genuinely shared: the `<head>`, and where a build reads from and writes to. |
| `games/_template/` | **Start a new game here.** A working game with all of the above already wired. |
| `deploy/` | Root `_headers` / `_redirects` and the bundled `sdk.js`. |
| `docs/` | The audit and the backend spec. Read these before changing anything cross-cutting. |

## Start here

- **`docs/INTEGRATION-AUDIT.md`** — what breaks when two independent games become
  one product, with `file:line` for every finding. Several are still open.
- **`docs/BACKEND-SPEC.md`** — schema, API, the auth decision and why, and the
  build order. The backend implements it.
- **`backend/README.md`** — how to actually deploy the Worker, set the secrets,
  and run it locally. Written for someone who has deployed Pages but not Workers.

## Developing

```sh
# backend
cd backend && npm install && npm test          # 70 tests, no Cloudflare needed
npx wrangler dev                               # local Worker + local D1

# sdk
cd packages/sdk && npm test                    # 36 tests
npx esbuild src/index.js --bundle --format=esm --minify --outfile=../../deploy/sdk.js

# the shell is a single file — open apps/shell/src/index.html, or serve it
# alongside deploy/sdk.js and a Worker on /api to exercise the account layer.
```

```sh
# a new game
cp -r games/_template games/yourgame && python3 games/yourgame/src/build.py
# see games/_template/README.md — six things to change, and the rules

# the games — all build from a clean checkout (audit S8)
python3 games/wordchain/src/build.py            # -> games/wordchain/dist/
python3 games/sojourner/src/build.py            # -> games/sojourner/dist/
python3 games/wordchain/src/build.py --check    # validate, write nothing; CI runs this
```

Sojourner's baked globe (~40 MB of textures, the region id map, the flag SVGs)
and three.js are deliberately not in git. Without them its build still emits
`index.html`, the legal pages and the deploy fragments, and names exactly which
input is missing and where it comes from; `--allow-missing` makes that a warning
rather than exit 2, which is how CI runs it. See `games/sojourner/README.md`.

Both builds take `--src` / `--build` / `--dist` (and `$SRC` / `$BUILD` / `$DIST`);
the `<head>` both emit comes from `packages/build/head.py`.

## Deploying

Five Cloudflare projects, each deploying on its own:

1. **Pages: `playsapien-shell`** → `/` — the shell, the legal pages, `sdk.js`,
   and the root `_headers` / `_redirects` from `deploy/`.
2. **Pages: `playsapien-sojourner`** → `/sojourner/`
3. **Pages: `playsapien-wordchain`** → `/wordchain/`
4. **Worker: `playsapien-api`** → `/api/*`
5. **A router Worker** on `playsapien.com/*` dispatching by first path segment.

The router is the only shared piece and it only changes when a game is added.
Every game keeps its own release cadence.

## Conventions

- **Storage keys are namespaced and it matters.** `sojourner:` and `wordchain:`
  for per-game progress, `ps:` for anything cross-game. One origin means one
  keyspace; two games writing `streak` would clobber each other.
- **Days are UTC.** Everywhere, client and server. `PS.dayKey()` is the only
  correct source.
- **Streaks are derived, never incremented.** Recomputed from results on every
  write, so a bug cannot permanently corrupt someone's proudest number.
- **The backend is additive.** Both games must still play, score and keep a
  streak with the Worker switched off entirely. The SDK never throws into game
  code and never blocks a render.
- **One vocabulary.** Role names only: `--bg`, `--fg`, `--accent`. There is no
  `--ink` or `--paper` any more — they meant opposite things in the two games,
  which is exactly why they are gone.
- **Shared code is inlined, never copied.** Each surface is a standalone file, so
  `tokens.css`, `theme.js`, `ui.css` and `ui.js` are inlined at build time from
  one canonical copy. `check-inline.mjs` fails the build if any copy drifts.
- Specs are versioned rather than edited, so a critique always points at a fixed
  target. A new version means the previous critique's open questions were answered.
