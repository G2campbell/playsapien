/* Analytics: a player's own scores, and where they stand.

   GET /api/player/analytics?game=<sojourner|wordchain|all>&group=<group id>

   Three horizons, from verified daily results only (practice never counts, and
   neither does a score a game merely reported -- see routes/play.js):

     daily     today's result
     dozen     the mean of the last 12 results   (Sapien; once there are 12)
     lifetime  the mean of every result          (Sapien; once there are 13)

   Each is compared with everyone else who has the same measure -- all players,
   all of the player's accepted friends and, when a group is asked for, that
   group (the player's own private list; routes/groups.js). A comparison is a
   rank ("3rd of 8") and the share of the others the player beats.

   Two kinds of game, two measures:
     - a game with POINTS (Sojourner): the measure is the score as a share of its
       maximum, and higher is better. One game's card shows its raw score.
     - a game ranked on TIME (Word Chain): the measure is the time in
       milliseconds, and LOWER is better. Its card shows times, as m:ss.
   The front door's card (game=all) averages the points games together as a share
   of each maximum. Times are not points, so Word Chain is not in that average
   until the Intellisense categories say how the games combine; it has its own card.

   Rank and "beat" compare the measure rounded once in SQL (basis points of the
   maximum, or whole milliseconds), so a tie is a tie rather than a
   floating-point accident. The counting is done in SQL as well: "all players"
   never loads every player's row into the Worker.

   Nothing here trusts the client: every row it reads was replayed by the server
   (routes/play.js), and a time is the server's own, from its stamps. */

import { ok, err, ERRORS } from '../lib/http.js';
import { first } from '../lib/db.js';
import { MAX_SCORE, GAMES, utcDay } from '../lib/validate.js';
import { groupsFor } from './groups.js';
import { recordFor } from './duels.js';

export const DOZEN = 12;
export const LIFETIME_FROM = 13;

/* Games ranked on time, lowest first. Every other game is points, highest first. */
const TIME_GAMES = ['wordchain'];
const POINT_GAMES = GAMES.filter((g) => !TIME_GAMES.includes(g));
const isTime = (game) => TIME_GAMES.includes(game);

/* Which players a measure is ranked among. Friends and groups are matched by
   subquery, not by a list of ids: D1 allows only 100 bound values in a query. */
function scopeClause(scope, me, groupId) {
  if (scope === 'friends') {
    return {
      sql: ` AND (r.user_id = ? OR r.user_id IN (
               SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END FROM friendships
                WHERE state = 'accepted' AND (a_id = ? OR b_id = ?)))`,
      params: [me, me, me, me],
    };
  }
  if (scope === 'group') {
    return {
      sql: ` AND (r.user_id = ? OR r.user_id IN (
               SELECT member_id FROM friend_group_members WHERE group_id = ?))`,
      params: [me, groupId],
    };
  }
  if (scope === 'me') return { sql: ' AND r.user_id = ?', params: [me] };
  return { sql: '', params: [] };                        // every player
}

/* Which games a card is about. */
function gameClause(game) {
  if (game === 'all') {
    return { sql: ` AND r.game IN (${POINT_GAMES.map(() => '?').join(',')})`, params: POINT_GAMES.slice() };
  }
  return { sql: ' AND r.game = ?', params: [game] };
}

/* The rows (user_id, m, n) of one measure: m is the player's measure and n is
   how many results it is made from. A player without enough results for the
   horizon has no row. */
function measureSql(kind, game, day, scope, me, groupId) {
  const gc = gameClause(game);
  const params = [...gc.params];
  let where = `r.mode = 'daily' AND r.verified = 1 AND r.user_id IS NOT NULL AND u.deleted_at IS NULL` + gc.sql;
  if (kind === 'daily') { where += ' AND r.day = ?'; params.push(day); }
  const sc = scopeClause(scope, me, groupId);
  where += sc.sql; params.push(...sc.params);

  /* Time: whole milliseconds. Points: basis points of the row's own maximum. */
  const time = isTime(game);
  if (time) where += ' AND r.duration_ms IS NOT NULL';
  const value = time ? 'r.duration_ms' : '1.0 * r.score / r.max_score';
  const basis = (col) => time
    ? `CAST(ROUND(AVG(${col})) AS INTEGER)`
    : `CAST(ROUND(AVG(${col}) * 10000) AS INTEGER)`;
  const from = `FROM results r JOIN users u ON u.id = r.user_id WHERE ${where}`;

  if (kind === 'dozen') {
    return {
      params,
      sql: `SELECT user_id, ${basis('p')} AS m, COUNT(*) AS n FROM (
              SELECT r.user_id AS user_id, ${value} AS p,
                     ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.day DESC, r.game) AS rn
              ${from})
             WHERE rn <= ${DOZEN} GROUP BY user_id HAVING COUNT(*) >= ${DOZEN}`,
    };
  }
  const having = kind === 'lifetime' ? ` HAVING COUNT(*) >= ${LIFETIME_FROM}` : '';
  return {
    params,
    sql: `SELECT r.user_id AS user_id, ${basis(value)} AS m, COUNT(*) AS n
          ${from} GROUP BY r.user_id${having}`,
  };
}

