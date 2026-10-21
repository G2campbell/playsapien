/* 1v1 Word Chain challenges. The rules are in lib/duel.js; this is the plumbing.

     POST /api/duels                create a challenge (Sapien)
     GET  /api/duels                my games: whose turn it is first, then the rest
     GET  /api/duels/:id            one game, as I am allowed to see it
     POST /api/duels/:id/guess      a guess (the server judges it)
     POST /api/duels/:id/hint       a Lifeline: reveals a letter, ends the turn
     POST /api/duels/:id/resign     give up (the other player wins)
     POST /api/duels/:id/cancel     withdraw or decline a challenge that has not started

   Starting a challenge is Sapien; being challenged, playing and resigning are open to
   everyone. The challenged player moves first (RECIPIENT_SIDE), so the challenge arrives
   as "your turn". Nothing a player has not solved is ever sent to them: see viewFor. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { first, all, run, stmt } from '../lib/db.js';
import { newId } from '../lib/id.js';
import { asObject, utcDay } from '../lib/validate.js';
import { consume } from '../middleware/ratelimit.js';
import { noticeStatement } from './player.js';
import { resolveTarget } from './challenge-target.js';
import { play, viewFor, sideOf } from '../lib/duel.js';
import { practiceBatch } from '../lib/wcpools.js';
import Engine from '../../../packages/scoring/wordchain.cjs';

/* Which side moves first. The challenged player does, so a challenge lands as "your turn".
   Changing this one letter ('b') makes the challenger go first instead. */
const RECIPIENT_SIDE = 'a';

const MAX_ACTIVE = 25;           // games going at once, per player (and at most 5 with one friend)
const FINISHED_DAYS = 30;        // how long a finished game stays in the list
const MIN_WORDS = 4, MAX_WORDS = 12;
const other = (side) => (side === 'a' ? 'b' : 'a');

/* ------------------------------------------------------------------ helpers */

async function loadDuel(db, id) {
  const r = await first(db, 'SELECT * FROM duels WHERE id = ?', id);
  if (!r) return null;
  return { ...r, words: JSON.parse(r.chain_words), links: JSON.parse(r.chain_links) };
}

/* The wrong guesses a side has made on the word they are on. */
async function triedFor(db, d, side) {
  const pos = d[side + '_pos'];
  const rows = await all(db,
    `SELECT guess FROM duel_guesses WHERE duel_id = ? AND side = ? AND word_index = ? AND outcome = 'wrong'`,
    d.id, side, pos);
  return rows.map((r) => r.guess);
}

const who = (u) => ({
  id: u.id, name: u.display_name || u.handle || 'Player', avatar: u.avatar || null,
  avatar_img: u.avatar === 'custom' ? (u.avatar_img || null) : null,
});

async function userInfo(db, id) {
  if (!id) return null;
  const u = await first(db,
    'SELECT id, handle, display_name, avatar, avatar_img FROM users WHERE id = ? AND deleted_at IS NULL', id);
  return u ? who(u) : null;
}

function cleanWords(raw) {
  if (!Array.isArray(raw)) return null;
  const words = raw.map((w) => String(w == null ? '' : w).trim().toUpperCase());
  if (words.length < MIN_WORDS || words.length > MAX_WORDS) return null;
  if (!words.every((w) => /^[A-Z]{2,24}$/.test(w))) return null;
  return words;
}

/* A short sentence for the other player's notices. */
const nameOf = (user) => user.display_name || user.handle || 'Someone';

/* --------------------------------------------------------------------- create */

/* POST /api/duels
     { to: { friend_id } | { invite: "<email or invite code>" },
       chain: { source: 'practice' } | { source: 'mine', words: [...] } } */
