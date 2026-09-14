# PlaySapien backend

One Cloudflare Worker and one D1 database behind `playsapien.com/api/*`,
serving both games and the shell.

The games work today with no server at all. Everything here is additive: if the
Worker is down, both games still play, still score, still keep a streak in
localStorage. What the server adds is the three things a device cannot do —
**an identity that survives a browser wipe**, **state shared between two
people**, and **a queue that reaches you**.

---

## 1. The auth decision

You asked for the trade-off before committing. Here it is, and the
recommendation is at the end of this section.

### First, two facts that narrow the question

**You need transactional email either way.** Password reset needs it. So does
email verification, "your chain was accepted", and any friend notification that
isn't in-app. So "magic links need an email provider" is not a cost of magic
links — it is a cost of having accounts at all. Both columns pay it.

**Sign-in will be rare.** This is a daily puzzle, not a bank. Sessions should
last a year and renew on use, so a player signs in roughly *once per device,
ever*. That single fact reshapes the comparison: the usual complaint about magic
links — "a round trip through email every time I log in" — is a cost paid once a
year, not once a day.

### Magic link

**For**

- Nothing to store. No password hashes, so no hash to leak, no reuse risk
  inherited from another site's breach, and nothing for you to be liable for.
- Cloudflare Workers have no native bcrypt or argon2. WebCrypto gives you
  PBKDF2, which is usable but the weakest of the three; argon2 means shipping
  WASM into the Worker. Not storing passwords sidesteps a real constraint rather
  than working around it.
- The reset flow *is* the login flow. One path, not two, so half the auth UI
  never gets built: no signup form, no forgot form, no reset form, no change
  form.
- Every sign-in re-proves the player still controls the address, so a stale
  email surfaces immediately rather than at the moment they need to recover.

**Against**

- **The wrong-browser problem.** This is the real one. A player opens the mail
  app on their phone, taps the link, and it opens in that app's in-app browser —
  not Safari, where they were playing. The session lands in the wrong place and
  they appear not to be logged in. This single issue accounts for most
  real-world magic-link frustration.
- Deliverability is load-bearing. If the mail lands in spam or a corporate
  filter eats it, the player cannot get in at all. With a password, email only
  matters on the rare reset.
- Corporate link scanners prefetch URLs, which consumes a single-use token
  before the human ever clicks it.
- A forwarded email is account access until the token expires.

### Email + password

**For**

- Instant, familiar, and password managers fill it. No dependency on mail
  delivery for routine sign-in.
- No wrong-browser problem — you sign in where you are.

**Against**

- You are storing credentials. That is a permanent obligation, and the Worker
  runtime gives you the weakest of the standard hashing options without extra
  work.
- You still need the whole email path for reset, so this is strictly *more* code
  than magic link, not less.
- Password reuse means a breach elsewhere becomes a breach here, and players
  will reuse.

### The recommendation: email **code**, not email link

The wrong-browser problem is the only serious argument against magic links, and
it is entirely an artifact of *the link being the credential*. Send a **six-digit
code** instead and it disappears: the player reads the code in their mail app and
types it into the tab they already have open. Same device or not, same browser or
not, it does not matter.

So: send both. One mail containing a six-digit code *and* a link. The link is a
convenience on desktop, where it works fine; the code is the path that always
works. Slack and Notion both do exactly this, which is why their sign-in rarely
strands anyone.

That gives you every advantage of the magic-link column with the one real
objection removed, and it stays cheaper to build than passwords.

**Recommended:**

- **Email code** — six digits, ten-minute expiry, single use, five attempts then
  the code is burned. Plus a link carrying the same token for desktop.
- **Google sign-in** — OAuth 2.0 with PKCE. Most players will take this, and it
  costs nothing but setup.
- **No Apple** for now, per your call on the developer fee. Worth noting for
  later: if PlaySapien ever ships in the App Store, Apple *requires* Sign in with
  Apple wherever Google sign-in is offered. That is a store rule, not a web rule,
  so it only bites if you wrap the games natively.
