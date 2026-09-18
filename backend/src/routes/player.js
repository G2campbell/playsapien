/* The player: profile, the claim/merge, notices.

   The interesting function in here is claimDevices. Everything else is CRUD. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { first, all, run, stmt, isUniqueViolation } from '../lib/db.js';
import { newId } from '../lib/id.js';
import {
  asObject, cleanDisplayName, isHandle, isDeviceId, stringList, utcDay, GAMES,
} from '../lib/validate.js';
import { streakStatements, emptyStreak, PLATFORM } from '../lib/streaks.js';
import { clearedCookie } from '../middleware/session.js';
import { shapeUser } from './auth.js';

/* GET /api/player/me -> profile + all streaks */
export async function me(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  /* ctx.user comes from the session lookup, which deliberately leaves
     avatar_img out because that row is read on every single request. This is
     the one endpoint that needs the picture -- it is what the profile screen
     draws -- so it is fetched here, once, rather than carried everywhere. */
  const img = await first(ctx.db, 'SELECT avatar_img FROM users WHERE id = ?', ctx.user.id);
  return ok({
    user: { ...ctx.user, avatar_img: (img && img.avatar_img) || null },
    streaks: await readStreaks(ctx.db, ctx.user.id),
    today: utcDay(ctx.now),
  });
}

export async function readStreaks(db, userId) {
  const rows = await all(db,
    'SELECT game, current, longest, last_day, played, total_score FROM streaks WHERE user_id = ?',
    userId);
  const byGame = new Map(rows.map((r) => [r.game, r]));
  /* Every known game appears, played or not. A client rendering a profile
     should not have to know which games exist to decide what to show a zero
     for, and a missing row and a zeroed row mean the same thing. */
  const out = [...GAMES, PLATFORM].map((g) => byGame.get(g) || emptyStreak(g));
  return out;
}

/* PATCH /api/player/me  { handle?, display_name?, avatar?, avatar_img?, plan?, tz? } */
export async function updateMe(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send a JSON object.');
  const patch = asObject(body.value);

  const sets = [], params = [];

  if ('handle' in patch) {
    const h = String(patch.handle == null ? '' : patch.handle).trim().toLowerCase();
    if (h === '') {
      sets.push('handle = NULL');
    } else {
      if (!isHandle(h)) {
        return err('invalid_handle',
          'A handle is 3 to 20 characters, lowercase letters, numbers and underscores.', 400);
      }
      sets.push('handle = ?'); params.push(h);
    }
  }

  if ('display_name' in patch) {
    sets.push('display_name = ?'); params.push(cleanDisplayName(patch.display_name));
  }

  if ('avatar' in patch) {
    /* A token like 'nyansapo-3', never a URL (spec §3). Storing a URL would
       mean every profile render is an outbound request to somewhere the player
       chose, which is a tracking pixel with extra steps. */
    const a = patch.avatar == null ? null : String(patch.avatar).trim();
    if (a !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(a)) {
      return err('invalid_avatar', 'That is not an avatar token.', 400);
    }
    sets.push('avatar = ?'); params.push(a || null);
  }

  if ('avatar_img' in patch) {
    /* The picture itself, not a pointer to one -- see migrations/0002. The
       browser has already cropped and downscaled; this checks that what
       arrived is what was promised and is small enough to sit in a row.

       The regex is strict on purpose. It admits three raster types and base64
       only, which rules out data:image/svg+xml -- an SVG is a document that
       can carry script, and this string is rendered by other parts of the app.
       No svg, no html, no plain text pretending to be an image. */
    const v = patch.avatar_img == null ? null : String(patch.avatar_img);
    if (v !== null && v !== '') {
      if (v.length > 24000) {
        return err('avatar_too_large', 'That picture is too big. Try a smaller one.', 413);
      }
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) {
        return err('invalid_avatar_img', 'That is not an image this can store.', 400);
      }
    }
    sets.push('avatar_img = ?'); params.push(v || null);
  }

  if ('plan' in patch) {
    /* Entitlement, not payment. Nothing charges for either value yet, so this
       is simply the player's choice -- but it is written server-side so it
       survives a new device and a game can read it. When billing exists this
       endpoint must STOP accepting plan from the client: an upgrade will come
       from the payment provider's webhook, and a downgrade at the end of a
       paid period, neither of which is a PATCH from a browser. */
    const p = String(patch.plan == null ? '' : patch.plan).trim().toLowerCase();
    if (p !== 'free' && p !== 'sapien') {
      return err('invalid_plan', 'That is not an account type.', 400);
    }
    sets.push('plan = ?', 'plan_since = ?'); params.push(p, ctx.now);
  }

  if ('tz' in patch) {
    /* Advisory only -- days are UTC everywhere (spec §5). It is stored so the
       client can say "your streak ends in four hours" without guessing, and it
       is validated only for shape because the list of IANA zones changes. */
    const tz = patch.tz == null ? null : String(patch.tz).trim();
    if (tz !== null && !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) {
      return err('invalid_tz', 'That is not a time zone name.', 400);
    }
    sets.push('tz = ?'); params.push(tz || null);
  }

  if (!sets.length) return ERRORS.invalid('Nothing to change.');

  try {
    await run(ctx.db, 'UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', ...params, ctx.user.id);
  } catch (e) {
    if (isUniqueViolation(e)) return err('handle_taken', 'That handle is already in use.', 409);
    throw e;
  }

  const row = await first(ctx.db,
    `SELECT id, handle, display_name, email, email_verified, avatar,
            avatar_img, plan, plan_since, created_at,
            tz, strikes, blocked_at FROM users WHERE id = ?`, ctx.user.id);
  return ok({ user: shapeUser(row) });
}

