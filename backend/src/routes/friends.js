/* Friends: invite codes, requests, accept, remove, block.

   One invariant runs through the whole file and is worth stating before any of
   it: a friendship is ONE row, and that row always has a_id < b_id.

   The schema enforces it with CHECK (a_id < b_id) and a primary key on the
   pair, which together make a duplicate request impossible to insert rather
   than merely unlikely -- the second one hits the primary key whichever
   direction it came from. The cost is that "my friends" is
   `WHERE a_id = ? OR b_id = ?`, two index lookups rather than one. At a few
   hundred friends per player that is nothing, and it buys away the entire class
   of bug where A and B disagree about whether they are friends. Spec §3.

   Every function that touches friendships therefore goes through pair() first,
   and no function anywhere writes a_id or b_id from a request parameter
   directly. */

import { ok, err, ERRORS, readJson, conflict } from '../lib/http.js';
import { first, all, run, stmt, isUniqueViolation } from '../lib/db.js';
import { newInviteCode, normaliseInviteCode } from '../lib/id.js';
import { asObject } from '../lib/validate.js';
import { consume } from '../middleware/ratelimit.js';
import { noticeStatement } from './player.js';

/* The canonical ordering. Called on the way in, every time, so that nothing
   downstream has to remember which of two user ids is which. */