- **No passwords at all.** Not in v1, and ideally not ever — adding them later is
  easy if players ask, and never adding them means never storing them.

One more thing this buys: the same six-digit mechanism is what verifies an email
change and what re-authenticates before a destructive action. One primitive,
three uses.

---

## 2. Identity, and what happens to existing players

Everyone who plays today is anonymous, with their history in localStorage. That
has to keep working, and it has to be able to become an account without loss.

Three states, in order:

1. **Anonymous.** No server contact at all. Exactly today's behaviour. This is
   the default and most players will never leave it.
2. **Device identity.** On first play the client mints a `device_id` (a UUIDv4 in
   `ps:device`). It is sent with results so the server can hold history for a
   device that has no account. Not an identity in any real sense — a browser wipe
   ends it — but it means the moment someone *does* sign up, there is something
   to claim.
3. **Account.** Signing in binds every `device_id` the browser has seen to a
   `user_id`. Past results are re-parented, streaks recomputed server-side, and
   from then on the account is authoritative and syncs across devices.

The upgrade is the interesting case. A player with a 40-day Sojourner streak on
their phone signs in on their laptop: the laptop has a different `device_id` and
no history. **Merge rule: union, then recompute.** Results are keyed
`(user, game, day)` — take the union of both devices' days, keep the higher score
on a collision, then recompute streaks from the merged set rather than trusting
either side's stored number. Streaks are always derived, never merged directly.

This is also why the client should keep writing localStorage even when signed in.
The server is the durable copy; the device stays the fast one, and the game keeps
working on a plane.

---

## 3. Schema

D1 is SQLite. Times are Unix seconds, integer, UTC.