export async function create(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  if (ctx.user.plan !== 'sapien') return err('sapien_required', 'Starting a challenge is part of Sapien.', 403);
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { to, chain }.');
  const input = asObject(body.value);
  const to = asObject(input.to), chainIn = asObject(input.chain);
  const me = ctx.user.id;

  const gate = await consume(ctx.db, 'duel_create', me, ctx.now);
  if (!gate.allowed) return ERRORS.rateLimited(gate.retryAfter, 'That is a lot of challenges for one day. Try tomorrow.');
  const busy = await first(ctx.db,
    `SELECT COUNT(*) AS n FROM duels WHERE (a_id = ? OR b_id = ?) AND state IN ('invited','active')`, me, me);
  if (busy.n >= MAX_ACTIVE) return err('too_many_games', 'You have a lot of games going. Finish a few first.', 400);

  /* Their puzzle, if they brought one. Checked before anything is sent to anyone. */
  let mineWords = null;
  if (chainIn.source === 'mine') {
    mineWords = cleanWords(chainIn.words);
    if (!mineWords) return err('bad_chain', 'A puzzle needs ' + MIN_WORDS + ' to ' + MAX_WORDS + ' words, letters only.', 400);
  } else if (chainIn.source !== 'practice') {
    return err('bad_chain', 'Choose a puzzle: practice or one of yours.', 400);
  }

  /* Who it is for: a friend, or an invite (routes/challenge-target.js). */
  const t = await resolveTarget(ctx, to, async (x, y) => (await first(ctx.db,
    `SELECT COUNT(*) AS n FROM duels WHERE state IN ('invited','active')
       AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`, x, y, y, x)).n);
  if (t.error) return t.error;
  const { them, key, label, state, blocked, invited } = t;

  /* Whoever sent an invitation is told the same thing whatever happened to it: a challenge
     to someone who has blocked them simply never appears. */
  if (blocked) return ok({ id: newId('d'), state: 'invited' }, { status: 201 });

  /* The chain. */
  let words, links, ref;
  if (mineWords) {
    words = mineWords; links = words.slice(1).map(() => ({ numberStrict: false })); ref = 'mine';
  } else {
    const refs = await all(ctx.db,
      'SELECT chain_ref FROM duels WHERE a_id = ? OR b_id = ? OR a_id = ? OR b_id = ?', me, me, them, them);
    const seen = refs.map((r) => /^bank:(\d+)$/.exec(r.chain_ref)).filter(Boolean).map((m) => Number(m[1]));
    const pick = practiceBatch(Engine.dayNumber(utcDay(ctx.now)), seen, 1)[0];
    words = pick.words; links = pick.links.map((l) => ({ numberStrict: !!l.numberStrict })); ref = 'bank:' + pick.id;
  }

  const id = newId('d');
  const a_id = RECIPIENT_SIDE === 'a' ? them : me;
  const b_id = RECIPIENT_SIDE === 'a' ? me : them;
  const writes = [
    stmt(ctx.db,
      `INSERT INTO duels (id, a_id, b_id, challenger_id, invite_key, invite_label, chain_words, chain_links,
                          chain_ref, state, round, mover, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'a', ?, ?)`,
      id, a_id, b_id, me, key, label, JSON.stringify(words), JSON.stringify(links), ref, state, ctx.now, ctx.now),
  ];
  if (them && state === 'active') {
    writes.push(noticeStatement(ctx.db, {
      userId: them, kind: 'duel_challenge',
      body: nameOf(ctx.user) + ' challenged you to a 1v1 Word Chain.', link: '/wordchain/', now: ctx.now,
    }));
  }
  await ctx.db.batch(writes);
  /* From an invitation the answer is always "invited": it must not say whether the address
     already had an account. The list says how things really stand. */
  return ok({ id, state: invited ? 'invited' : state }, { status: 201 });
}

/* ----------------------------------------------------------------------- list */