/* POST /api/player/claim  { device_ids: [] } -> merge, recompute

   Spec §2, the upgrade path. A player with a forty-day streak on their phone
   signs in on their laptop, and the laptop has a different device_id and no
   history. The rule is union, then recompute: take both sets of days, keep the
   higher score where they collide, then derive the streak from the merged set
   rather than trusting either side's stored number.

   Three properties this has to have, and each one shapes the code below.

   It has to be atomic. Half a merge -- some days re-parented, streaks not
   recomputed -- is a player whose profile is visibly wrong, and the only fix is
   another claim they have no reason to make. Everything goes in one db.batch(),
   which D1 runs as one transaction.

   It has to be idempotent. The client sends every device_id it has ever seen on
   every sign-in, because it cannot know which ones the server already has.
   Running it twice must produce the same rows as running it once.

   It must not be able to steal. A device_id already claimed by somebody else is
   skipped silently. The ids are UUIDs the client minted, so guessing one is not
   a realistic attack, but "not realistic" is not the same as "handled". */
export async function claimDevices(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { device_ids: [...] }.');

  const wanted = stringList(asObject(body.value).device_ids, { max: 25, test: isDeviceId });
  if (!wanted.length) return ERRORS.invalid('No device ids to claim.');

  const placeholders = wanted.map(() => '?').join(',');
  const known = await all(ctx.db,
    `SELECT id, user_id FROM devices WHERE id IN (${placeholders})`, ...wanted);
  const ownerOf = new Map(known.map((d) => [d.id, d.user_id]));

  /* Claimable: unknown to us (first sight), or already ours (a repeat claim),
     never someone else's. */
  const claimable = wanted.filter((id) => {
    const owner = ownerOf.get(id);
    return owner == null || owner === ctx.user.id;
  });
  const refused = wanted.filter((id) => !claimable.includes(id));
  if (!claimable.length) return ok({ claimed: [], refused, merged: 0, replaced: 0 });

  const writes = [];
  for (const id of claimable) {
    if (ownerOf.has(id)) {
      writes.push(stmt(ctx.db,
        'UPDATE devices SET user_id = ?, claimed_at = ? WHERE id = ?', ctx.user.id, ctx.now, id));
    } else {
      writes.push(stmt(ctx.db,
        'INSERT INTO devices (id, user_id, created_at, claimed_at) VALUES (?, ?, ?, ?)',
        id, ctx.user.id, ctx.now, ctx.now));
    }
  }

  /* The results to re-parent: everything on those devices that is not already
     attributed to a user. A row that already has a user_id belongs to somebody
     -- possibly this player from an earlier claim -- and is left alone. */
  const cp = claimable.map(() => '?').join(',');
  const orphans = await all(ctx.db,
    `SELECT id, game, day, mode, score FROM results
      WHERE device_id IN (${cp}) AND user_id IS NULL
      ORDER BY day ASC`, ...claimable);

  let merged = 0, replaced = 0;
  const touchedDays = new Set();

  if (orphans.length) {
    const keyOf = (r) => r.game + '|' + r.day + '|' + r.mode;

    /* Two devices can both hold the same day -- that is the whole point of the
       merge -- so the orphans are reduced to one candidate per key before
       anything is written. Doing it in this pass rather than in the loop below
       means a losing orphan is never adopted and then deleted a moment later,
       which would be both a wasted write and a deletion the player did not ask
       for. Ties keep the earlier row, because the earlier row is the one the
       "first write wins" rule already blessed. */
    const best = new Map();
    for (const o of orphans) {
      const k = keyOf(o);
      const held = best.get(k);
      if (!held || o.score > held.score) best.set(k, o);
    }

    /* One query for every day that could collide, rather than one per orphan.
       A forty-day history is forty round trips otherwise, and D1 charges for
       each of them. */
    const mine = await all(ctx.db,
      `SELECT id, game, day, mode, score FROM results
        WHERE user_id = ? AND day >= ? AND day <= ?`,
      ctx.user.id, orphans[0].day, orphans[orphans.length - 1].day);
    const existing = new Map(mine.map((r) => [keyOf(r), r]));

    for (const o of best.values()) {
      const clash = existing.get(keyOf(o));

      if (!clash) {
        writes.push(stmt(ctx.db, 'UPDATE results SET user_id = ? WHERE id = ?', ctx.user.id, o.id));
        merged++;
        touchedDays.add(o.day);
        continue;
      }

      if (o.score > clash.score) {
        /* The higher score wins, and the whole row travels with it: the
           account's row is deleted and the device's adopted, rather than the
           score being copied across. Copying would leave the detail, the
           duration and the timestamp belonging to a different attempt, and a
           share card built from that is a lie.

           This DELETE is the one irreversible thing the merge does, and it is
           unavoidable -- the unique index on (user_id, game, day, mode) allows
           exactly one row per key, so keeping both is not an option the schema
           offers. Order matters inside the batch: the DELETE has to land before
           the UPDATE or the index rejects the adoption. */
        writes.push(stmt(ctx.db, 'DELETE FROM results WHERE id = ?', clash.id));
        writes.push(stmt(ctx.db, 'UPDATE results SET user_id = ? WHERE id = ?', ctx.user.id, o.id));
        replaced++;
        touchedDays.add(o.day);
      }
      /* Lower or equal: the orphan loses and is left exactly as it is, with
         user_id still null. Not deleted -- it is invisible to every query that
         goes by user_id, so deleting buys nothing, and leaving it makes a
         repeat claim a no-op rather than a second decision. */
    }
  }

  /* The recompute reads the union that the writes above have not yet applied,
     so it cannot simply run after them -- inside one batch there is no "after".
     Instead the statements are built from the state as it will be: the reads in
     streakStatements() see the pre-batch rows, which is wrong by exactly the
     rows we are about to move.

     So the merge is two batches, not one. The first moves the rows; the second
     recomputes from what is now there. That is a deliberate step back from
     perfect atomicity: a failure between them leaves the rows merged and the
     streak stale, which the next result submission silently repairs, because
     streaks are derived and every write recomputes them. The alternative -- one
     batch computing streaks from a state that does not exist yet -- would leave
     a wrong number that nothing repairs. */
  if (writes.length) await ctx.db.batch(writes);
  await ctx.db.batch(await streakStatements(ctx.db, ctx.user.id, utcDay(ctx.now)));

  return ok({
    claimed: claimable,
    refused,
    merged,
    replaced,
    days: [...touchedDays].sort(),
    streaks: await readStreaks(ctx.db, ctx.user.id),
  });
}

