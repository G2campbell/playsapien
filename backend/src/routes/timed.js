/* Timed friend challenges for Word Chain. The rules are in lib/timed.js; this is the plumbing.

     POST /api/timed              challenge a friend (Sapien): the same chain for both
     GET  /api/timed              my challenges: the ones waiting on me first
     POST /api/timed/:id/start    open the chain (and start my clock on the server); the same on every later open
     POST /api/timed/:id/finish   send how I solved it; the server works out my time
     POST /api/timed/:id/cancel   withdraw or decline a challenge that has not started

   Starting a challenge is Sapien; being challenged and playing are open to everyone. Nobody
   sees the other's time until they have finished themselves. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { first, all, run, stmt } from '../lib/db.js';
import { newId } from '../lib/id.js';
import { asObject, utcDay } from '../lib/validate.js';
import { consume } from '../middleware/ratelimit.js';
import { noticeStatement } from './player.js';
import { resolveTarget } from './challenge-target.js';
import { practiceBatch } from '../lib/wcpools.js';
import { isWord } from '../lib/dictionary.js';
import { judge, checkPlay } from '../lib/timed.js';
import Engine from '../../../packages/scoring/wordchain.cjs';

const MAX_ACTIVE = 25;           // challenges going at once, per player
const FINISHED_DAYS = 30;        // how long a finished one stays in the list
const MAX_MOVES_BYTES = 4000;
const other = (side) => (side === 'a' ? 'b' : 'a');
const nameOf = (user) => user.display_name || user.handle || 'Someone';

/* A gap between two times, to the nearest second and never 0:00 for a result that was not a draw. */
const gapText = (ms) => { const t = Math.max(1, Math.round(Math.abs(ms) / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

async function load(db, id) {
  const r = await first(db, 'SELECT * FROM timed WHERE id = ?', id);
  if (!r) return null;
  return { ...r, words: JSON.parse(r.chain_words), links: JSON.parse(r.chain_links) };
}
const sideOf = (t, userId) => (t.a_id === userId ? 'a' : t.b_id && t.b_id === userId ? 'b' : null);

async function participant(ctx) {
  if (!ctx.user) return { error: ERRORS.unauthorised() };
  const t = await load(ctx.db, ctx.params.id);
  const side = t ? sideOf(t, ctx.user.id) : null;
  if (!t || !side) return { error: ERRORS.notFound('No such challenge.') };
  return { t, side };
}

/* --------------------------------------------------------------------- create */

/* POST /api/timed  { to: { friend_id } | { invite: "<email or invite code>" } } */
export async function create(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  if (ctx.user.plan !== 'sapien') return err('sapien_required', 'Starting a challenge is part of Sapien.', 403);
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { to }.');
  const to = asObject(asObject(body.value).to);
  const me = ctx.user.id;

  const gate = await consume(ctx.db, 'timed_create', me, ctx.now);
  if (!gate.allowed) return ERRORS.rateLimited(gate.retryAfter, 'That is a lot of challenges for one day. Try tomorrow.');
  const busy = await first(ctx.db,
    `SELECT COUNT(*) AS n FROM timed WHERE (a_id = ? OR b_id = ?) AND state IN ('invited','active')`, me, me);
  if (busy.n >= MAX_ACTIVE) return err('too_many_games', 'You have a lot of challenges going. Finish a few first.', 400);

  const t = await resolveTarget(ctx, to, async (x, y) => (await first(ctx.db,
    `SELECT COUNT(*) AS n FROM timed WHERE state IN ('invited','active')
       AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`, x, y, y, x)).n);
  if (t.error) return t.error;
  const { them, key, label, state, blocked, invited } = t;
  if (blocked) return ok({ id: newId('t'), state: 'invited' }, { status: 201 });

  /* The chain: from the practice pile, one neither player has had in a challenge before. */
  const refs = await all(ctx.db,
    `SELECT chain_ref FROM timed WHERE a_id = ? OR b_id = ? OR a_id = ? OR b_id = ?
     UNION SELECT chain_ref FROM duels WHERE a_id = ? OR b_id = ? OR a_id = ? OR b_id = ?`,
    me, me, them, them, me, me, them, them);
  const seen = refs.map((r) => /^bank:(\d+)$/.exec(r.chain_ref)).filter(Boolean).map((m) => Number(m[1]));
  const pick = practiceBatch(Engine.dayNumber(utcDay(ctx.now)), seen, 1)[0];

  const id = newId('t');
  const writes = [
    stmt(ctx.db,
      `INSERT INTO timed (id, a_id, b_id, challenger_id, invite_key, invite_label, chain_words, chain_links,
                          chain_ref, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, them, me, me, key, label, JSON.stringify(pick.words),
      JSON.stringify(pick.links.map((l) => ({ numberStrict: !!l.numberStrict }))),
      'bank:' + pick.id, state, ctx.now, ctx.now),
  ];
  if (them && state === 'active') {
    writes.push(noticeStatement(ctx.db, {
      userId: them, kind: 'timed_challenge', link: '/wordchain/', now: ctx.now,
      body: nameOf(ctx.user) + ' challenged you to a timed Word Chain.',
    }));
  }
  await ctx.db.batch(writes);
  return ok({ id, state: invited ? 'invited' : state }, { status: 201 });
}

/* ----------------------------------------------------------------------- list */

/* GET /api/timed -> { yourTurn: n, games: [...] }   (yourTurn: how many are waiting for my run) */
export async function list(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const me = ctx.user.id;
  const rows = await all(ctx.db,
    `SELECT t.id, t.a_id, t.b_id, t.challenger_id, t.invite_label, t.state, t.a_started, t.b_started,
            t.a_ms, t.b_ms, t.result, t.updated_at, t.finished_at,
            ua.handle AS a_handle, ua.display_name AS a_name, ua.avatar AS a_avatar,
            CASE WHEN ua.avatar = 'custom' THEN ua.avatar_img END AS a_img,
            ub.handle AS b_handle, ub.display_name AS b_name, ub.avatar AS b_avatar,
            CASE WHEN ub.avatar = 'custom' THEN ub.avatar_img END AS b_img
       FROM timed t
       LEFT JOIN users ua ON ua.id = t.a_id
       LEFT JOIN users ub ON ub.id = t.b_id
      WHERE (t.a_id = ? OR t.b_id = ?)
        AND (t.state IN ('invited', 'active') OR (t.state = 'done' AND t.finished_at > ?))
      ORDER BY t.updated_at DESC LIMIT 80`, me, me, ctx.now - FINISHED_DAYS * 86400);

  const games = rows.map((r) => {
    const side = r.a_id === me ? 'a' : 'b';
    const them = side === 'a'
      ? (r.b_id ? { id: r.b_id, name: r.b_name || r.b_handle || 'Player', avatar: r.b_avatar, avatar_img: r.b_img || null } : null)
      : (r.a_id ? { id: r.a_id, name: r.a_name || r.a_handle || 'Player', avatar: r.a_avatar, avatar_img: r.a_img || null } : null);
    const mine = r[side + '_ms'], theirs = r[other(side) + '_ms'];
    const done = r.state === 'done';
    const challenged = r.challenger_id !== me;
    return {
      id: r.id,
      state: r.state,
      side,
      opponent: them,
      waitingOn: !them && !challenged ? (r.invite_label || 'your invited friend') : null,
      needsFriendAccept: r.state === 'invited' && challenged,
      /* it is on me to run it: not finished yet */
      yourTurn: r.state === 'active' && mine == null,
      started: r[side + '_started'] != null,
      mineMs: mine == null ? null : mine,
      /* Whether they have finished, but never their time until I have mine -- and then only
         once the challenge is over. */
      theirsFinished: theirs != null,
      theirMs: done ? theirs : null,
      result: done ? (r.result === 'draw' ? 'draw' : r.result === side ? 'win' : 'loss') : null,
      /* Positive: I was faster by this much. */
      diffMs: done ? theirs - mine : null,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
    };
  });
  const rank = (g) => (g.yourTurn ? 0 : g.needsFriendAccept ? 1 : g.state === 'active' ? 2 : g.state === 'invited' ? 3 : 4);
  games.sort((x, y) => rank(x) - rank(y) || (rank(x) === 0 ? x.updatedAt - y.updatedAt : y.updatedAt - x.updatedAt));
  return ok({ yourTurn: games.filter((g) => g.yourTurn).length, games });
}

/* ---------------------------------------------------------------- start, finish */

/* POST /api/timed/:id/start -> { id, chain: { words, links }, startedAt }

   The first open starts this player's clock on the server; every later open (the game
   resumed after being closed) is answered with the same chain and the same start. */
export async function start(ctx) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  const { t, side } = p;
  if (t.state !== 'active') return err('not_active', 'That challenge is not being played.', 409);
  if (t[side + '_ms'] != null) return err('already_finished', 'You have already finished this one.', 409);

  let startedAt = t[side + '_started'];
  if (startedAt == null) {
    await run(ctx.db,
      `UPDATE timed SET ${side}_started = ?, updated_at = ? WHERE id = ? AND ${side}_started IS NULL`,
      ctx.now, ctx.now, t.id);
    startedAt = (await first(ctx.db, `SELECT ${side}_started AS s FROM timed WHERE id = ?`, t.id)).s;
  }
  return ok({ id: t.id, chain: { words: t.words, links: t.links }, startedAt });
}

/* POST /api/timed/:id/finish { moves } -> my time, and the result if the other has finished */
export async function finish(ctx) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  const { t, side } = p;
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { moves }.');
  const moves = asObject(body.value).moves;

  if (t.state !== 'active') return err('not_active', 'That challenge is not being played.', 409);
  if (t[side + '_ms'] != null) return err('already_finished', 'You have already finished this one.', 409);
  const started = t[side + '_started'];
  if (started == null) return err('not_started', 'Open the chain first.', 409);
  if (!moves || JSON.stringify(moves).length > MAX_MOVES_BYTES) return err('bad_moves', 'Those moves do not replay.', 400);

  /* Was the chain really solved, and what did the Lifelines cost? */
  const v = Engine.verify({}, moves, null, isWord, { id: t.chain_ref, words: t.words, links: t.links });
  if (!v.ok) return err(v.error, 'Those moves do not replay.', 400);
  const timing = checkPlay({ baseMs: v.baseMs, startedSec: started, nowSec: ctx.now });
  if (timing.error) return err(timing.error, 'That time is not one this game can have taken.', 400);
  const ms = timing.baseMs + v.penaltyMs;

  const res = await run(ctx.db,
    `UPDATE timed SET ${side}_ms = ?, ${side}_moves = ?, updated_at = ?
      WHERE id = ? AND ${side}_ms IS NULL AND state = 'active'`, ms, JSON.stringify(moves), ctx.now, t.id);
  if (!(res && res.meta && res.meta.changes)) return err('busy', 'That did not go through. Try again.', 409);

  /* If they have finished too, it is decided. */
  const after = await first(ctx.db, 'SELECT a_ms, b_ms, a_id, b_id FROM timed WHERE id = ?', t.id);
  const theirMs = after[other(side) + '_ms'];
  const otherId = side === 'a' ? after.b_id : after.a_id;
  const writes = [];
  const me = nameOf(ctx.user);
  let result = null;
  if (theirMs != null) {
    result = judge(after.a_ms, after.b_ms);
    writes.push(stmt(ctx.db,
      `UPDATE timed SET state = 'done', result = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND state = 'active'`, result, ctx.now, ctx.now, t.id));
    if (otherId) {
      const rel = result === 'draw' ? 'draw' : result === other(side) ? 'win' : 'loss';
      const gap = gapText(after.a_ms - after.b_ms);
      writes.push(noticeStatement(ctx.db, {
        userId: otherId, kind: 'timed_result', link: '/wordchain/', now: ctx.now,
        body: rel === 'draw' ? 'Your timed challenge with ' + me + ' was a draw.'
          : rel === 'win' ? 'You beat ' + me + ' in your timed challenge, by ' + gap + '.'
          : me + ' beat you in your timed challenge, by ' + gap + '.',
      }));
    }
  } else if (otherId) {
    writes.push(noticeStatement(ctx.db, {
      userId: otherId, kind: 'timed_turn', link: '/wordchain/', now: ctx.now,
      body: me + ' has finished your timed challenge. Your turn.',
    }));
  }
  if (writes.length) await ctx.db.batch(writes);

  const done = theirMs != null;
  return ok({
    id: t.id,
    state: done ? 'done' : 'active',
    mineMs: ms,
    hints: v.hints,
    penaltyMs: v.penaltyMs,
    theirsFinished: done,
    theirMs: done ? theirMs : null,
    result: done ? (result === 'draw' ? 'draw' : result === side ? 'win' : 'loss') : null,
    diffMs: done ? theirMs - ms : null,
  });
}

/* POST /api/timed/:id/cancel -> withdraw (the challenger) or decline (the challenged), before it starts */
export async function cancel(ctx) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  if (p.t.state !== 'invited') return err('already_started', 'That challenge has started.', 409);
  await run(ctx.db,
    `UPDATE timed SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'invited'`, ctx.now, p.t.id);
  return ok({ id: p.t.id, state: 'cancelled' });
}

/* ----------------------------------------------------------------- the record */

/* Wins, draws and losses against each friend in finished timed challenges, and the TIME
   DIFFERENTIAL: the total of (their time minus mine) over those games, so a positive number is
   how much faster I have been overall. For the Analytics card.
   Returns { total: {w,d,l,diff_ms}, friends: [{ friend, w, d, l, diff_ms }] }, most-played first. */
export async function recordFor(db, userId) {
  const rows = await all(db,
    `SELECT t.a_id, t.b_id, t.a_ms, t.b_ms, t.result,
            ua.handle AS a_handle, ua.display_name AS a_name, ua.avatar AS a_avatar,
            CASE WHEN ua.avatar = 'custom' THEN ua.avatar_img END AS a_img,
            ub.handle AS b_handle, ub.display_name AS b_name, ub.avatar AS b_avatar,
            CASE WHEN ub.avatar = 'custom' THEN ub.avatar_img END AS b_img
       FROM timed t
       LEFT JOIN users ua ON ua.id = t.a_id AND ua.deleted_at IS NULL
       LEFT JOIN users ub ON ub.id = t.b_id AND ub.deleted_at IS NULL
      WHERE t.state = 'done' AND (t.a_id = ? OR t.b_id = ?)`, userId, userId);
  const total = { w: 0, d: 0, l: 0, diff_ms: 0 };
  const by = new Map();
  for (const r of rows) {
    const side = r.a_id === userId ? 'a' : 'b';
    const oppId = side === 'a' ? r.b_id : r.a_id;
    if (!oppId) continue;
    const key = r.result === 'draw' ? 'd' : r.result === side ? 'w' : 'l';
    const diff = (side === 'a' ? r.b_ms - r.a_ms : r.a_ms - r.b_ms);
    total[key]++; total.diff_ms += diff;
    let e = by.get(oppId);
    if (!e) {
      const p = side === 'a'
        ? { name: r.b_name || r.b_handle, avatar: r.b_avatar, avatar_img: r.b_img }
        : { name: r.a_name || r.a_handle, avatar: r.a_avatar, avatar_img: r.a_img };
      by.set(oppId, (e = { friend: { id: oppId, name: p.name || 'Player', avatar: p.avatar || null, avatar_img: p.avatar_img || null }, w: 0, d: 0, l: 0, diff_ms: 0 }));
    }
    e[key]++; e.diff_ms += diff;
  }
  const friends = [...by.values()].sort((x, y) => (y.w + y.d + y.l) - (x.w + x.d + x.l));
  return { total, friends };
}