/* GET /api/duels -> { yourTurn: n, games: [...] } */
export async function list(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const me = ctx.user.id;
  const rows = await all(ctx.db,
    `SELECT d.id, d.a_id, d.b_id, d.challenger_id, d.invite_label, d.state, d.round, d.mover, d.a_pos, d.b_pos,
            d.a_fin, d.b_fin, d.result, d.updated_at, d.finished_at, d.created_at,
            json_array_length(d.chain_words) AS n,
            ua.handle AS a_handle, ua.display_name AS a_name, ua.avatar AS a_avatar,
            CASE WHEN ua.avatar = 'custom' THEN ua.avatar_img END AS a_img,
            ub.handle AS b_handle, ub.display_name AS b_name, ub.avatar AS b_avatar,
            CASE WHEN ub.avatar = 'custom' THEN ub.avatar_img END AS b_img
       FROM duels d
       LEFT JOIN users ua ON ua.id = d.a_id
       LEFT JOIN users ub ON ub.id = d.b_id
      WHERE (d.a_id = ? OR d.b_id = ?)
        AND (d.state IN ('invited', 'active') OR (d.state = 'done' AND d.finished_at > ?))
      ORDER BY d.updated_at DESC LIMIT 80`, me, me, ctx.now - FINISHED_DAYS * 86400);

  const games = rows.map((r) => {
    const side = r.a_id === me ? 'a' : 'b';
    const them = side === 'a'
      ? (r.b_id ? { id: r.b_id, name: r.b_name || r.b_handle || 'Player', avatar: r.b_avatar, avatar_img: r.b_img || null } : null)
      : (r.a_id ? { id: r.a_id, name: r.a_name || r.a_handle || 'Player', avatar: r.a_avatar, avatar_img: r.a_img || null } : null);
    const mine = r[side + '_pos'], theirs = r[other(side) + '_pos'];
    const challenged = r.challenger_id !== me;
    return {
      id: r.id,
      state: r.state,
      side,
      opponent: them,
      /* Only the challenger sees the masked address they typed. */
      waitingOn: !them && !challenged ? (r.invite_label || 'your invited friend') : null,
      yourTurn: r.state === 'active' && r.mover === side,
      /* They were invited with a challenge and have not yet said yes to the friend request. */
      needsFriendAccept: r.state === 'invited' && challenged,
      round: r.round,
      n: r.n,
      mySolved: Math.min(mine, r.n) - 1,
      theirSolved: Math.min(theirs, r.n) - 1,
      result: r.state === 'done' ? (r.result === 'draw' ? 'draw' : r.result === side ? 'win' : 'loss') : null,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
    };
  });

  /* Whose turn it is first (the one who has waited longest), then the rest. */
  const rank = (g) => (g.yourTurn ? 0 : g.needsFriendAccept ? 1 : g.state === 'active' ? 2 : g.state === 'invited' ? 3 : 4);
  games.sort((x, y) => rank(x) - rank(y) || (rank(x) === 0 ? x.updatedAt - y.updatedAt : y.updatedAt - x.updatedAt));
  return ok({ yourTurn: games.filter((g) => g.yourTurn).length, games });
}

/* ------------------------------------------------------------------ one game */

async function participant(ctx) {
  if (!ctx.user) return { error: ERRORS.unauthorised() };
  const d = await loadDuel(ctx.db, ctx.params.id);
  const side = d ? sideOf(d, ctx.user.id) : null;
  if (!d || !side) return { error: ERRORS.notFound('No such game.') };
  return { d, side };
}

async function opponentOf(ctx, d, side) {
  const info = await userInfo(ctx.db, side === 'a' ? d.b_id : d.a_id);
  return info || (d.invite_label && d.challenger_id === ctx.user.id ? { name: d.invite_label } : null);
}

/* GET /api/duels/:id */
export async function get(ctx) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  const { d, side } = p;
  const view = viewFor(d, side, d.state === 'active' ? await triedFor(ctx.db, d, side) : []);
  return ok({ ...view, opponent: await opponentOf(ctx, d, side) });
}

/* ---------------------------------------------------------------------- moves */

