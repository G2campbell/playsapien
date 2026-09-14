-- PlaySapien, initial schema. From docs/BACKEND-SPEC.md §3.
--
-- D1 is SQLite. Times are Unix seconds, integer, UTC. Days are 'YYYY-MM-DD',
-- UTC, everywhere -- users.tz is display advice and never decides what day it
-- is.

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

-- one row per player per game per day. First write wins; see spec §5.
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

-- Additions beyond spec §3, both index-only. The schema itself is unchanged.
--
-- Sign-in mail is throttled by email address, so /auth/email/start hits
-- login_codes by (email, purpose) on every call; idx_codes_email leads with
-- email so it is already covered. The two below cover the joins the spec's
-- endpoints need but its index list does not mention.
CREATE INDEX idx_identities_user ON identities(user_id);
CREATE INDEX idx_invite_user ON invite_codes(user_id) WHERE revoked_at IS NULL;
