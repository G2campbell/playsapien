/* Streaks, derived.

   Spec §5 is unambiguous and this file is the whole of the enforcement: never
   increment a counter. Every write that can change a player's play history --
   a result, a claim, a merge, an admin correction -- reads the days back out of
   `results` and recomputes from scratch.

   It costs one indexed query per write (idx_results_user covers it exactly) and
   it buys three things. The merge in spec §2 becomes correct by construction,
   because the union of two devices' days recomputes to the right number without
   anyone reasoning about which side was ahead. Out-of-order arrival stops
   mattering: a result for yesterday landing after one for today produces the
   same answer as the other order. And no bug can permanently corrupt the number
   a player is proudest of, because the number is not stored anywhere that a bug
   can reach -- it is recomputed from rows that only ever get appended.

   Only mode='daily' counts. A practice run is a rehearsal (spec-v3 §1 on Word
   Chain's practice times), and letting it hold a streak up would make the
   streak mean nothing. */

import { stmt } from './db.js';
import { dayNumber, shiftDay } from './validate.js';

/* '*' is the platform streak: played *something* that day. It is stored in the
   same table with game='*', which is why `game` is part of the primary key
   rather than a foreign key to a games table. */
export const PLATFORM = '*';

/* Walk a sorted, de-duplicated list of day strings.

   `current` is only non-zero if the last played day is today or yesterday. The
   yesterday grace is not generosity, it is the same midnight problem the day
   validator has: a player in UTC-8 who plays at 6pm has not yet reached the new
   UTC day, and their streak should not read zero for eight hours every evening. */
export function walk(days, today) {
  if (!days.length) return { current: 0, longest: 0, last_day: null };

  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    run = dayNumber(days[i]) - dayNumber(days[i - 1]) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const last = days[days.length - 1];
  let current = 0;
  if (last === today || last === shiftDay(today, -1)) {
    current = 1;
    for (let i = days.length - 1; i > 0; i--) {
      if (dayNumber(days[i]) - dayNumber(days[i - 1]) !== 1) break;
      current++;
    }
  }
  return { current, longest, last_day: last };
}

/* Read every daily result for a user and return the upsert statements for their
   per-game streaks and their platform streak.

   The reads happen here and the writes are handed back unexecuted so that a
   caller who needs atomicity -- the claim/merge, which re-parents rows and
   recomputes in one breath -- can put them in the same db.batch() as the rows
   that changed. Callers who do not need that just batch the returned array on
   its own. */
export async function streakStatements(db, userId, today) {
  const rows = (await db.prepare(
    `SELECT game, day, score FROM results
      WHERE user_id = ? AND mode = 'daily'
      ORDER BY day ASC`
  ).bind(userId).all()).results || [];

  /* One bucket per game plus the platform bucket. A day counts once towards the
     platform streak however many games were played on it, but total_score sums
     everything -- the streak is about showing up, the score is about how much. */
  const byGame = new Map();
  const platformDays = [];
  let platformScore = 0;

  for (const r of rows) {
    let g = byGame.get(r.game);
    if (!g) byGame.set(r.game, (g = { days: [], score: 0 }));
    /* The (user, game, day, mode) unique index means a day cannot repeat within
       a game, so no de-duplication is needed here -- but it can repeat across
       games, which is what the platform check below is for. */
    g.days.push(r.day);
    g.score += r.score;
    if (platformDays[platformDays.length - 1] !== r.day) platformDays.push(r.day);
    platformScore += r.score;
  }

  /* The query orders by day, not by (game, day), so a game's days arrive in
     order relative to each other but interleaved with other games'. That is
     fine for the per-game buckets, which stay sorted, and for platformDays,
     where the interleaving is exactly what makes the adjacent-duplicate check
     above sufficient. */

  const out = [];
  const write = (game, days, totalScore) => {
    const { current, longest, last_day } = walk(days, today);
    out.push(stmt(db,
      `INSERT INTO streaks (user_id, game, current, longest, last_day, played, total_score)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game) DO UPDATE SET
         current = excluded.current, longest = excluded.longest,
         last_day = excluded.last_day, played = excluded.played,
         total_score = excluded.total_score`,
      userId, game, current, longest, last_day, days.length, totalScore));
  };

  for (const [game, g] of byGame) write(game, g.days, g.score);
  write(PLATFORM, platformDays, platformScore);

  /* A game the player has stopped playing keeps its row, correctly recomputed
     to current = 0 the next time any result lands, because byGame is built from
     every row they have rather than from the game just written. A game they
     have never played has no row at all, and readers treat a missing row as
     zeroes. */
  return out;
}

/* The convenience wrapper, for the callers that do not need to combine. */
export async function recomputeStreaks(db, userId, today) {
  const writes = await streakStatements(db, userId, today);
  if (writes.length) await db.batch(writes);
}

export function emptyStreak(game) {
  return { game, current: 0, longest: 0, last_day: null, played: 0, total_score: 0 };
}
