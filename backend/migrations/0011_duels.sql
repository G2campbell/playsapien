-- PlaySapien 0011: 1v1 Word Chain challenges.
--
-- Two players race to solve the same chain, taking turns (lib/duel.js has the rules).
-- The chain's words live here and are never sent to a player before they have solved
-- them: the server judges every guess.
--
--   a_id        the player who moves FIRST each round. For a challenge this is the player
--               who was challenged (they get the first turn); b_id moves second.
--   challenger_id  who sent it. One of a_id / b_id is the challenger.
--   a_id/b_id   NULL for the one that was INVITED by an address that has no account yet.
--               The invite key (a keyed hash of that address, as email_invites does) is kept
--               until that person joins and the row is attached to them.
--   state       'invited'   waiting for the friend request to be accepted, nobody can move
--               'active'    being played
--               'done'      finished; result says how
--               'cancelled' withdrawn, declined, un-friended, blocked or gone quiet; no result
--   mover       'a' or 'b': whose turn it is.  round: 1-based, both players take one per round.
--   *_pos       the index of the word each player is on (1 = the first one to find);
--               they have solved everything once pos reaches the word count.
--   *_hints     Lifelines used on the CURRENT word.
--   *_fin       the round in which each finished the chain, if they have.
--   version     bumped on every move, so two taps at once cannot both count.
CREATE TABLE duels (
  id            TEXT PRIMARY KEY,
  a_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  b_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenger_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_key    TEXT,
  invite_label  TEXT,                         -- masked, for the challenger's own list only
  chain_words   TEXT NOT NULL,                -- JSON array
  chain_links   TEXT NOT NULL,                -- JSON array of { numberStrict }
  chain_ref     TEXT NOT NULL,                -- 'bank:<id>' or 'mine', so a chain is not dealt twice
  state         TEXT NOT NULL,
  round         INTEGER NOT NULL DEFAULT 1,
  mover         TEXT NOT NULL DEFAULT 'a',
  a_pos         INTEGER NOT NULL DEFAULT 1,
  b_pos         INTEGER NOT NULL DEFAULT 1,
  a_hints       INTEGER NOT NULL DEFAULT 0,
  b_hints       INTEGER NOT NULL DEFAULT 0,
  a_fin         INTEGER,
  b_fin         INTEGER,
  result        TEXT,                         -- 'a' | 'b' | 'draw'
  version       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX duels_a ON duels (a_id, state);
CREATE INDEX duels_b ON duels (b_id, state);
CREATE INDEX duels_invite ON duels (invite_key) WHERE invite_key IS NOT NULL;

-- What each side did that changed the game: a correct word, a wrong guess (which ends the
-- turn) or a Lifeline. Guesses that were not attempts are not kept. The wrong guesses on
-- the word a player is on are what stop the same one being counted twice.
CREATE TABLE duel_guesses (
  duel_id    TEXT NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  side       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  word_index INTEGER NOT NULL,
  guess      TEXT NOT NULL,
  outcome    TEXT NOT NULL,                   -- 'correct' | 'wrong' | 'hint'
  at         INTEGER NOT NULL,
  PRIMARY KEY (duel_id, side, seq)
);
