-- PlaySapien 0003: when a Sapien plan ends, and promotion codes that grant one.
--
-- ---------- plan_until ----------
--
-- The moment Sapien access ends, in Unix seconds, UTC. NULL means "does not
-- end" -- free accounts, and any Sapien grant made without an end date. It is
-- the entitlement's own end, not the billing period's: when billing exists the
-- payment provider's webhook moves this forward on every renewal, and nothing
-- else in the codebase needs to learn that billing exists.
--
-- Read-time is authoritative. A row with plan = 'sapien' and a plan_until in
-- the past is treated as free the instant it passes (effectivePlan, in
-- lib/plan.js) -- there is no window between expiry and the nightly job in
-- which an expired player keeps access. The nightly job only tidies the rows
-- up afterwards, so the stored value eventually says what is already true.
ALTER TABLE users ADD COLUMN plan_until INTEGER;

-- ---------- promotion codes ----------
--
-- A code grants Sapien up to a fixed date. Not "N days from redeeming": a
-- trial that ends on the same day for everyone is one that can be announced,
-- and one whose end can be planned around.
--
--   code        stored normalised: upper case, no spaces. What a player types
--               is normalised the same way before the lookup, so case and
--               stray spaces never matter.
--   grants_until the plan_until this code sets.
--   redeem_until last moment it can be redeemed; NULL = until grants_until.
--   max_uses    NULL = unlimited.
--   uses        how many times it HAS been redeemed.
--   active      0 switches a code off without deleting its history.
CREATE TABLE promo_codes (
  code          TEXT PRIMARY KEY,
  plan          TEXT NOT NULL DEFAULT 'sapien',
  grants_until  INTEGER NOT NULL,
  redeem_until  INTEGER,
  max_uses      INTEGER,
  uses          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    INTEGER NOT NULL
);

-- One redemption per player per code. The UNIQUE is what enforces it: a
-- double-tap, or two tabs, lose the race at the database rather than in code.
CREATE TABLE promo_redemptions (
  code         TEXT NOT NULL REFERENCES promo_codes(code),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at  INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);

-- The launch trial. Sapien through the whole of 1 November 2026, UTC:
-- grants_until is 2026-11-02T00:00:00Z, the first instant it no longer applies.
-- Visible in this file, and so in the repository -- a promotion code is made to
-- be handed out, so that costs nothing; it is simply not a secret.
INSERT INTO promo_codes (code, plan, grants_until, redeem_until, max_uses, uses, active, note, created_at)
VALUES ('FREETRIAL#11.1', 'sapien', 1793577600, NULL, NULL, 0, 1,
        'Launch trial: Sapien through 1 Nov 2026', 1758240000);
