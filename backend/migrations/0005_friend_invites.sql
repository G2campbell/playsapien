-- PlaySapien 0005: inviting friends by email, a queue of invites you can come
-- back to, rejecting and blocking, and the limits that keep it from being used
-- to pester anyone.
--
-- ---------- friendships: "later" and who blocked ----------
--
-- later_at     the recipient chose "Later" on a pending invite. It stays in
--              their queue, sorted below the new ones.
-- blocked_by   who did the blocking, when state = 'blocked'. With it, the
--              blocker -- and only the blocker -- can see the block and undo
--              it. Rows blocked before this column existed have NULL here and
--              stay blocked for both sides (undoing one is an admin action).
ALTER TABLE friendships ADD COLUMN later_at INTEGER;
ALTER TABLE friendships ADD COLUMN blocked_by TEXT;

-- ---------- rejections ----------
--
-- Rejecting an invite deletes it (it is gone from both sides) and leaves one
-- line here. Several rejections in a short time pause the SENDER's invites
-- (routes/friends.js, pausedUntil): the safeguard against someone inviting
-- strangers. Deleted with either account.
CREATE TABLE friend_rejections (
  sender_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL
);
CREATE INDEX friend_rejections_sender ON friend_rejections (sender_id, at);

-- ---------- invites to an address with no account ----------
--
-- When someone invites an email address that no player uses, the invite is
-- kept here -- as a keyed hash of the address, never the address itself -- so
-- that if that person later joins with that address, the invite is waiting as
-- a friend request. An invitation EMAIL goes out at most once per address per
-- 30 days, whoever is inviting (emailed_at). Rows go when the person joins,
-- when the inviter deletes their account, or after 90 days (nightly job).
CREATE TABLE email_invites (
  email_key   TEXT NOT NULL,
  inviter_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  emailed_at  INTEGER,
  PRIMARY KEY (email_key, inviter_id)
);
CREATE INDEX email_invites_sent ON email_invites (email_key, emailed_at);

-- An address that asked, from the link in an invitation email, not to be sent
-- invitations again. Keyed hash only.
CREATE TABLE email_optouts (
  email_key  TEXT PRIMARY KEY,
  at         INTEGER NOT NULL
);
