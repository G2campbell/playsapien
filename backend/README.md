# PlaySapien backend

One Cloudflare Worker and one D1 database behind `playsapien.com/api/*`, serving
the shell and both games. The design is settled in `docs/BACKEND-SPEC.md`; this
file is how you get it running.

Everything here is additive. If the Worker is down, both games still play, still
score, still keep a streak in localStorage. What the server adds is the three
things a device cannot do: an identity that survives a browser wipe, state
shared between two people, and a queue that reaches you.

---

## What you are deploying

You have deployed a Pages project before. A Worker is a different kind of thing
and the difference is worth two sentences.

A **Pages** project is files. You upload a folder, Cloudflare serves it, and
there is no code running on their side.

A **Worker** is code. One JavaScript file, run at the edge on every matching
request, with no server to keep alive and no container to size. **D1** is a
SQLite database that only the Worker can reach — there is no connection string
and no password, because the Worker gets at it through a *binding* declared in
`wrangler.toml`, and nothing outside that Worker can see it at all.

The command-line tool for both is `wrangler`, and it does everything: create the
database, run the migrations, set the secrets, deploy, and stream the logs.

---

## Prerequisites

- **Node 18 or newer.** `node -v` to check.
- **A Cloudflare account** with `playsapien.com` on it (the domain must be on
  Cloudflare for the route in step 6 to work).
- **A Resend account**, free tier. You will verify the domain there in step 5.
- **A Google Cloud project**, free. Step 5 again.

Install the dependencies once:

```sh
cd backend
npm install
```

That installs `wrangler` (the deploy tool) and `better-sqlite3` (which only the
tests use). **The Worker itself has no dependencies** — it runs on WebCrypto and
the Workers runtime and nothing else, so there is no build step and nothing to
bundle.

---

## 1. Sign in to Cloudflare

```sh
npx wrangler login
```

A browser opens, you approve, and a token is saved to your machine. Confirm it
worked:

```sh
npx wrangler whoami
```

---

## 2. Create the database

```sh
npx wrangler d1 create playsapien
```

It prints a block that ends with a `database_id`, something like:

```
[[d1_databases]]
binding = "DB"
database_name = "playsapien"
database_id = "8f3c1e5a-...-a1b2c3d4e5f6"
```

**Copy that `database_id` into `wrangler.toml`**, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`. That id is not a secret — it is just which
database, and the binding is what grants access.

---

## 3. Run the migration

Twice: once against the local copy wrangler keeps on your disk for `wrangler
dev`, once against the real one.

```sh
npx wrangler d1 migrations apply playsapien --local
npx wrangler d1 migrations apply playsapien --remote
```

`--remote` will ask you to confirm. It should say it applied `0001_init.sql`.

Check it landed:

```sh
npx wrangler d1 execute playsapien --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

You should see `chains`, `devices`, `friendships`, `identities`,
`incidents`, `invite_codes`, `login_codes`, `notices`, `rate_limits`,
`results`, `sessions`, `streaks`, `users`.

---

## 4. Generate the two random secrets

Two of the four secrets are just random bytes you make up. Generate them now:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run it twice and keep both strings. The first is `LOGIN_CODE_PEPPER`, the second
is `OAUTH_STATE_SECRET`. Put them somewhere you will not lose them — a password
manager, not a note.

What they do:

- **`LOGIN_CODE_PEPPER`** is mixed into the hash of every six-digit sign-in code
  before it is stored. A six-digit code has only a million possibilities, so a
  plain SHA-256 of one is trivially reversible with a lookup table. The pepper
  makes that table useless to anyone who does not also have this secret, which
  is not in the database. **Changing it invalidates every outstanding code** —
  harmless, they last ten minutes.
- **`OAUTH_STATE_SECRET`** signs the short-lived cookie that carries the PKCE
  verifier and the CSRF state through the Google round trip. **Changing it
  breaks any sign-in currently mid-flight** — also harmless.

---

## 5. Get the other two secrets

### Resend, for the sign-in mail

