-- PlaySapien 0012: timed friend challenges for Word Chain.
--
-- Two players are given the SAME chain and each plays it on their own time, on the ordinary
-- timed board. The faster time wins. Nobody sees the other's time until both have finished.
-- (The 1v1 turn-taking game is 0011; this one has no turns.)
--
--   a_id        the player who was challenged. b_id the challenger (challenger_id says which).
--               NULL for the one INVITED by an address with no account yet; the keyed hash of
--               that address (invite_key) is kept until they join, exactly as for 1v1.
--   state       'invited'   waiting for the friend request to be accepted
--               'active'    being played; either or both may still have to finish
--               'done'      both finished; result says who was faster
--               'cancelled' withdrawn, declined, un-friended, blocked or gone quiet; no result
--   *_started   the moment (Unix seconds) each side first opened the chain. Set once, by the
--               server, and the same on every later open: it is what stops a claimed time
--               being longer than the time that could have passed (lib/timed.js).
--   *_ms        each side's final time in milliseconds, penalty for Lifelines included, worked
--               out by the server from how the chain was solved.
--   *_moves     what was sent, kept so it can be checked again.
--   result      'a' | 'b' | 'draw'. Two times that read the same to the second are a draw.
CREATE TABLE timed (
  id            TEXT PRIMARY KEY,
  a_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  b_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenger_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_key    TEXT,
  invite_label  TEXT,                         -- masked, for the challenger's own list only
  chain_words   TEXT NOT NULL,                -- JSON array
  chain_links   TEXT NOT NULL,                -- JSON array of { numberStrict }
  chain_ref     TEXT NOT NULL,                -- 'bank:<id>', so a chain is not dealt twice
  state         TEXT NOT NULL,
  a_started     INTEGER,
  b_started     INTEGER,
  a_ms          INTEGER,
  b_ms          INTEGER,
  a_moves       TEXT,
  b_moves       TEXT,
  result        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX timed_a ON timed (a_id, state);
CREATE INDEX timed_b ON timed (b_id, state);
CREATE INDEX timed_invite ON timed (invite_key) WHERE invite_key IS NOT NULL;