const ERROR_FOR = {
  not_active: () => err('not_active', 'That game is not being played.', 409),
  not_your_turn: () => err('not_your_turn', 'It is not your turn.', 409),
  already_finished: () => err('already_finished', 'You have already finished this chain.', 409),
  no_more_hints: () => err('no_more_hints', 'No more Lifelines on this word.', 400),
  bad_action: () => ERRORS.invalid('Not a move.'),
};

const COLUMNS = ['a_pos', 'b_pos', 'a_hints', 'b_hints', 'a_fin', 'b_fin', 'mover', 'round', 'state', 'result'];

async function move(ctx, action) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  const { d, side } = p;
  const gate = await consume(ctx.db, 'duel_move', ctx.user.id, ctx.now);
  if (!gate.allowed) return ERRORS.rateLimited(gate.retryAfter, 'That is a lot of moves for one day.');

  const tried = await triedFor(ctx.db, d, side);
  const r = play(d, side, action, tried);
  if (r.error) return ERROR_FOR[r.error]();

  const opponent = await opponentOf(ctx, d, side);
  const patch = r.patch;
  const keys = Object.keys(patch).filter((k) => COLUMNS.includes(k));

  let after = d;
  if (keys.length) {
    const sets = keys.map((k) => k + ' = ?');
    const params = keys.map((k) => patch[k]);
    if (patch.state === 'done') { sets.push('finished_at = ?'); params.push(ctx.now); }
    const res = await run(ctx.db,
      `UPDATE duels SET ${sets.join(', ')}, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?`, ...params, ctx.now, d.id, d.version);
    if (!(res && res.meta && res.meta.changes)) {
      return err('busy', 'That move did not go through. Try again.', 409);
    }
    after = { ...d, ...patch, version: d.version + 1 };

    const pos = d[side + '_pos'];
    const writes = [];
    if (r.outcome === 'correct' || r.outcome === 'wrong' || r.outcome === 'hint') {
      writes.push(stmt(ctx.db,
        `INSERT INTO duel_guesses (duel_id, side, seq, word_index, guess, outcome, at)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM duel_guesses WHERE duel_id = ? AND side = ?), ?, ?, ?, ?)`,
        d.id, side, d.id, side, pos, action.type === 'guess' ? action.guess : '', r.outcome, ctx.now));
    }
    /* The other player is told when it becomes their turn, or when it is over. */
    const otherId = side === 'a' ? d.b_id : d.a_id;
    if (otherId) {
      const me = nameOf(ctx.user);
      if (r.over) {
        const rel = r.over.result === 'draw' ? 'draw' : r.over.result === other(side) ? 'win' : 'loss';
        writes.push(noticeStatement(ctx.db, {
          userId: otherId, kind: 'duel_result', link: '/wordchain/', now: ctx.now,
          body: rel === 'draw' ? 'Your 1v1 with ' + me + ' ended in a draw.'
            : rel === 'win' ? 'You beat ' + me + ' at 1v1 Word Chain.' : me + ' won your 1v1 Word Chain.',
        }));
      } else if (patch.mover === other(side)) {
        const finished = patch[side + '_fin'] != null;
        writes.push(noticeStatement(ctx.db, {
          userId: otherId, kind: 'duel_turn', link: '/wordchain/', now: ctx.now,
          body: finished ? me + ' finished the chain. You have one turn to tie it.'
            : 'It is your turn against ' + me + '.',
        }));
      }
    }
    if (writes.length) await ctx.db.batch(writes);
  }

  /* The wrong guesses on the word they are on now. */
  const stillOnWord = (after[side + '_pos'] === d[side + '_pos']);
  const triedNow = stillOnWord ? (r.remember ? tried.concat([r.remember]) : tried) : [];
  return ok({
    outcome: r.outcome, turnOver: r.turnOver, solved: r.solved, prefix: r.prefix,
    over: r.over ? r.over.result : null,
    game: { ...viewFor(after, side, triedNow), opponent },
  });
}