```sql
-- ---------- identity ----------

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- 'u_' + 22 base58 chars
  handle        TEXT UNIQUE,               -- lowercase, 3-20, [a-z0-9_], null until chosen
  display_name  TEXT NOT NULL DEFAULT '',
  email         TEXT UNIQUE,               -- normalised lowercase; the recovery address
  email_verified INTEGER NOT NULL DEFAULT 0,
  avatar        TEXT,                      -- a token like 'nyansapo-3', not a URL
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  tz            TEXT,                       -- IANA, advisory only; days are UTC
  strikes       INTEGER NOT NULL DEFAULT 0,
  blocked_at    INTEGER,                    -- non-null = cannot submit chains
  deleted_at    INTEGER
);

-- one row per sign-in method; a user may have both
CREATE TABLE identities (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,              -- 'email' | 'google'
  subject      TEXT NOT NULL,              -- email address, or Google 'sub'
  created_at   INTEGER NOT NULL,
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,            -- SHA-256 of the cookie value, never the value
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  ua          TEXT,                        -- truncated, for "your devices"
  ip_cc       TEXT,                        -- country only, from CF-IPCountry
  revoked_at  INTEGER
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- the six-digit code, and the equivalent link token
CREATE TABLE login_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,               -- SHA-256 of the six digits + a pepper
  purpose     TEXT NOT NULL,               -- 'signin' | 'verify_email' | 'reauth'
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_codes_email ON login_codes(email, created_at);

-- devices, so an anonymous history can be claimed later
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,            -- client-minted UUID
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER
);

-- ---------- play ----------

-- one row per player per game per day. First write wins; see §5.
CREATE TABLE results (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL,
  game        TEXT NOT NULL,               -- 'sojourner' | 'wordchain'
  day         TEXT NOT NULL,               -- 'YYYY-MM-DD', UTC
  mode        TEXT NOT NULL DEFAULT 'daily',
  score       INTEGER NOT NULL,
  max_score   INTEGER NOT NULL,
  detail      TEXT,                        -- JSON: per-round scores, the shareable grid
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, game, day, mode),
  UNIQUE (device_id, game, day, mode)
);
CREATE INDEX idx_results_day  ON results(game, day);
CREATE INDEX idx_results_user ON results(user_id, game, day);

-- derived from results, recomputed on write. Never the source of truth.
CREATE TABLE streaks (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game        TEXT NOT NULL,               -- or '*' for the platform streak
  current     INTEGER NOT NULL DEFAULT 0,
  longest     INTEGER NOT NULL DEFAULT 0,
  last_day    TEXT,
  played      INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, game)
);

-- ---------- social ----------

-- exactly one row per pair, enforced by a_id < b_id
CREATE TABLE friendships (
  a_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state        TEXT NOT NULL,              -- 'pending' | 'accepted' | 'blocked'
  requested_by TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  responded_at INTEGER,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX idx_friend_b ON friendships(b_id, state);

-- a rotatable invite code, so adding a friend is a link not a search
CREATE TABLE invite_codes (
  code       TEXT PRIMARY KEY,             -- 8 chars, unambiguous alphabet
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- ---------- chain submissions (from SUBMISSION-PIPELINE.md) ----------

CREATE TABLE chains (
  id          TEXT PRIMARY KEY,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  words       TEXT NOT NULL,               -- JSON array
  words_hash  TEXT NOT NULL UNIQUE,        -- dedupe identical submissions
  status      TEXT NOT NULL,               -- 'pending'|'approved'|'rejected'|'blocked'
  pool        TEXT,                        -- 'daily' | 'practice'
  scheduled_for TEXT,                      -- 'YYYY-MM-DD' once slotted
  quality     INTEGER,                     -- model's 1-5
  verdict     TEXT,                        -- model's reasoning, for your review page
  flag        TEXT,                        -- safety category, null when clean
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT                         -- 'model' | 'admin'
);
CREATE INDEX idx_chains_status ON chains(status, created_at);
CREATE UNIQUE INDEX idx_chains_slot ON chains(scheduled_for) WHERE scheduled_for IS NOT NULL;

CREATE TABLE incidents (
  id         TEXT PRIMARY KEY,
  chain_id   TEXT,
  author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  words      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  detail     TEXT,
  at         INTEGER NOT NULL
);

CREATE TABLE notices (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,                  -- 'chain_accepted'|'friend_request'|...
  body     TEXT NOT NULL,
  link     TEXT,
  created_at INTEGER NOT NULL,
  read_at  INTEGER
);
CREATE INDEX idx_notices_unread ON notices(user_id) WHERE read_at IS NULL;

-- ---------- plumbing ----------

CREATE TABLE rate_limits (
  key        TEXT PRIMARY KEY,             -- 'signin:<email>' | 'submit:<user>'
  count      INTEGER NOT NULL,
  window_at  INTEGER NOT NULL
);
```

Two notes on choices that look odd.

`friendships` uses `CHECK (a_id < b_id)` so a pair has exactly one row and the
primary key makes a duplicate request impossible. The cost is that "my friends"
is `WHERE a_id = ? OR b_id = ?`, which is two index lookups rather than one. At
a few hundred friends per player that is nothing, and it buys away the entire
class of bug where A and B disagree about whether they are friends.

`results` has two unique constraints, one on `user_id` and one on `device_id`.
Only one is populated for a given row before an account exists, and SQLite treats
NULLs as distinct in a unique index, so the unused one does not fire. This is
what makes an anonymous result claimable without a second table.

---

## 4. API

All under `/api`. JSON in, JSON out. Session is an `HttpOnly; Secure;
SameSite=Lax; Path=/` cookie — which works across every game precisely because
the path-based layout put them on one origin.

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
GET    /api/sojourner/score         (legacy alias -> /api/play/result)

