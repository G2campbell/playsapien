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
import { asObject, isEmail } from '../lib/validate.js';
import { consume } from '../middleware/ratelimit.js';
import { noticeStatement } from './player.js';
import { hmacSign } from '../lib/crypto.js';
import { normaliseTrialEmail } from '../lib/trial.js';
import { DAY } from '../lib/db.js';
import { groupsFor, unGroupStatements } from './groups.js';

/* How many pending invites a player sees at once. More can arrive, but they
   wait, unseen, until the player makes room by accepting, rejecting or
   blocking -- so nobody can be buried, and a family of five getting its
   group together (four invites each) is nowhere near it. */
export const QUEUE_CAP = 30;

/* The safeguard against inviting strangers: when a player's invites keep
   getting REJECTED (not merely left), their sending pauses. Either rule
   trips it; the pause lasts until the rejections age out of the window. */
const PAUSE_RULES = [{ n: 3, days: 7 }, { n: 5, days: 30 }];

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
            f.later_at, f.blocked_by,
            ua.handle AS a_handle, ua.display_name AS a_name, ua.avatar AS a_avatar,
            CASE WHEN ua.avatar = 'custom' THEN ua.avatar_img END AS a_img,
            ub.handle AS b_handle, ub.display_name AS b_name, ub.avatar AS b_avatar,
            CASE WHEN ub.avatar = 'custom' THEN ub.avatar_img END AS b_img
       FROM friendships f
       JOIN users ua ON ua.id = f.a_id
       JOIN users ub ON ub.id = f.b_id
      WHERE (f.a_id = ? OR f.b_id = ?) AND ua.deleted_at IS NULL AND ub.deleted_at IS NULL
      ORDER BY f.created_at ASC`, me, me);

  const accepted = [], waitingOnMe = [], outgoing = [], blocked = [];
  for (const r of rows) {
    /* avatar_img is the player's own uploaded picture. It is sent only when
       their avatar token is 'custom' -- the renderer ignores it otherwise, and
       a list of friends should not carry pictures nobody will draw. */
    const theirs = r.a_id === me
      ? { id: r.b_id, handle: r.b_handle, display_name: r.b_name || '', avatar: r.b_avatar, avatar_img: r.b_img || null }
      : { id: r.a_id, handle: r.a_handle, display_name: r.a_name || '', avatar: r.a_avatar, avatar_img: r.a_img || null };
    const entry = { ...theirs, since: r.responded_at || r.created_at };
    if (r.state === 'accepted') accepted.push(entry);
    /* A block is shown only to the player who made it. The other side simply
       stops seeing this person -- being told you were blocked is exactly the
       conversation a block exists to avoid. */
    else if (r.state === 'blocked') { if (r.blocked_by === me) blocked.push(theirs); }
    else if (r.requested_by === me) outgoing.push(entry);
    else waitingOnMe.push({ ...entry, later: !!r.later_at });
  }

  /* The queue: oldest first, the first QUEUE_CAP shown. The rest wait. */
  const shown = waitingOnMe.slice(0, QUEUE_CAP);
  return ok({
    accepted,
    incoming: shown.filter((x) => !x.later),
    later: shown.filter((x) => x.later),
    outgoing: outgoing.reverse(),
    blocked,
    queue: { used: shown.length, cap: QUEUE_CAP, waiting: Math.max(0, waitingOnMe.length - QUEUE_CAP) },
    paused_until: await pausedUntil(ctx.db, me, ctx.now),
    /* The player's own friend groups (groups.js), alphabetical. */
    groups: await groupsFor(ctx.db, me),
  });
}

/* When, if at all, this player's invites are paused (see PAUSE_RULES). */
export async function pausedUntil(db, senderId, now) {
  let until = null;
  for (const rule of PAUSE_RULES) {
    const rows = await all(db,
      'SELECT at FROM friend_rejections WHERE sender_id = ? AND at > ? ORDER BY at DESC',
      senderId, now - rule.days * DAY);
    if (rows.length >= rule.n) {
      const t = rows[rule.n - 1].at + rule.days * DAY;
      if (until == null || t > until) until = t;
    }
  }
  return until;
}

function pausedError(until) {
  return err('invites_paused',
    'Several of your recent invites were declined, so sending invites is paused for a few days.', 403);
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

  const paused = await pausedUntil(ctx.db, ctx.user.id, ctx.now);
  if (paused) return pausedError(paused);
  const day = await consume(ctx.db, 'invite_game_day', ctx.user.id, ctx.now);
  if (!day.allowed) return ERRORS.rateLimited(day.retryAfter, 'That is a lot of invites for one day. Try tomorrow.');
  const month = await consume(ctx.db, 'invite_game_month', ctx.user.id, ctx.now);
  if (!month.allowed) return ERRORS.rateLimited(month.retryAfter, 'That is a lot of invites for one month.');

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
  /* No longer friends: out of each other's groups too. */
  await ctx.db.batch(unGroupStatements(ctx.db, ctx.user.id, ctx.params.id));
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
  /* blocked_by records the blocker. Blocking someone who has already blocked
     you changes nothing: the first block stands, and only its maker sees it. */
  await run(ctx.db,
    `INSERT INTO friendships (a_id, b_id, state, requested_by, created_at, responded_at, blocked_by)
     VALUES (?, ?, 'blocked', ?, ?, ?, ?)
     ON CONFLICT(a_id, b_id) DO UPDATE SET
       blocked_by   = CASE WHEN friendships.state = 'blocked' THEN friendships.blocked_by ELSE excluded.blocked_by END,
       responded_at = CASE WHEN friendships.state = 'blocked' THEN friendships.responded_at ELSE excluded.responded_at END,
       state = 'blocked', later_at = NULL`,
    a, b, ctx.user.id, ctx.now, ctx.now, ctx.user.id);
  await ctx.db.batch(unGroupStatements(ctx.db, ctx.user.id, them));

  return ok({ state: 'blocked', id: them });
}

/* ------------------------------------------------------------------------
   The invite queue: Later, Reject, and undoing a block.
   ------------------------------------------------------------------------ */

/* POST /api/player/friends/:id/later -> keep it for later (it stays queued) */
export async function laterRequest(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const { a, b } = pair(ctx.user.id, ctx.params.id);
  const res = await run(ctx.db,
    `UPDATE friendships SET later_at = ?
      WHERE a_id = ? AND b_id = ? AND state = 'pending' AND requested_by = ?`,
    ctx.now, a, b, ctx.params.id);
  if (!(res && res.meta && res.meta.changes)) return ERRORS.notFound('There is no invite from that player.');
  return ok({ state: 'later', id: ctx.params.id });
}

/* POST /api/player/friends/:id/reject -> decline, and count it against them */
export async function rejectRequest(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const them = ctx.params.id;
  const { a, b } = pair(ctx.user.id, them);
  const existing = await getFriendship(ctx.db, ctx.user.id, them);
  if (!existing || existing.state !== 'pending' || existing.requested_by !== them) {
    return ERRORS.notFound('There is no invite from that player.');
  }
  await ctx.db.batch([
    stmt(ctx.db, "DELETE FROM friendships WHERE a_id = ? AND b_id = ? AND state = 'pending'", a, b),
    stmt(ctx.db, 'INSERT INTO friend_rejections (sender_id, recipient_id, at) VALUES (?, ?, ?)',
      them, ctx.user.id, ctx.now),
  ]);
  return ok({ state: 'rejected', id: them });
}

/* POST /api/player/friends/:id/unblock -> only the player who blocked */
export async function unblockFriend(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const { a, b } = pair(ctx.user.id, ctx.params.id);
  const res = await run(ctx.db,
    "DELETE FROM friendships WHERE a_id = ? AND b_id = ? AND state = 'blocked' AND blocked_by = ?",
    a, b, ctx.user.id);
  if (!(res && res.meta && res.meta.changes)) return ERRORS.notFound('That player is not on your block list.');
  return ok({ state: 'unblocked', id: ctx.params.id });
}

/* ------------------------------------------------------------------------
   Inviting by email address.

   One rule shapes all of it: the sender is told "sent" whether or not the
   address belongs to a player, so the box can never be used to find out who
   has an account. Then:

     - The address belongs to a player: the invite arrives in the game, as a
       friend request, and no email is sent.
     - It does not: the invite is kept (as a keyed hash of the address) for
       when that person joins, and ONE invitation email goes to the address --
       at most one per address per 30 days, whoever is inviting, and never to
       an address that has asked to stop.

   Typed addresses count against the sender's EMAIL limits (20 a day, 50 a
   month) whichever way they end up being delivered; the limits cannot differ
   between the two without giving the answer away.
   ------------------------------------------------------------------------ */

export async function emailKey(env, email) {
  const secret = env.TRIAL_KEY_SECRET || env.LOGIN_CODE_PEPPER || 'playsapien-email';
  return hmacSign(secret, 'email:' + normaliseTrialEmail(email));
}
async function stopToken(env, key) {
  return hmacSign(env.OAUTH_STATE_SECRET || env.LOGIN_CODE_PEPPER || 'playsapien-stop', 'stop:' + key);
}

/* Send a friend request to a known player. Shared by the email path. Every
   outcome is "sent" to the caller: blocked, already asked, already friends. */
async function requestPlayer(ctx, them) {
  const existing = await getFriendship(ctx.db, ctx.user.id, them);
  if (existing) {
    if (existing.state === 'pending' && existing.requested_by === them) await accept(ctx, them);
    return;
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
    if (!isUniqueViolation(e)) throw e;
  }
}

/* POST /api/player/friends/invite  { email } -> { sent: true } */
export async function inviteByEmail(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { email: "..." }.');
  const email = String(asObject(body.value).email || '').trim().toLowerCase();
  if (!isEmail(email)) return err('bad_email', 'That does not look like an email address.', 400);
  if (ctx.user.email && normaliseTrialEmail(email) === normaliseTrialEmail(ctx.user.email)) {
    return err('self', 'That is your own address.', 400);
  }

  const paused = await pausedUntil(ctx.db, ctx.user.id, ctx.now);
  if (paused) return pausedError(paused);
  const day = await consume(ctx.db, 'invite_email_day', ctx.user.id, ctx.now);
  if (!day.allowed) return ERRORS.rateLimited(day.retryAfter, 'Twenty email invites a day is the limit. Try tomorrow.');
  const month = await consume(ctx.db, 'invite_email_month', ctx.user.id, ctx.now);
  if (!month.allowed) return ERRORS.rateLimited(month.retryAfter, 'Fifty email invites a month is the limit.');

  const target = await first(ctx.db,
    'SELECT id FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL', email);
  if (target) {
    if (target.id !== ctx.user.id) await requestPlayer(ctx, target.id);
    return ok({ sent: true });
  }

  const key = await emailKey(ctx.env, email);
  const optedOut = await first(ctx.db, 'SELECT 1 AS x FROM email_optouts WHERE email_key = ?', key);
  const recent = await first(ctx.db,
    'SELECT 1 AS x FROM email_invites WHERE email_key = ? AND emailed_at > ?', key, ctx.now - 30 * DAY);
  const willEmail = !optedOut && !recent;

  await run(ctx.db,
    `INSERT INTO email_invites (email_key, inviter_id, created_at, emailed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(email_key, inviter_id) DO NOTHING`,
    key, ctx.user.id, ctx.now, willEmail ? ctx.now : null);

  if (willEmail) {
    const origin = String(ctx.env.APP_ORIGIN || 'https://playsapien.com').replace(/\/$/, '');
    try {
      await ctx.deps.sendFriendInvite({
        to: email,
        inviter: ctx.user.display_name || 'A friend',
        joinLink: origin + '/?invited=1',
        stopLink: origin + '/api/invites/stop?k=' + encodeURIComponent(key) +
                  '&t=' + encodeURIComponent(await stopToken(ctx.env, key)),
      });
    } catch (e) {
      console.error('[friends] invite mail failed: ' + (e && e.message));
    }
  }
  return ok({ sent: true });
}

/* GET /api/invites/stop?k=&t= -> the link at the foot of an invitation email */
export async function stopInviteEmails(ctx) {
  const url = new URL(ctx.req.url);
  const key = url.searchParams.get('k') || '';
  const token = url.searchParams.get('t') || '';
  const good = key && token && token === await stopToken(ctx.env, key);
  if (good) {
    await run(ctx.db,
      'INSERT INTO email_optouts (email_key, at) VALUES (?, ?) ON CONFLICT(email_key) DO NOTHING',
      key, ctx.now);
  }
  const msg = good
    ? 'Done. PlaySapien will not send invitation emails to this address again.'
    : 'That link did not work. If you keep getting invitations, write to info@playsapien.com.';
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>PlaySapien</title><body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;' +
    'padding:0 20px;line-height:1.6;color:#213946;background:#F6F1E7"><h1 style="font-size:22px">PlaySapien</h1>' +
    '<p>' + msg + '</p><p><a href="/" style="color:#213946">Go to PlaySapien</a></p></body>',
    { status: good ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/* When someone joins with an address they were invited at, the invites become
   friend requests waiting in their queue, and the kept invites are deleted. */
export async function claimEmailInvites(ctx, userId, email) {
  if (!email) return;
  const key = await emailKey(ctx.env, email);
  const rows = await all(ctx.db,
    `SELECT ei.inviter_id FROM email_invites ei JOIN users u ON u.id = ei.inviter_id
      WHERE ei.email_key = ? AND ei.created_at > ? AND u.deleted_at IS NULL
      ORDER BY ei.created_at ASC`, key, ctx.now - 90 * DAY);
  const stmts = [];
  for (const r of rows) {
    if (r.inviter_id === userId) continue;
    const { a, b } = pair(userId, r.inviter_id);
    stmts.push(stmt(ctx.db,
      `INSERT INTO friendships (a_id, b_id, state, requested_by, created_at)
       VALUES (?, ?, 'pending', ?, ?) ON CONFLICT(a_id, b_id) DO NOTHING`,
      a, b, r.inviter_id, ctx.now));
  }
  stmts.push(stmt(ctx.db, 'DELETE FROM email_invites WHERE email_key = ?', key));
  await ctx.db.batch(stmts);
}
