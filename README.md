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

Both game builds still hard-code `/tmp` paths and Word Chain's needs a `dict.txt`
that is not in the repo — see audit §S8. That is the next thing to fix, and the
reason there is no CI for them yet.

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
- Specs are versioned rather than edited, so a critique always points at a fixed
  target. A new version means the previous critique's open questions were answered.