GET    /api/admin/queue                                  -> pending + recommended
POST   /api/admin/chains/:id        { action }           -> daily|practice|reject
GET    /api/admin/incidents
POST   /api/admin/users/:id/block
```

`/api/admin/*` sits behind Cloudflare Access, not a password in the app. Access
is free at this scale and means the admin surface has no login code of its own to
get wrong.

The `/api/sojourner/score` alias exists because `partD.js:341` already posts
there when `window.SOJOURNER_API` is set. Keeping the alias means the existing
client hook works with no change to the game.

---

## 5. Rules worth stating before they are written

**Scores are client-reported, and that is a decision, not an oversight.** A web
game cannot stop a determined player from posting a perfect score — the logic is
in the browser. What matters is the blast radius. Leaderboards are
**friends-only**, so a cheater fools people who know them. That is self-limiting
in a way a global leaderboard is not, and it is the reason not to build a global
one yet.

The server still enforces what it cheaply can: `day` must be today or yesterday
(a short grace for someone finishing across midnight UTC), `score` must be
within the game's declared range, `duration_ms` must be plausible, and **first
write wins** — a second submission for the same `(user, game, day, mode)` is
rejected, not overwritten, so a player cannot retry until they like the number.
The full `detail` is stored, so if a global leaderboard ever matters, replay
validation can be added retroactively against data already collected.

**Streaks are always derived.** Never increment a counter. Recompute from
`results` on every write. It is one indexed query, it makes the merge in §2
correct by construction, and it means a bug can never permanently corrupt a
player's proudest number.

**Days are UTC everywhere.** The audit found Sojourner using UTC and Word Chain
using local time (`part-c-app.js:104-107`). The server accepts UTC only and Word
Chain moves to match. `users.tz` is stored for display — "your streak ends in 4
hours" — and never for deciding what day it is.

**Deleting an account deletes the play data.** Cascades handle it. The one
exception is `incidents`, which keeps the words and the reason with a nulled
author — that table exists to make a pattern visible across submissions, and it
fails at that if a rejected submitter can erase it by deleting their account. Say
so in the privacy policy rather than doing it quietly.

**Rate limits, from the start.** Six sign-in codes per email per hour; ten
verify attempts per IP per hour; five chain submissions per user per day; thirty
friend adds per user per day. The auth ones are not optional — an unthrottled
`/auth/email/start` is a free way to send mail from your domain to anyone, which
is how a domain's sending reputation dies.

**Email enumeration.** `/auth/email/start` returns `{ sent: true }` whether or
not the address is known, and creates the user lazily on first successful verify.
No endpoint reveals whether an address has an account.

---

## 6. Build order

Each step is independently useful and independently shippable.

1. **Worker skeleton + D1 + migrations.** Routing, CORS, the session middleware,
   `/api/auth/session` returning null. Nothing user-visible.
2. **Auth.** Email code + Google. The shell's Profile button becomes real. This
   is the step everything else waits on.
3. **Results and streaks.** Both games post to `/api/play/result`; the shell
   shows a real cross-game profile. Sojourner needs one line —
   `window.SOJOURNER_API` — because the hook is already there. Word Chain needs
   the UTC day fix first.
4. **Friends.** Invite codes, requests, the friends-only daily leaderboard. This
   is the first thing that makes an account worth having, and Sojourner's Friends
   sheet stops saying "Coming soon".
5. **Chain submissions.** The queue, the nightly assessment cron, the admin page.
   The design in `games/wordchain/SUBMISSION-PIPELINE.md` is sound and carries
   over unchanged — it just needs the accounts from step 2 to exist first.

Steps 1-3 are the ones that pay for themselves immediately. Step 4 is the one
players will ask for. Step 5 is the one that turns the game into something that
grows without you writing every chain.

## 7. Cost

At a few thousand daily players this sits inside Cloudflare's free tier for both
Workers and D1, with the paid Workers plan ($5/month) worth taking anyway for the
higher limits and the cron reliability. Transactional email is the only real line
item — Resend's free tier covers 3,000 sends a month, which at one sign-in per
device per year is a lot of players. The nightly chain assessment runs about
$0.0013 a chain on Haiku, so a hundred submissions a day is 13 cents.

The honest number for v1 is **$5-15/month** until something goes unexpectedly
well.