/* The player's own measure for a horizon, or null when they have none yet. */
async function mine(db, kind, game, day, me) {
  const q = measureSql(kind, game, day, 'me', me, null);
  return first(db, q.sql, ...q.params);
}

/* Where that measure puts the player among a scope. */
async function compare(db, kind, game, day, scope, me, groupId, m) {
  const q = measureSql(kind, game, day, scope, me, groupId);
  const row = await first(db,
    `SELECT COUNT(*) AS n, SUM(m > ?) AS above, SUM(m < ?) AS below FROM (${q.sql})`,
    m, m, ...q.params);
  const of = (row && row.n) || 0;
  const above = (row && row.above) || 0, below = (row && row.below) || 0;
  /* Higher is better for points, lower for time: flip which side is "ahead". */
  const ahead = isTime(game) ? below : above;
  const behind = isTime(game) ? above : below;
  return {
    rank: ahead + 1,
    of,
    /* The share of everyone else this player is ahead of. Equal scores are
       neither ahead nor behind. Null when there is nobody else to compare. */
    beat: of > 1 ? Math.round((100 * behind) / (of - 1)) : null,
  };
}

/* The value the card shows: seconds for a time, the raw score for one points game,
   a percentage for all of them together. */
function shown(m, game) {
  if (isTime(game)) return { value: Math.round(m / 100) / 10, unit: 'time' };
  if (game === 'all') return { value: Math.round(m) / 100, max: 100 };
  return { value: Math.round((m * MAX_SCORE[game]) / 100) / 100, max: MAX_SCORE[game] };
}

export async function analytics(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const me = ctx.user.id;
  const sapien = ctx.user.plan === 'sapien';

  const game = ctx.url.searchParams.get('game') || 'all';
  if (game !== 'all' && !GAMES.includes(game)) {
    return err('unknown_game', 'That is not a game on this platform.', 400);
  }

  /* A group is the player's own, or it is not found. */
  const groupId = ctx.url.searchParams.get('group') || '';
  let group = null;
  if (groupId) {
    group = (await groupsFor(ctx.db, me)).find((g) => g.id === groupId) || null;
    if (!group) return err('no_group', 'That friend group was not found.', 404);
  }

  const day = utcDay(ctx.now);
  const scopes = ['all', 'friends'].concat(group ? ['group'] : []);

  async function horizon(kind) {
    const have = await mine(ctx.db, kind, game, day, me);
    const gc = gameClause(game);
    const total = (await first(ctx.db,
      `SELECT COUNT(*) AS n FROM results r
        WHERE r.user_id = ? AND r.mode = 'daily' AND r.verified = 1${gc.sql}`,
      me, ...gc.params)).n;
    const out = { games: total, you: null, compare: {} };
    if (kind === 'dozen') out.needed = DOZEN;
    if (kind === 'lifetime') out.needed = LIFETIME_FROM;
    if (!have) return out;
    out.you = shown(have.m, game);
    for (const scope of scopes) {
      out.compare[scope] = await compare(ctx.db, kind, game, day, scope, me, groupId, have.m);
    }
    return out;
  }

  const daily = await horizon('daily');
  /* Today's rank can still move until midnight UTC; the card says so. */
  daily.provisional = true;

  return ok({
    game,
    day,
    /* Word Chain's card also carries the 1v1 record: wins, draws and losses against each friend. */
    record: game === 'wordchain' ? await recordFor(ctx.db, me) : undefined,
    plan: sapien ? 'sapien' : 'free',
    group: group ? { id: group.id, name: group.name } : null,
    daily,
    /* Free accounts keep every result but are shown only Daily. The server holds
       that line itself; the card's own lock is only the polite version. */
    dozen: sapien ? await horizon('dozen') : { locked: true },
    lifetime: sapien ? await horizon('lifetime') : { locked: true },
  });
}