1. Sign up at [resend.com](https://resend.com).
2. **Domains → Add Domain → `playsapien.com`.** It shows you three or four DNS
   records (DKIM, SPF, and usually a DMARC suggestion).
3. Add them in the Cloudflare dashboard under **playsapien.com → DNS**. Set each
   one to **DNS only** (grey cloud, not orange) — mail records must not be
   proxied.
4. Back in Resend, click **Verify**. It usually goes green in a few minutes.
5. **API Keys → Create API Key.** Sending permission is enough. Copy it; Resend
   shows it once.

That key is `RESEND_API_KEY`. If it is not set, the Worker logs the sign-in code
to the console instead of sending mail and reports `{ sent: true }` as usual,
which is exactly what you want for local development and exactly what you do not
want in production.

Set `MAIL_FROM` in `wrangler.toml` to an address at the domain you verified.

### Google OAuth — the fiddly one

The console is confusingly laid out and three of these fields have to match
strings elsewhere exactly. Go slowly.

1. [console.cloud.google.com](https://console.cloud.google.com) → the project
   dropdown at the top → **New Project**. Call it `playsapien`. Wait for it to
   be created and make sure it is the selected project.

2. **APIs & Services → OAuth consent screen.**
   - User type: **External**. (Internal only exists for Workspace orgs.)
   - App name: `PlaySapien`. User support email: yours. Developer contact:
     yours.
   - **Authorised domains:** add `playsapien.com`.
   - **Scopes:** add `openid`, `.../auth/userinfo.email` and
     `.../auth/userinfo.profile`. These three need no Google review.
   - Save. The app sits in **Testing** status, where only accounts you list as
     test users can sign in. **Publish App** when you are ready for everyone;
     with only those three scopes it is published immediately, with no
     verification process.

3. **APIs & Services → Credentials → Create Credentials → OAuth client ID.**
   - Application type: **Web application**.
   - Name: `PlaySapien Worker`.
   - **Authorised JavaScript origins:** `https://playsapien.com`.
   - **Authorised redirect URIs:** this one has to be exact, character for
     character, including the scheme and with no trailing slash:

     ```
     https://playsapien.com/api/auth/google/callback
     ```

     If you also want Google sign-in to work against `wrangler dev`, add a
     second entry with your local origin and the same path. A mismatch here is
     the single most common failure, and Google reports it as
     `redirect_uri_mismatch` on the consent screen.
   - Create. You get a **Client ID** (ends `.apps.googleusercontent.com`) and a
     **Client secret**.

4. Put the **Client ID** into `wrangler.toml` as `GOOGLE_CLIENT_ID`. It is not a
   secret — it travels in the redirect URL in plain sight. The **Client secret**
   is `GOOGLE_CLIENT_SECRET` and goes in the secret store in the next step.

> Changing `APP_ORIGIN` in `wrangler.toml` means changing the redirect URI in
> the Google console to match. The Worker builds the redirect URI from
> `APP_ORIGIN`, so the two are the same string in two places and Google checks
> them against each other.

---

## 6. Set the secrets and deploy

Four secrets. Each command prompts for the value, so nothing lands in your shell
history:

```sh
npx wrangler secret put LOGIN_CODE_PEPPER
npx wrangler secret put OAUTH_STATE_SECRET
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put RESEND_API_KEY
```

Check what is set (values are never shown, only names):

```sh
npx wrangler secret list
```

Deploy:

```sh
npx wrangler deploy
```

### Point playsapien.com/api/* at it

The Worker is deployed but nothing routes to it yet. In the Cloudflare
dashboard:

**Workers & Pages → `playsapien-api` → Settings → Domains & Routes → Add route**

- Route: `playsapien.com/api/*`
- Zone: `playsapien.com`

That pattern is deliberately narrow. Everything that is not `/api/*` keeps going
to the Pages project serving the shell and the games, which is what puts the API
and the games on one origin — and *that* is what lets one `HttpOnly` cookie
cover all three.

Confirm:

```sh
curl https://playsapien.com/api/health
# {"ok":true,"data":{"status":"ok"}}
```

### Protect the admin routes

`/api/admin/*` has no password of its own. It is behind **Cloudflare Access**,
which is free at this scale.

1. Dashboard → **Zero Trust → Access → Applications → Add an application →
   Self-hosted**.
2. Application name: `PlaySapien admin`. Domain: `playsapien.com`, path `api/admin`.
3. Add a policy: Action **Allow**, Include **Emails** → your address.
4. Save, then open the application's **Overview** and copy the **Application
   Audience (AUD) Tag**.
5. Put that tag in `wrangler.toml` as `ACCESS_AUD`, and your team domain (the
   `something.cloudflareaccess.com` shown under Zero Trust → Settings) as
   `ACCESS_TEAM_DOMAIN`. Redeploy.

The Worker verifies the JWT Access attaches to each request rather than trusting
it, so a misconfigured or removed Access policy does not silently open the admin
surface. **If either variable is unset, every admin route returns 503 and does
nothing** — the failure mode is closed, on purpose.

---

## Running it locally

```sh
npx wrangler dev
```

That serves on `http://localhost:8787` against the local D1 copy you migrated in
step 3. Secrets set with `wrangler secret put` are *not* available locally;
create a `.dev.vars` file next to `wrangler.toml` for those:

```
LOGIN_CODE_PEPPER=any-string-will-do-locally
OAUTH_STATE_SECRET=any-other-string
GOOGLE_CLIENT_SECRET=
RESEND_API_KEY=
```

`.dev.vars` is for local development only and must never be committed. With
`RESEND_API_KEY` empty, the sign-in code is printed to the terminal instead of
mailed, so you can sign in end to end offline:

```sh
curl -s localhost:8787/api/auth/email/start \
  -H 'content-type: application/json' -d '{"email":"you@example.com"}'
# look in the wrangler dev terminal for: [email] ... sign-in code for ... is 123456

curl -s localhost:8787/api/auth/email/verify -c jar.txt \
  -H 'content-type: application/json' -d '{"email":"you@example.com","code":"123456"}'

curl -s localhost:8787/api/auth/session -b jar.txt
```

Querying the local database:

```sh
npx wrangler d1 execute playsapien --local --command "SELECT id, email FROM users"
```

Watching production logs:

```sh
npx wrangler tail
```

---

## Tests

```sh
npm test
```

67 tests, no network, no wrangler, about two seconds. They run the real route
handlers against a real SQLite database — `test/helpers/d1.js` is a thin shim
presenting D1's `prepare/bind/first/all/run/batch` interface over
`better-sqlite3`, with foreign keys on, so the cascades and the
`CHECK (a_id < b_id)` constraint are genuinely exercised.

Three things cannot run offline and are injected as dependencies so the tests
can stub them (`makeDeps` in `src/index.js`, overridden via `env.DEPS`):

| Dependency | Stubbed as | What the tests still cover |
|---|---|---|
| `sendLoginCode` | records the call | the code itself, its hash, expiry, attempts |
| `googleJwks` | a key set the test generated | `verifyJwt` for real — signature, `iss`, `aud`, `exp` |
| `accessJwks` | ditto, for Cloudflare Access | the same verification on the admin path |
| `fetchImpl` | a canned token response | PKCE, the signed state cookie, the CSRF check |

The Google tests generate an RSA key pair, sign an ID token with it, and hand
the matching public key to the stub — so a token signed with the wrong key, or
altered after signing, fails in the test for exactly the reason it would fail
against Google. The clock is injected the same way, which is what lets a test
say "five consecutive days" without waiting five days.

---

## The API

All under `/api`. JSON in, JSON out. Every response is one of two shapes:

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "bad_code", "message": "..." } }
```

`code` is a stable machine string; `message` is for a human and may be reworded.
Stack traces never appear in either.

```
POST   /api/auth/email/start        { email }            -> { sent: true }
POST   /api/auth/email/verify       { email, code }      -> sets cookie, { user }
GET    /api/auth/google/start                            -> 302 to Google
GET    /api/auth/google/callback                         -> sets cookie, 302 home
POST   /api/auth/logout                                  -> clears cookie
GET    /api/auth/session                                 -> { user } | { user: null }
GET    /api/auth/devices                                 -> active sessions
DELETE /api/auth/devices/:id                             -> revoke one

