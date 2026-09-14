/* Play: submitting a result, reading a day, and the friends-only leaderboards.

   Spec §5 is the thing to read alongside this file. The short version: scores
   are client-reported and that is a decision, not an oversight. A web game
   cannot stop a determined player posting a perfect score because the logic is
   in their browser. What is controlled is the blast radius -- leaderboards are
   friends-only, so a cheater fools people who know them, which is self-limiting
   in a way a global board is not.

   What the server does enforce is everything it can check cheaply:

     - day is today or yesterday, UTC
     - score is within 0..max_score
     - max_score is the game's declared maximum, not whatever the client claims
     - duration_ms is plausible
     - first write wins

   and it stores `detail` whole, so that if a global leaderboard ever matters,
   replay validation can be added retroactively against data already collected. */

import { ok, err, ERRORS, readJson, conflict } from '../lib/http.js';
import { first, all, run, isUniqueViolation } from '../lib/db.js';
import { newId } from '../lib/id.js';
import {
  asObject, isDay, isDeviceId, isSubmittableDay, shiftDay, utcDay,
  MAX_SCORE, MODES, MAX_DURATION_MS, MAX_DETAIL_BYTES,
} from '../lib/validate.js';
import { streakStatements } from '../lib/streaks.js';
import { acceptedFriendIds } from './friends.js';

/* POST /api/play/result */
export async function submitResult(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send a JSON result.');
  return await recordResult(ctx, asObject(body.value));
}

/* POST /api/sojourner/score -- the legacy alias.

   partD.js:341 already posts to `SOJOURNER_API + '/score'` with a body shaped
   { day, total, rounds }, and that hook predates this API. Keeping the alias
   means the existing game works by setting one constant, with no change to the
   game itself (spec §4). The translation is here rather than in the game
   because the game is the thing that is already shipped. */
export async function sojournerScore(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send a JSON result.');
  const raw = asObject(body.value);
  return await recordResult(ctx, {
    game: 'sojourner',
    day: raw.day,
    mode: raw.mode || 'daily',
    score: raw.total,
    max_score: MAX_SCORE.sojourner,
    detail: raw.rounds ? { rounds: raw.rounds } : null,
    duration_ms: raw.duration_ms,
    device_id: raw.device_id,
  });
}