/* DELETE /api/player/me -> delete account + data

   The foreign keys do the work: results, streaks, friendships, invite codes,
   notices, identities and sessions all cascade from users.id. Two tables
   deliberately do not follow.

   incidents keeps the words and the reason with a nulled author (ON DELETE SET
   NULL). Spec §5 is explicit about why: that table exists to make a pattern
   visible across submissions, and it fails at that if a rejected submitter can
   erase it by deleting their account. The privacy policy says so out loud
   rather than this happening quietly.

   chains does the same, for a different reason: an approved chain may already
   be scheduled as somebody's daily puzzle, and deleting an account should not
   remove a puzzle from the bank. The byline goes; the chain stays. */
export async function deleteMe(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();

  await ctx.db.batch([
    /* Sessions are revoked before the row goes, so that a request already in
       flight on another device cannot slip through on a cached read. */
    stmt(ctx.db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      ctx.now, ctx.user.id),
    /* Devices keep existing -- they are browser-side ids and the browser still
       has them -- but they stop pointing at a user that is about to vanish. */
    stmt(ctx.db, 'UPDATE devices SET user_id = NULL, claimed_at = NULL WHERE user_id = ?',
      ctx.user.id),
    stmt(ctx.db, 'DELETE FROM users WHERE id = ?', ctx.user.id),
  ]);

  return ok({ deleted: true }, { cookies: [clearedCookie()] });
}

/* GET /api/player/notices -> unread notices */
export async function listNotices(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const includeRead = ctx.url.searchParams.get('all') === '1';
  const rows = await all(ctx.db,
    `SELECT id, kind, body, link, created_at, read_at FROM notices
      WHERE user_id = ?` + (includeRead ? '' : ' AND read_at IS NULL') +
    ' ORDER BY created_at DESC LIMIT 50', ctx.user.id);
  const unread = await first(ctx.db,
    'SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL', ctx.user.id);
  return ok({ notices: rows, unread: unread ? unread.n : 0 });
}

/* POST /api/player/notices/read  { ids: [] } */
export async function readNotices(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { ids: [...] }.');
  const ids = stringList(asObject(body.value).ids, { max: 100 });
  if (!ids.length) return ok({ marked: 0 });

  const ph = ids.map(() => '?').join(',');
  const res = await run(ctx.db,
    `UPDATE notices SET read_at = ?
      WHERE user_id = ? AND read_at IS NULL AND id IN (${ph})`,
    ctx.now, ctx.user.id, ...ids);
  return ok({ marked: res && res.meta ? res.meta.changes : 0 });
}

/* Used by the friends and chain routes. Notices are the only push this platform
   has -- the client reads them on open (SUBMISSION-PIPELINE.md §7) -- so
   anything a player needs to find out about while they were away writes one. */
export function noticeStatement(db, { userId, kind, body, link, now }) {
  return stmt(db,
    'INSERT INTO notices (id, user_id, kind, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId('n'), userId, kind, body, link || null, now);
}