/* POST /api/duels/:id/guess { guess } */
export async function guess(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { guess }.');
  const g = String(asObject(body.value).guess || '').trim().toUpperCase();
  if (!/^[A-Z]{1,40}$/.test(g)) return err('bad_guess', 'Letters only.', 400);
  return await move(ctx, { type: 'guess', guess: g });
}

/* POST /api/duels/:id/hint */
export async function hint(ctx) {
  return await move(ctx, { type: 'hint' });
}

/* POST /api/duels/:id/resign -> the other player wins */
export async function resign(ctx) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  const { d, side } = p;
  if (d.state !== 'active') return ERROR_FOR.not_active();
  const res = await run(ctx.db,
    `UPDATE duels SET state = 'done', result = ?, finished_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND state = 'active'`, other(side), ctx.now, ctx.now, d.id, d.version);
  if (!(res && res.meta && res.meta.changes)) return err('busy', 'That did not go through. Try again.', 409);
  const otherId = side === 'a' ? d.b_id : d.a_id;
  if (otherId) {
    await ctx.db.batch([noticeStatement(ctx.db, {
      userId: otherId, kind: 'duel_result', link: '/wordchain/', now: ctx.now,
      body: nameOf(ctx.user) + ' resigned. You win your 1v1 Word Chain.',
    })]);
  }
  return ok({ id: d.id, result: 'loss' });
}

/* POST /api/duels/:id/cancel -> withdraw (the challenger) or decline (the challenged), before it starts */
export async function cancel(ctx) {
  const p = await participant(ctx);
  if (p.error) return p.error;
  const { d } = p;
  if (d.state !== 'invited') return err('already_started', 'That game has started. You can resign from it.', 409);
  await run(ctx.db,
    `UPDATE duels SET state = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ? AND state = 'invited'`,
    ctx.now, d.id);
  return ok({ id: d.id, state: 'cancelled' });
}

/* ----------------------------------------------------------------- the record */

/* Wins, draws and losses against each friend, from finished games. For the Analytics card.
   Returns { total: {w,d,l}, friends: [{ friend, w, d, l }] }, the most-played first. */
export async function recordFor(db, userId) {
  const rows = await all(db,
    `SELECT d.a_id, d.b_id, d.result,
            ua.handle AS a_handle, ua.display_name AS a_name, ua.avatar AS a_avatar,
            CASE WHEN ua.avatar = 'custom' THEN ua.avatar_img END AS a_img,
            ub.handle AS b_handle, ub.display_name AS b_name, ub.avatar AS b_avatar,
            CASE WHEN ub.avatar = 'custom' THEN ub.avatar_img END AS b_img
       FROM duels d
       LEFT JOIN users ua ON ua.id = d.a_id AND ua.deleted_at IS NULL
       LEFT JOIN users ub ON ub.id = d.b_id AND ub.deleted_at IS NULL
      WHERE d.state = 'done' AND (d.a_id = ? OR d.b_id = ?)`, userId, userId);
  const total = { w: 0, d: 0, l: 0 };
  const by = new Map();
  for (const r of rows) {
    const side = r.a_id === userId ? 'a' : 'b';
    const oppId = side === 'a' ? r.b_id : r.a_id;
    if (!oppId) continue;
    const key = r.result === 'draw' ? 'd' : r.result === side ? 'w' : 'l';
    total[key]++;
    let e = by.get(oppId);
    if (!e) {
      const p = side === 'a'
        ? { name: r.b_name || r.b_handle, avatar: r.b_avatar, avatar_img: r.b_img }
        : { name: r.a_name || r.a_handle, avatar: r.a_avatar, avatar_img: r.a_img };
      by.set(oppId, (e = { friend: { id: oppId, name: p.name || 'Player', avatar: p.avatar || null, avatar_img: p.avatar_img || null }, w: 0, d: 0, l: 0 }));
    }
    e[key]++;
  }
  const friends = [...by.values()].sort((x, y) => (y.w + y.d + y.l) - (x.w + x.d + x.l));
  return { total, friends };
}
