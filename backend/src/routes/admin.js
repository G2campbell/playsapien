/* The admin surface: the review queue, incidents, and blocking an author.

   Spec §4: /api/admin/* sits behind Cloudflare Access, not behind a password in
   the app. Access is free at this scale and means the admin surface has no
   login code of its own to get wrong -- no second session mechanism, no second
   rate limiter, no second way to be locked out.

   Access puts a signed JWT in Cf-Access-Jwt-Assertion on every request it lets
   through. That header is verified here rather than trusted, because a Worker
   route can be reached directly if the Access policy is ever misconfigured or
   removed, and a header is trivially forgeable by anyone who can reach the
   origin. Verifying it costs one cached JWKS fetch and closes that door for
   good.

   If ACCESS_TEAM_DOMAIN and ACCESS_AUD are not both set, every admin route
   returns 503 and does nothing. That is deliberate: an unconfigured admin
   surface that fails open is the worst outcome available, and one that fails
   closed is merely inconvenient. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { first, all, run, stmt } from '../lib/db.js';
import { newId } from '../lib/id.js';
import { verifyJwt } from '../lib/crypto.js';
import { asObject, cleanDisplayName, isDay, utcDay, shiftDay } from '../lib/validate.js';
import { noticeStatement } from './player.js';

/* How far ahead an approved daily chain may be slotted. SUBMISSION-PIPELINE.md
   §5: a date at random within the next 10 days, from the free slots. Random
   rather than sequential so that the order chains were approved in is not the
   order they appear, which would make the schedule guessable from the queue. */
const SCHEDULE_HORIZON = 10;

