-- PlaySapien 0008: verified results (option D, "send moves, server recomputes").
--
-- A game that sends its moves has them replayed by the server, which works out
-- the score itself; that result is `verified`, and `moves` keeps what was sent
-- so it can be replayed again if the scoring rules are ever corrected.
-- A result the client merely reported stays unverified: it still counts for the
-- player's own record and streak, but never in anybody else's ranking.
-- Every row that exists today was reported by a client, so it starts at 0.
ALTER TABLE results ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE results ADD COLUMN moves    TEXT;

-- Rankings read only verified rows, by game and day.
CREATE INDEX idx_results_verified ON results (game, day) WHERE verified = 1;
