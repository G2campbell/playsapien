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

   One game's card (game=sojourner) reports that game's raw score. The front
   door's card (game=all) puts every result on one scale first -- score as a
   percentage of that result's maximum -- so Sojourner's 1000 and Word Chain's
   7 can be averaged together.

   Rank and "beat" compare the measure in basis points of the maximum (0..10000),
   rounded once in SQL, so a tie is a tie rather than a floating-point accident.
   The counting is done in SQL as well: "all players" never loads every player's
   row into the Worker.

   Nothing here trusts the client. Scores are the client-reported ones from
   routes/play.js, so what this ranks is as honest as that is (option D, which
   would verify them, is not built). */

import { ok, err, ERRORS } from '../lib/http.js';
import { first, all } from '../lib/db.js';
import { MAX_SCORE, GAMES, utcDay } from '../lib/validate.js';
import { groupsFor } from './groups.js';

export const DOZEN = 12;
export const LIFETIME_FROM = 13;

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

/* The rows (user_id, m, n) of one measure: m is the player's measure in basis
   points of the maximum, n is how many results it is made from. A player
   without enough results for the horizon has no row. */
function measureSql(kind, game, day, scope, me, groupId) {
  const params = [];
  let where = `r.mode = 'daily' AND r.verified = 1 AND r.user_id IS NOT NULL AND u.deleted_at IS NULL`;
  if (game !== 'all') { where += ' AND r.game = ?'; params.push(game); }
  if (kind === 'daily') { where += ' AND r.day = ?'; params.push(day); }
  const sc = scopeClause(scope, me, groupId);
  where += sc.sql; params.push(...sc.params);

  const ratio = '1.0 * r.score / r.max_score';
  const from = `FROM results r JOIN users u ON u.id = r.user_id WHERE ${where}`;
  const basis = (col) => `CAST(ROUND(AVG(${col}) * 10000) AS INTEGER)`;

  if (kind === 'dozen') {
    return {
      params,
      sql: `SELECT user_id, ${basis('p')} AS m, COUNT(*) AS n FROM (
              SELECT r.user_id AS user_id, ${ratio} AS p,
                     ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.day DESC, r.game) AS rn
              ${from})
             WHERE rn <= ${DOZEN} GROUP BY user_id HAVING COUNT(*) >= ${DOZEN}`,
    };
  }
  const having = kind === 'lifetime' ? ` HAVING COUNT(*) >= ${LIFETIME_FROM}` : '';
  return {
    params,
    sql: `SELECT r.user_id AS user_id, ${basis(ratio)} AS m, COUNT(*) AS n
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
  return {
    rank: above + 1,
    of,
    /* The share of everyone else this player is ahead of. Equal scores are
       neither ahead nor behind. Null when there is nobody else to compare. */
    beat: of > 1 ? Math.round((100 * below) / (of - 1)) : null,
  };
}

/* The value the card shows: the raw score for one game, a percentage for all. */
function shown(m, game) {
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
    const total = (await first(ctx.db,
      `SELECT COUNT(*) AS n FROM results r
        WHERE r.user_id = ? AND r.mode = 'daily' AND r.verified = 1${game === 'all' ? '' : ' AND r.game = ?'}`,
      ...(game === 'all' ? [me] : [me, game]))).n;
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
    plan: sapien ? 'sapien' : 'free',
    group: group ? { id: group.id, name: group.name } : null,
    daily,
    /* Free accounts keep every result but are shown only Daily. The server
       holds that line itself; the card's own lock is only the polite version. */
    dozen: sapien ? await horizon('dozen') : { locked: true },
    lifetime: sapien ? await horizon('lifetime') : { locked: true },
  });
}