export async function requireAccess(ctx) {
  const team = String(ctx.env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = String(ctx.env.ACCESS_AUD || '').trim();
  if (!team || !aud) {
    return err('admin_unconfigured',
      'The admin surface is not configured on this deployment.', 503);
  }

  const token = ctx.req.headers.get('cf-access-jwt-assertion');
  if (!token) return ERRORS.forbidden('This is behind Cloudflare Access.');

  try {
    const jwks = await ctx.deps.accessJwks(team);
    const claims = await verifyJwt(token, jwks, {
      issuers: ['https://' + team],
      audience: aud,
      now: ctx.now,
    });
    ctx.admin = { email: claims.email || null, sub: claims.sub || null };
    return null;
  } catch (e) {
    console.error('[admin] access assertion rejected: ' + (e && e.message));
    return ERRORS.forbidden('This is behind Cloudflare Access.');
  }
}

/* GET /api/admin/queue -> pending + recommended

   Three lists, matching the review page in SUBMISSION-PIPELINE.md §4:
   recommended for daily (the model's really-goods, awaiting a human), pending
   (what the model could not call, with its reasoning), and the scheduled ones,
   so it is possible to see what is already slotted before adding to it. */
export async function queue(ctx) {
  const rows = await all(ctx.db,
    `SELECT c.id, c.words, c.status, c.pool, c.scheduled_for, c.quality, c.verdict,
            c.flag, c.created_at, c.decided_at, c.decided_by,
            u.id AS author_id, u.display_name, u.handle, u.strikes, u.blocked_at
       FROM chains c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.status IN ('pending', 'approved')
      ORDER BY c.quality DESC, c.created_at ASC
      LIMIT 200`);

  const shaped = rows.map(shapeChain);
  return ok({
    recommended: shaped.filter((c) => c.status === 'pending' && c.quality >= 4),
    pending: shaped.filter((c) => c.status === 'pending' && !(c.quality >= 4)),
    scheduled: shaped.filter((c) => c.status === 'approved' && c.scheduled_for)
      .sort((x, y) => (x.scheduled_for < y.scheduled_for ? -1 : 1)),
    practice: shaped.filter((c) => c.status === 'approved' && c.pool === 'practice'),
  });
}

function shapeChain(r) {
  let words = [];
  try { const v = JSON.parse(r.words); if (Array.isArray(v)) words = v; } catch { /* keep [] */ }
  return {
    id: r.id,
    words,
    status: r.status,
    pool: r.pool,
    scheduled_for: r.scheduled_for,
    quality: r.quality == null ? 0 : r.quality,
    verdict: r.verdict,
    flag: r.flag,
    created_at: r.created_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
    author: r.author_id
      ? {
        id: r.author_id,
        name: r.display_name || r.handle || '',
        strikes: r.strikes || 0,
        blocked: r.blocked_at != null,
      }
      : null,
  };
}

/* POST /api/admin/chains/:id  { action } -> daily | practice | reject */
export async function decideChain(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { action: "daily" }.');
  const payload = asObject(body.value);
  const action = String(payload.action || '');

  const chain = await first(ctx.db,
    'SELECT id, author_id, words, status, pool, scheduled_for FROM chains WHERE id = ?',
    ctx.params.id);
  if (!chain) return ERRORS.notFound('No such chain.');

  if (action === 'daily') return await promoteToDaily(ctx, chain, payload);
  if (action === 'practice') return await promoteToPractice(ctx, chain);
  if (action === 'reject') return await rejectChain(ctx, chain, payload);
  return ERRORS.invalid('action must be daily, practice or reject.');
}

async function promoteToDaily(ctx, chain, payload) {
  let slot = payload.scheduled_for;
  if (slot !== undefined && slot !== null) {
    slot = String(slot);
    if (!isDay(slot)) return err('bad_day', 'scheduled_for must be YYYY-MM-DD.', 400);
    /* Never today or earlier, even by hand. Today's chain may already be half
       played by people east of UTC, and swapping it under them mid-puzzle is
       the one failure the schedule has to avoid. */
    if (slot <= utcDay(ctx.now)) {
      return err('day_gone', 'That day has started. Schedule from tomorrow.', 400);
    }
    const taken = await first(ctx.db,
      'SELECT id FROM chains WHERE scheduled_for = ? AND id != ?', slot, chain.id);
    if (taken) return err('slot_taken', 'Another chain already has that day.', 409);
  } else {
    slot = await pickFreeSlot(ctx);
    if (!slot) {
      return err('no_free_slot',
        'Every day in the next ' + SCHEDULE_HORIZON + ' is already scheduled.', 409);
    }
  }

  const writes = [
    stmt(ctx.db,
      `UPDATE chains SET status = 'approved', pool = 'daily', scheduled_for = ?,
                         decided_at = ?, decided_by = 'admin', flag = NULL
        WHERE id = ?`, slot, ctx.now, chain.id),
  ];
  if (chain.author_id) {
    writes.push(noticeStatement(ctx.db, {
      userId: chain.author_id,
      kind: 'chain_accepted',
      body: 'Your chain is going out as a daily puzzle on ' + slot + '.',
      link: '/wordchain/',
      now: ctx.now,
    }));
  }
  await ctx.db.batch(writes);
  return ok({ id: chain.id, status: 'approved', pool: 'daily', scheduled_for: slot });
}

/* The free slots start tomorrow, for the reason given in promoteToDaily. */
async function pickFreeSlot(ctx) {
  const today = utcDay(ctx.now);
  const days = [];
  for (let i = 1; i <= SCHEDULE_HORIZON; i++) days.push(shiftDay(today, i));

  const ph = days.map(() => '?').join(',');
  const taken = await all(ctx.db,
    `SELECT scheduled_for FROM chains WHERE scheduled_for IN (${ph})`, ...days);
  const used = new Set(taken.map((t) => t.scheduled_for));
  const free = days.filter((d) => !used.has(d));
  if (!free.length) return null;

  /* crypto.getRandomValues, not Math.random. Not because the schedule is a
     secret worth defending, but because using the weaker one anywhere teaches
     the next reader that it is fine to use here too. */
  return free[crypto.getRandomValues(new Uint32Array(1))[0] % free.length];
}

async function promoteToPractice(ctx, chain) {
  const writes = [
    stmt(ctx.db,
      `UPDATE chains SET status = 'approved', pool = 'practice', scheduled_for = NULL,
                         decided_at = ?, decided_by = 'admin'
        WHERE id = ?`, ctx.now, chain.id),
  ];
  if (chain.author_id) {
    writes.push(noticeStatement(ctx.db, {
      userId: chain.author_id,
      kind: 'chain_accepted',
      body: 'Your chain has been added to the practice pool.',
      link: '/wordchain/',
      now: ctx.now,
    }));
  }
  await ctx.db.batch(writes);
  return ok({ id: chain.id, status: 'approved', pool: 'practice' });
}

/* Rejection.

   A plain reject sets the status and stops. A reject with a `reason` -- which
   is how a content rejection arrives -- also writes an incident and adds a
   strike. The incident copies the words and the author rather than referencing
   the chain, because the whole point of that table is that it survives the
   chain and the account both (spec §5).

   No notice is written either way. SUBMISSION-PIPELINE.md §4: the author is
   told only that the chain was not accepted, and the queue listing is where
   they find that out. */
async function rejectChain(ctx, chain, payload) {
  const reason = payload.reason ? cleanDisplayName(payload.reason, 200) : null;
  const isContent = !!reason;

  const writes = [
    stmt(ctx.db,
      `UPDATE chains SET status = ?, pool = NULL, scheduled_for = NULL,
                         decided_at = ?, decided_by = 'admin', flag = ?
        WHERE id = ?`,
      isContent ? 'blocked' : 'rejected', ctx.now, reason, chain.id),
  ];

  if (isContent) {
    writes.push(stmt(ctx.db,
      'INSERT INTO incidents (id, chain_id, author_id, words, reason, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId('inc'), chain.id, chain.author_id, chain.words, reason,
      payload.detail ? String(payload.detail).slice(0, 1000) : null, ctx.now));
    if (chain.author_id) {
      writes.push(stmt(ctx.db,
        'UPDATE users SET strikes = strikes + 1 WHERE id = ?', chain.author_id));
    }
  }

  await ctx.db.batch(writes);
  return ok({ id: chain.id, status: isContent ? 'blocked' : 'rejected', incident: isContent });
}

/* GET /api/admin/incidents

   Ordered newest first, but grouped by author in the payload, because the
   question this page answers is "is this a repeat submitter" and a flat log
   buries that. */
export async function incidents(ctx) {
  const rows = await all(ctx.db,
    `SELECT i.id, i.chain_id, i.author_id, i.words, i.reason, i.detail, i.at,
            u.display_name, u.handle, u.strikes, u.blocked_at
       FROM incidents i LEFT JOIN users u ON u.id = i.author_id
      ORDER BY i.at DESC LIMIT 200`);

  return ok({
    incidents: rows.map((r) => {
      let words = [];
      try { const v = JSON.parse(r.words); if (Array.isArray(v)) words = v; } catch { /* keep [] */ }
      return {
        id: r.id,
        chain_id: r.chain_id,
        words,
        reason: r.reason,
        detail: r.detail,
        at: r.at,
        /* author is null once the account is deleted -- the words and the
           reason survive, the identity does not. */
        author: r.author_id
          ? {
            id: r.author_id,
            name: r.display_name || r.handle || '',
            strikes: r.strikes || 0,
            blocked: r.blocked_at != null,
          }
          : null,
      };
    }),
  });
}

/* POST /api/admin/users/:id/block

   blocked_at stops chain submission and nothing else. A blocked player can
   still play both games, keep their streak and see their friends, because the
   thing being sanctioned is what they submitted, not that they exist.
   SUBMISSION-PIPELINE.md's strike ladder -- one a note, two blocks submitting,
   three blocks the account -- is counted by users.strikes and applied here by a
   human, because the ladder is a guideline and the last rung is not something
   to automate. */
export async function blockUser(ctx) {
  const body = await readJson(ctx.req);
  const payload = body.value && typeof body.value === 'object' ? body.value : {};
  const unblock = payload.unblock === true;

  const target = await first(ctx.db, 'SELECT id, blocked_at FROM users WHERE id = ?', ctx.params.id);
  if (!target) return ERRORS.notFound('No such player.');

  await run(ctx.db, 'UPDATE users SET blocked_at = ? WHERE id = ?',
    unblock ? null : ctx.now, target.id);
  return ok({ id: target.id, blocked: !unblock });
}