GET    /api/player/me                                    -> profile + all streaks
PATCH  /api/player/me               { handle?, display_name?, avatar?, tz? }
POST   /api/player/claim            { device_ids: [] }   -> merge, recompute
DELETE /api/player/me                                    -> delete account + data
GET    /api/player/notices                               -> unread notices
POST   /api/player/notices/read     { ids: [] }

GET    /api/player/friends                               -> accepted + pending
GET    /api/player/friends/code                          -> your invite code
POST   /api/player/friends/code/rotate
POST   /api/player/friends/add      { code }             -> request or auto-accept
POST   /api/player/friends/:id/accept
DELETE /api/player/friends/:id                           -> remove or decline
POST   /api/player/friends/:id/block

POST   /api/play/result             { game, day, mode, score, max_score, detail }
GET    /api/play/day/:day                                -> your results, both games
GET    /api/play/leaderboard/:game/:day                  -> you + friends, that day
GET    /api/play/standings                               -> friends, rolling 30 days

POST   /api/wordchain/chains        { words, credit }    -> queue a submission
GET    /api/wordchain/chains/mine                        -> your submissions + status
GET    /api/wordchain/bank/:day                          -> the day's chain
POST   /api/sojourner/score         (legacy alias -> /api/play/result)

GET    /api/admin/queue                                  -> pending + recommended
POST   /api/admin/chains/:id        { action }           -> daily|practice|reject
GET    /api/admin/incidents
POST   /api/admin/users/:id/block
```

### Scores

| Game | `max_score` | Where it comes from |
|---|---|---|
| `sojourner` | 1000 | `partD.js:6-10`: phase 1 is 750, the sprint and its sweep bonus are the other 250 |
| `wordchain` | 7 | See below |

Word Chain has no points — spec-v3 §1 settles it: *"Score: points → None. A
running clock, Pips-style."* So the platform's `score` for Word Chain is the
number of links solved, and an eight-word chain (word 1 given, words 2–8
guessed) has seven of them. The clock, which is the number players care about,
travels in `duration_ms`, where a "fastest today" board can sort on it. This is
the one number in the API that the spec does not fix; the reasoning is in a
comment at the top of `src/lib/validate.js`.

### Rate limits

Applied before any expensive work, and counted globally in D1 rather than
per-colo, because "six a day" has to mean six.

| Limit | Key | Window |
|---|---|---|
| 6 sign-in codes | email address | 1 hour |
| 10 verify attempts | IP | 1 hour |
| 5 chain submissions | user | 1 day |
| 30 friend adds | user | 1 day |

---

## Connecting the games

**Sojourner** needs one line. The hook is already in `partD.js:337-349`:

```html
<script>window.SOJOURNER_API = '/api/sojourner';</script>
```

Nothing leaves the device until that constant is set, which is why nothing has
to change inside the game.

**Word Chain** needs the UTC day fix first. `part-c-app.js:104-107` decides the
day in local time; the server accepts UTC only, and a client on UTC-5 would
otherwise spend five hours a day submitting a day the server calls tomorrow. Fix
`todayKey()` to use `getUTCFullYear`/`getUTCMonth`/`getUTCDate`, then post to
`/api/play/result` with `game: 'wordchain'`, `score` = links solved,
`max_score: 7` and the elapsed time in `duration_ms`.

Both games should keep writing localStorage when signed in. The server is the
durable copy; the device stays the fast one, and the game keeps working on a
plane.

---

## What is not built

- **The nightly chain assessment.** SUBMISSION-PIPELINE.md §3 describes a cron
  that asks Claude to grade pending chains on safety first and quality second.
  The tables are here (`chains.quality`, `chains.verdict`, `chains.flag`) and the
  admin queue already sorts on `quality`, but nothing writes those columns yet —
  it needs an Anthropic key and a batch job, and it is step 5 of the build order
  while this is step 1. The `scheduled` handler in `src/index.js` currently does
  housekeeping only: expired login codes, dead sessions, lapsed rate-limit rows.
- **Unblocking a friend.** `friendships` has no column recording who blocked, so
  the block is symmetric and there is no endpoint to undo it. The reasoning is
  in a comment on `blockFriend` in `src/routes/friends.js`; the fix, if it turns
  out to matter, is a column rather than a cleverer reading of `requested_by`.
- **Apple sign-in.** Per the decision in spec §1. Worth knowing for later: if
  PlaySapien ever ships in the App Store, Apple *requires* Sign in with Apple
  wherever Google sign-in is offered. That is a store rule, not a web rule.

---

## Cost

At a few thousand daily players this sits inside Cloudflare's free tier for both
Workers and D1. The paid Workers plan is $5/month and worth taking anyway for
the higher limits and cron reliability. Resend's free tier is 3,000 sends a
month, which at one sign-in per device per year is a great many players. The
honest number for v1 is $5–15/month.