async function recordResult(ctx, input) {
  const game = String(input.game || '');
  if (!Object.prototype.hasOwnProperty.call(MAX_SCORE, game)) {
    return err('unknown_game', 'That is not a game on this platform.', 400);
  }
  const max = MAX_SCORE[game];

  const day = String(input.day || '');
  if (!isDay(day)) return err('bad_day', 'day must be YYYY-MM-DD.', 400);
  if (!isSubmittableDay(day, ctx.now)) {
    /* Today or yesterday only. The grace covers someone who started at 23:50
       and finished at 00:05; anything older is a stale clock or a backfill, and
       a backfilled day would put a hole in a streak back together, which is the
       one number here that is supposed to be hard to get. */
    return err('stale_day',
      'Results can only be recorded for today or yesterday (UTC).', 400,
      { headers: { 'x-server-day': utcDay(ctx.now) } });
  }

  const mode = String(input.mode || 'daily');
  if (!MODES.includes(mode)) return err('bad_mode', 'mode must be daily or practice.', 400);

  const score = input.score;
  if (!Number.isInteger(score) || score < 0 || score > max) {
    return err('bad_score', 'score must be a whole number from 0 to ' + max + '.', 400);
  }

  /* The declared maximum has to match, and a mismatch is refused rather than
     corrected. A client sending the wrong maximum is running different scoring
     rules from this server, and a row whose score cannot be interpreted against
     a known scale is worse than no row. */
  if (input.max_score !== undefined && input.max_score !== null && input.max_score !== max) {
    return err('bad_max_score',
      'max_score for ' + game + ' is ' + max + '.', 400);
  }

  let durationMs = null;
  if (input.duration_ms !== undefined && input.duration_ms !== null) {
    const d = Number(input.duration_ms);
    if (!Number.isFinite(d) || d < 0 || d > MAX_DURATION_MS) {
      return err('bad_duration', 'duration_ms is not plausible.', 400);
    }
    durationMs = Math.round(d);
  }

  let detail = null;
  if (input.detail !== undefined && input.detail !== null) {
    detail = typeof input.detail === 'string' ? input.detail : JSON.stringify(input.detail);
    if (detail.length > MAX_DETAIL_BYTES) {
      return err('detail_too_large', 'That result detail is too big.', 400);
    }
  }

  /* Who this belongs to. A signed-in player always files under their user id,
     even when the client also sends a device id -- the account is authoritative
     once it exists (spec §2). An anonymous player files under their device, so
     that the history is there to be claimed the day they do sign up. */
  const userId = ctx.user ? ctx.user.id : null;
  const deviceId = isDeviceId(input.device_id) ? input.device_id : null;
  if (!userId && !deviceId) {
    return err('no_identity',
      'Send a device_id, or sign in, so the result has somewhere to live.', 400);
  }

  /* First write wins. The check is done twice on purpose: once here, because
     the common case deserves a clear 409 carrying the row that won, and once by
     the unique index below, because two tabs finishing at the same instant will
     race past this read. Neither alone is enough. */
  const existing = await findExisting(ctx.db, { userId, deviceId, game, day, mode });
  if (existing) return duplicate(existing);

  /* The device row has to exist before a result can reference it. Created on
     first sight rather than by a separate endpoint: the client mints the id, so
     there is nothing to negotiate and a round trip to register it would be one
     more thing to fail on a bad connection. */
  if (deviceId) {
    await run(ctx.db,
      `INSERT INTO devices (id, user_id, created_at, claimed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id    = COALESCE(devices.user_id, excluded.user_id),
         claimed_at = COALESCE(devices.claimed_at, excluded.claimed_at)`,
      deviceId, userId, ctx.now, userId ? ctx.now : null);
  }

  const id = newId('r');
  try {
    await run(ctx.db,
      `INSERT INTO results (id, user_id, device_id, game, day, mode, score, max_score,
                            detail, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, userId, deviceId, game, day, mode, score, max, detail, durationMs, ctx.now);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await findExisting(ctx.db, { userId, deviceId, game, day, mode });
      if (winner) return duplicate(winner);
    }
    throw e;
  }

  /* Derived, never incremented. Recomputed from results on every write, so an
     out-of-order arrival, a merge and a plain sequential day all produce the
     same number. Practice rows do not count, which streakStatements enforces. */
  let streaks = null;
  if (userId && mode === 'daily') {
    const writes = await streakStatements(ctx.db, userId, utcDay(ctx.now));
    if (writes.length) await ctx.db.batch(writes);
    streaks = await all(ctx.db,
      'SELECT game, current, longest, last_day, played, total_score FROM streaks WHERE user_id = ?',
      userId);
  }

  return ok({ result: { id, game, day, mode, score, max_score: max }, streaks }, { status: 201 });
}

function duplicate(row) {
  /* The 409 carries the row that won. "First write wins" is only usable as a
     rule if the loser is told what it lost to -- the client has to reconcile
     its localStorage, and making it issue a second request to find out would
     mean a failed sync leaves the two copies disagreeing. */
  return conflict('already_recorded',
    'Today is already recorded. The first result stands.',
    { result: publicResult(row) });
}

function findExisting(db, { userId, deviceId, game, day, mode }) {
  if (userId) {
    return first(db,
      `SELECT id, game, day, mode, score, max_score, detail, duration_ms, created_at
         FROM results WHERE user_id = ? AND game = ? AND day = ? AND mode = ?`,
      userId, game, day, mode);
  }
  return first(db,
    `SELECT id, game, day, mode, score, max_score, detail, duration_ms, created_at
       FROM results WHERE device_id = ? AND game = ? AND day = ? AND mode = ?`,
    deviceId, game, day, mode);
}

function publicResult(r) {
  return {
    id: r.id,
    game: r.game,
    day: r.day,
    mode: r.mode,
    score: r.score,
    max_score: r.max_score,
    duration_ms: r.duration_ms,
    detail: parseDetail(r.detail),
    created_at: r.created_at,
  };
}

function parseDetail(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/* GET /api/play/day/:day -> your results, both games

   Works signed out, via ?device_id=, because an anonymous player's history is
   still their history and the shell shows it. */
export async function readDay(ctx) {
  const day = ctx.params.day;
  if (!isDay(day)) return err('bad_day', 'day must be YYYY-MM-DD.', 400);

  const deviceId = ctx.url.searchParams.get('device_id');
  let rows;
  if (ctx.user) {
    rows = await all(ctx.db,
      `SELECT id, game, day, mode, score, max_score, detail, duration_ms, created_at
         FROM results WHERE user_id = ? AND day = ?`, ctx.user.id, day);
  } else if (isDeviceId(deviceId)) {
    rows = await all(ctx.db,
      `SELECT id, game, day, mode, score, max_score, detail, duration_ms, created_at
         FROM results WHERE device_id = ? AND user_id IS NULL AND day = ?`, deviceId, day);
  } else {
    return ERRORS.unauthorised();
  }

  return ok({ day, results: rows.map(publicResult) });
}

/* GET /api/play/leaderboard/:game/:day -> you + friends, that day

   Friends-only, and the list is built from accepted friendships rather than
   filtered after the fact, so there is no query shape in which a stranger's row
   can appear. A pending request is not a friendship and does not count. */
export async function leaderboard(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const { game, day } = ctx.params;
  if (!Object.prototype.hasOwnProperty.call(MAX_SCORE, game)) {
    return err('unknown_game', 'That is not a game on this platform.', 400);
  }
  if (!isDay(day)) return err('bad_day', 'day must be YYYY-MM-DD.', 400);

  const ids = await acceptedFriendIds(ctx.db, ctx.user.id);
  ids.push(ctx.user.id);

  const ph = ids.map(() => '?').join(',');
  const rows = await all(ctx.db,
    `SELECT r.user_id, r.score, r.max_score, r.duration_ms, r.created_at,
            u.handle, u.display_name, u.avatar
       FROM results r JOIN users u ON u.id = r.user_id
      WHERE r.game = ? AND r.day = ? AND r.mode = 'daily'
        AND u.deleted_at IS NULL AND r.user_id IN (${ph})
      ORDER BY r.score DESC, r.duration_ms ASC, r.created_at ASC`,
    game, day, ...ids);

  return ok({
    game,
    day,
    entries: rows.map((r, i) => ({
      rank: i + 1,
      user_id: r.user_id,
      you: r.user_id === ctx.user.id,
      handle: r.handle,
      display_name: r.display_name || '',
      avatar: r.avatar,
      score: r.score,
      max_score: r.max_score,
      duration_ms: r.duration_ms,
    })),
  });
}

/* GET /api/play/standings -> friends, rolling 30 days

   The table the shell shows when nobody has played today yet. Thirty days is
   long enough to be a season and short enough that somebody who started last
   week is not permanently behind. */
export async function standings(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();

  const today = utcDay(ctx.now);
  const from = shiftDay(today, -29);

  const ids = await acceptedFriendIds(ctx.db, ctx.user.id);
  ids.push(ctx.user.id);
  const ph = ids.map(() => '?').join(',');

  const rows = await all(ctx.db,
    `SELECT r.user_id, r.game,
            COUNT(*) AS played,
            SUM(r.score) AS total_score,
            COUNT(DISTINCT r.day) AS days
       FROM results r JOIN users u ON u.id = r.user_id
      WHERE r.mode = 'daily' AND r.day >= ? AND r.day <= ?
        AND u.deleted_at IS NULL AND r.user_id IN (${ph})
      GROUP BY r.user_id, r.game`, from, today, ...ids);

  const people = await all(ctx.db,
    `SELECT id, handle, display_name, avatar FROM users WHERE id IN (${ph})`, ...ids);
  const profile = new Map(people.map((p) => [p.id, p]));

  const byUser = new Map();
  for (const r of rows) {
    let u = byUser.get(r.user_id);
    if (!u) {
      const p = profile.get(r.user_id) || {};
      byUser.set(r.user_id, (u = {
        user_id: r.user_id,
        you: r.user_id === ctx.user.id,
        handle: p.handle || null,
        display_name: p.display_name || '',
        avatar: p.avatar || null,
        days: 0,
        total_score: 0,
        games: {},
      }));
    }
    u.games[r.game] = { played: r.played, total_score: r.total_score };
    u.total_score += r.total_score;
  }

  /* `days` is counted across the whole window per player, not summed per game:
     playing both games on one day is one day of showing up, which is what the
     platform streak means too. */
  const dayRows = await all(ctx.db,
    `SELECT user_id, COUNT(DISTINCT day) AS days FROM results
      WHERE mode = 'daily' AND day >= ? AND day <= ? AND user_id IN (${ph})
      GROUP BY user_id`, from, today, ...ids);
  for (const d of dayRows) {
    const u = byUser.get(d.user_id);
    if (u) u.days = d.days;
  }

  const entries = [...byUser.values()].sort((x, y) =>
    y.days - x.days || y.total_score - x.total_score);

  return ok({ from, to: today, entries });
}