export function pair(x, y) {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

export async function getFriendship(db, x, y) {
  const { a, b } = pair(x, y);
  return first(db,
    `SELECT a_id, b_id, state, requested_by, created_at, responded_at
       FROM friendships WHERE a_id = ? AND b_id = ?`, a, b);
}

/* The ids of everyone the player has actually accepted. This is the list the
   leaderboard is built from -- spec §5: leaderboards are friends-only, because
   scores are client-reported and a cheater should only be able to fool people
   who know them. */
export async function acceptedFriendIds(db, userId) {
  const rows = await all(db,
    `SELECT a_id, b_id FROM friendships
      WHERE state = 'accepted' AND (a_id = ? OR b_id = ?)`, userId, userId);
  return rows.map((r) => (r.a_id === userId ? r.b_id : r.a_id));
}

/* GET /api/player/friends -> accepted + pending */
export async function listFriends(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const me = ctx.user.id;

  const rows = await all(ctx.db,
    `SELECT f.a_id, f.b_id, f.state, f.requested_by, f.created_at, f.responded_at,
            ua.handle AS a_handle, ua.display_name AS a_name, ua.avatar AS a_avatar,
            ub.handle AS b_handle, ub.display_name AS b_name, ub.avatar AS b_avatar
       FROM friendships f
       JOIN users ua ON ua.id = f.a_id
       JOIN users ub ON ub.id = f.b_id
      WHERE (f.a_id = ? OR f.b_id = ?) AND ua.deleted_at IS NULL AND ub.deleted_at IS NULL
      ORDER BY f.created_at DESC`, me, me);

  const accepted = [], incoming = [], outgoing = [], blocked = [];
  for (const r of rows) {
    const theirs = r.a_id === me
      ? { id: r.b_id, handle: r.b_handle, display_name: r.b_name || '', avatar: r.b_avatar }
      : { id: r.a_id, handle: r.a_handle, display_name: r.a_name || '', avatar: r.a_avatar };
    const entry = { ...theirs, since: r.responded_at || r.created_at };
    if (r.state === 'accepted') accepted.push(entry);
    else if (r.state === 'blocked') blocked.push(theirs);
    else if (r.requested_by === me) outgoing.push(entry);
    else incoming.push(entry);
  }

  return ok({ accepted, incoming, outgoing, blocked });
}

/* GET /api/player/friends/code -> your invite code

   A link, not a search. There is no "find a player by name" endpoint anywhere
   in this API and that is deliberate: a searchable directory of everyone who
   plays is a thing you cannot take back, and a rotatable code does the one job
   people actually want. */
export async function myCode(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const existing = await first(ctx.db,
    `SELECT code, created_at FROM invite_codes
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, ctx.user.id);
  if (existing) return ok(codePayload(ctx, existing.code));

  const code = await mintCode(ctx);
  return ok(codePayload(ctx, code));
}

/* POST /api/player/friends/code/rotate

   Revoking the old code is the whole point: a code that has been pasted into a
   group chat cannot be unpasted, so the only remedy is to make it stop working. */
export async function rotateCode(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  await run(ctx.db,
    'UPDATE invite_codes SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ctx.now, ctx.user.id);
  const code = await mintCode(ctx);
  return ok(codePayload(ctx, code));
}

function codePayload(ctx, code) {
  return {
    code,
    /* Built here rather than in the client so that the link and the code can
       never drift apart, and so a change of domain is one constant. */
    link: String(ctx.env.APP_ORIGIN || '').replace(/\/$/, '') + '/add/' + code,
  };
}

async function mintCode(ctx) {
  /* 22^8 is about 35 bits, so a collision needs roughly a hundred thousand
     live codes before it is worth thinking about. Retried anyway, because
     "worth thinking about" is not "impossible" and the retry is three lines. */
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newInviteCode();
    try {
      await run(ctx.db,
        'INSERT INTO invite_codes (code, user_id, created_at) VALUES (?, ?, ?)',
        code, ctx.user.id, ctx.now);
      return code;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error('invite code: could not find a free code in five tries');
}

/* POST /api/player/friends/add  { code } -> request or auto-accept */
export async function addByCode(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { code: "..." }.');

  const gate = await consume(ctx.db, 'friend_add', ctx.user.id, ctx.now);
  if (!gate.allowed) {
    return ERRORS.rateLimited(gate.retryAfter, 'That is a lot of friend requests for one day.');
  }

  const code = normaliseInviteCode(asObject(body.value).code);
  if (code.length !== 8) return err('bad_code', 'That invite code does not look right.', 400);

  const row = await first(ctx.db,
    `SELECT ic.user_id, u.handle, u.display_name, u.avatar
       FROM invite_codes ic JOIN users u ON u.id = ic.user_id
      WHERE ic.code = ? AND ic.revoked_at IS NULL AND u.deleted_at IS NULL`, code);
  /* A revoked code, an unknown code and a deleted owner all report the same
     thing. Distinguishing them would turn this endpoint into a way to test
     whether a code was ever real. */
  if (!row) return err('bad_code', 'That invite code does not work.', 400);

  const them = row.user_id;
  if (them === ctx.user.id) return err('self', 'That is your own invite code.', 400);

  const existing = await getFriendship(ctx.db, ctx.user.id, them);
  if (existing) {
    if (existing.state === 'blocked') {
      /* Reported as an ordinary bad code. Saying "you are blocked" tells
         somebody they were blocked, which is exactly the conversation blocking
         is meant to avoid. */
      return err('bad_code', 'That invite code does not work.', 400);
    }
    if (existing.state === 'accepted') {
      return conflict('already_friends', 'You are already friends.', { id: them });
    }
    if (existing.requested_by === ctx.user.id) {
      /* The duplicate. The primary key would have refused the insert anyway;
         this is the same refusal with a sentence a client can show. */
      return conflict('already_requested', 'You have already asked. Give them a moment.',
        { id: them });
    }
    /* They asked first, and this is the answer. The friend-by-link flow reads
       as a single action from both ends this way: two people swap codes, both
       tap, and neither has to find a pending list. */
    return await accept(ctx, them);
  }

  const { a, b } = pair(ctx.user.id, them);
  try {
    await ctx.db.batch([
      stmt(ctx.db,
        `INSERT INTO friendships (a_id, b_id, state, requested_by, created_at)
         VALUES (?, ?, 'pending', ?, ?)`, a, b, ctx.user.id, ctx.now),
      noticeStatement(ctx.db, {
        userId: them,
        kind: 'friend_request',
        body: (ctx.user.display_name || ctx.user.handle || 'Someone') + ' wants to be friends.',
        link: '/friends',
        now: ctx.now,
      }),
    ]);
  } catch (e) {
    /* Two taps racing. The row that won is the right one either way. */
    if (isUniqueViolation(e)) {
      return conflict('already_requested', 'You have already asked.', { id: them });
    }
    throw e;
  }

  return ok({ state: 'pending', id: them, display_name: row.display_name || '', handle: row.handle });
}

/* POST /api/player/friends/:id/accept */
export async function acceptRequest(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  return await accept(ctx, ctx.params.id);
}

async function accept(ctx, them) {
  const existing = await getFriendship(ctx.db, ctx.user.id, them);
  if (!existing || existing.state !== 'pending') {
    return ERRORS.notFound('There is no request to accept.');
  }
  if (existing.requested_by === ctx.user.id) {
    return err('own_request', 'You cannot accept your own request.', 400);
  }

  const { a, b } = pair(ctx.user.id, them);
  await ctx.db.batch([
    stmt(ctx.db,
      `UPDATE friendships SET state = 'accepted', responded_at = ?
        WHERE a_id = ? AND b_id = ? AND state = 'pending'`, ctx.now, a, b),
    noticeStatement(ctx.db, {
      userId: them,
      kind: 'friend_accepted',
      body: (ctx.user.display_name || ctx.user.handle || 'Someone') + ' accepted your request.',
      link: '/friends',
      now: ctx.now,
    }),
  ]);

  return ok({ state: 'accepted', id: them });
}

/* DELETE /api/player/friends/:id -> remove or decline

   One verb for three things -- decline an incoming request, withdraw an
   outgoing one, unfriend -- because from the player's side they are the same
   action: make this row stop existing. Blocked rows are the exception and are
   left alone; unblocking is not something this endpoint does by accident. */
export async function removeFriend(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const { a, b } = pair(ctx.user.id, ctx.params.id);
  const res = await run(ctx.db,
    `DELETE FROM friendships WHERE a_id = ? AND b_id = ? AND state IN ('pending','accepted')`,
    a, b);
  const changed = res && res.meta ? res.meta.changes : 0;
  if (!changed) return ERRORS.notFound('You are not connected to that player.');
  return ok({ removed: ctx.params.id });
}

/* POST /api/player/friends/:id/block

   A block is symmetric and it is the end of the matter: neither player appears
   on the other's leaderboard, and neither can send a new request, because the
   primary key means the blocked row IS the pair and a new insert cannot get
   past it.

   The schema has no "blocked_by" column, so the row does not record which side
   blocked -- requested_by is left as it was, because rewriting it to mean
   "blocker" would make the same column mean two different things depending on
   state, which is how a table starts lying. The consequence is that unblocking
   cannot be restricted to the blocker, so there is no unblock endpoint: DELETE
   deliberately does not touch a blocked row. Undoing one is an admin action
   today. If that turns out to matter, the fix is a column, not a cleverer
   reading of this one. */
export async function blockFriend(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const them = ctx.params.id;
  if (them === ctx.user.id) return err('self', 'You cannot block yourself.', 400);

  const target = await first(ctx.db, 'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', them);
  if (!target) return ERRORS.notFound('No such player.');

  const { a, b } = pair(ctx.user.id, them);
  await run(ctx.db,
    `INSERT INTO friendships (a_id, b_id, state, requested_by, created_at, responded_at)
     VALUES (?, ?, 'blocked', ?, ?, ?)
     ON CONFLICT(a_id, b_id) DO UPDATE SET state = 'blocked', responded_at = ?`,
    a, b, ctx.user.id, ctx.now, ctx.now, ctx.now);

  return ok({ state: 'blocked', id: them });
}
