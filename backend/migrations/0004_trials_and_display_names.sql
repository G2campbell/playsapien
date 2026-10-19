-- PlaySapien 0004: one free Sapien trial per email, and display names that
-- are looked up case-insensitively.
--
-- ---------- trial_claims ----------
--
-- Every email address gets ONE two-day Sapien trial, ever. The record has to
-- outlive the account -- otherwise "delete the account, sign up again" is a
-- fresh trial every two days -- so it is NOT tied to users(id) and is NOT
-- removed when an account is deleted.
--
-- What is kept is not the address itself but a keyed hash of it (HMAC with
-- the server's LOGIN_CODE_PEPPER secret; see src/lib/trial.js), taken after
-- normalising away the usual ways of writing one inbox several ways: case,
-- "+tags", and dots in a Gmail address. The hash can answer "has this inbox
-- had a trial?" and nothing else; it cannot be turned back into an address,
-- so a deleted player's email is not sitting in this table in readable form.
--
-- A promotion code also marks the trial as used: someone who has already had
-- Sapien through a code has had their taste of it.
CREATE TABLE trial_claims (
  email_key   TEXT PRIMARY KEY,
  claimed_at  INTEGER NOT NULL
);

-- ---------- display names ----------
--
-- A display name is what friends and leaderboards show, so two players may not
-- share one ("Kai" and "kai" count as the same). Enforced in PATCH
-- /api/player/me rather than by a UNIQUE index, because names already stored
-- before this rule existed may collide and must not stop the migration. This
-- index only makes that lookup fast.
CREATE INDEX IF NOT EXISTS users_display_name_nocase ON users (display_name COLLATE NOCASE);
