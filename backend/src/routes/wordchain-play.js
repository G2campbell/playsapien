/* Word Chain, as the game plays it: the day's chain, practice chains, and how much
   practice people get through.

   The game does not carry the bank (lib/wcpools.js says why and how the three pools
   work). It asks for what it needs:

     GET  /api/wordchain/chain/:day        the chain for a day: today's, or a recent past day
     GET  /api/wordchain/practice          a batch of practice chains, to top the device up
     POST /api/wordchain/practice/played   one practice chain finished (the usage count)
     GET  /api/admin/practice-stats        the usage numbers (admin only; routes/admin.js gate)

   Nothing here ever serves a future day, or a chain from the daily-only pool as practice. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { first, all, run } from '../lib/db.js';
import { consume } from '../middleware/ratelimit.js';
import { asObject, isDay, isDeviceId, utcDay, shiftDay } from '../lib/validate.js';
import { chainForDay, shape, practiceBatch, poolStats, BANK_SIZE } from '../lib/wcpools.js';
import Engine from '../../../packages/scoring/wordchain.cjs';

/* How far back a day's chain can be asked for. The game offers a month of past days
   at most; a longer reach would only be a way to walk the whole bank. */
const MAX_DAYS_BACK = 40;
const MAX_BATCH = 30;
const MAX_SEEN = 400;

/* Who is asking, for counting and for limits: the account, else the device. A caller
   with neither is not counted (but is still limited, by address). */
function subjectOf(ctx) {
  if (ctx.user) return 'u:' + ctx.user.id;
  const dev = ctx.req.headers.get('x-ps-device');
  return isDeviceId(dev) ? 'd:' + dev : null;
}

/* GET /api/wordchain/chain/:day -> { day, chain: { id, words, links, author } } */
export async function chain(ctx) {
  const day = ctx.params.day;
  if (!isDay(day)) return err('bad_day', 'day must be YYYY-MM-DD.', 400);
  const today = utcDay(ctx.now);
  /* A future day is not served, to anyone: the schedule is not a thing to read ahead. */
  if (day > today) return ERRORS.notFound('That day has not happened yet.');
  if (day < shiftDay(today, -MAX_DAYS_BACK)) return ERRORS.notFound('That day is too far back.');

  const key = subjectOf(ctx) || 'ip:' + (ctx.ip || 'unknown');
  const lim = await consume(ctx.db, 'wc_chain', key, ctx.now);
  if (!lim.allowed) return ERRORS.rateLimited(lim.retryAfter, 'That is a lot of chains for one day. Try tomorrow.');

  const c = await chainForDay(ctx.db, day);
  return ok({ day, chain: { ...shape(c.id, c), author: c.author || null } });
}

/* GET /api/wordchain/practice?n=15&seen=3,9,41 -> { chains: [{ id, words, links }] }

   `seen` is the ids this device already has; the server avoids them while it can. */
export async function practice(ctx) {
  const sp = ctx.url.searchParams;
  let n = parseInt(sp.get('n') || '15', 10);
  if (!Number.isFinite(n) || n < 1) n = 15;
  n = Math.min(n, MAX_BATCH);
  const seen = (sp.get('seen') || '').split(',').slice(0, MAX_SEEN)
    .map((s) => parseInt(s, 10)).filter((x) => Number.isInteger(x) && x >= 0 && x < BANK_SIZE);

  const subject = subjectOf(ctx);
  const lim = await consume(ctx.db, 'wc_practice', subject || 'ip:' + (ctx.ip || 'unknown'), ctx.now);
  if (!lim.allowed) return ERRORS.rateLimited(lim.retryAfter, 'That is plenty of practice chains for one day.');

  const today = Engine.dayNumber(utcDay(ctx.now));
  const chains = practiceBatch(today, seen, n);
  if (subject) await bump(ctx.db, utcDay(ctx.now), subject, 'topups');
  return ok({ chains });
}

/* POST /api/wordchain/practice/played { id } -> {}   (best effort; never an error to the game) */
export async function practicePlayed(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { id }.');
  const id = asObject(body.value).id;
  if (!Number.isInteger(id) || id < 0 || id >= BANK_SIZE) return err('bad_id', 'That is not a chain.', 400);
  const subject = subjectOf(ctx);
  if (!subject) return ok({});
  const lim = await consume(ctx.db, 'wc_played', subject, ctx.now);
  if (!lim.allowed) return ok({});                         // a runaway client cannot inflate the numbers
  await bump(ctx.db, utcDay(ctx.now), subject, 'plays');
  return ok({});
}

function bump(db, day, subject, column) {
  const col = column === 'plays' ? 'plays' : 'topups';     // never interpolated from input
  return run(db,
    `INSERT INTO practice_stats (day, subject, ${col}) VALUES (?, ?, 1)
     ON CONFLICT(day, subject) DO UPDATE SET ${col} = ${col} + 1`, day, subject);
}

/* GET /api/admin/practice-stats?days=30

   What the admin surface needs to size the practice pool: per day, how many players
   practised, how many chains they finished between them, the average and the peak per
   player, and how often a device had to top up. Plus the pools as they stand today, so
   "peak 28 in a day" can be read against "tier 1 has 74 chains". */
export async function practiceStats(ctx) {
  let days = parseInt(ctx.url.searchParams.get('days') || '30', 10);
  if (!Number.isFinite(days) || days < 1) days = 30;
  days = Math.min(days, 180);
  const from = shiftDay(utcDay(ctx.now), -(days - 1));

  const rows = await all(ctx.db,
    `SELECT day,
            SUM(CASE WHEN plays > 0 THEN 1 ELSE 0 END) AS players,
            SUM(plays)  AS plays,
            MAX(plays)  AS peak,
            SUM(topups) AS topups,
            SUM(CASE WHEN plays >= 20 THEN 1 ELSE 0 END) AS heavy
       FROM practice_stats WHERE day >= ?
      GROUP BY day ORDER BY day DESC`, from);

  const perDay = rows.map((r) => ({
    day: r.day,
    players: r.players,
    plays: r.plays,
    average: r.players ? Math.round((10 * r.plays) / r.players) / 10 : 0,
    peak: r.peak,
    topups: r.topups,
    heavy: r.heavy,                       // players who finished 20+ practice chains that day
  }));

  const total = await first(ctx.db,
    `SELECT SUM(CASE WHEN plays > 0 THEN 1 ELSE 0 END) AS player_days, SUM(plays) AS plays,
            MAX(plays) AS peak FROM practice_stats WHERE day >= ?`, from);
  return ok({
    from, days,
    summary: {
      player_days: total.player_days || 0,
      plays: total.plays || 0,
      average_per_player_day: total.player_days ? Math.round((10 * total.plays) / total.player_days) / 10 : 0,
      peak_in_a_day: total.peak || 0,
    },
    per_day: perDay,
    pools: poolStats(Engine.dayNumber(utcDay(ctx.now))),
  });
}
