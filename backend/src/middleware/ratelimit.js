/* Rate limiting, on D1.

   Spec §5 lists four limits and calls the auth ones not optional, for a reason
   worth repeating: an unthrottled /auth/email/start is a free way to send mail
   from playsapien.com to any address on earth, and a domain's sending
   reputation does not survive being used that way even once at volume.

   Cloudflare has a native rate-limiting binding, and it is better than this at
   what it does. It is not used here because its counters are per-colo and
   eventually consistent, which is fine for "stop a flood" and wrong for "six
   emails per address per hour" -- six colos would each allow six. The whole
   point of these limits is a hard, global, small number, and D1 is the only
   binding in this Worker that can count globally.

   The window is fixed, not sliding. A fixed window lets someone send six mails
   at 10:59 and six more at 11:01, which is twelve in two minutes. That is the
   known cost and it is acceptable: twelve is not a reputation problem, and a
   sliding window means either storing timestamps per key or two counters per
   key, for a refinement nothing here needs. */

import { first, HOUR, DAY } from '../lib/db.js';

/* The limits, verbatim from spec §5. Keeping them in one table rather than
   inline at each call site means the set can be read in ten seconds, which is
   what you want when deciding whether a limit is the thing breaking you. */
export const LIMITS = {
  /* "Six sign-in codes per email per hour." Keyed by address, not by IP: the
     resource being protected is the address's inbox and the domain's
     reputation, neither of which cares where the request came from. */
  signin: { limit: 6, window: HOUR, prefix: 'signin' },
  /* "Ten verify attempts per IP per hour." Keyed by IP because the attacker
     here is someone guessing codes across many addresses; the per-code attempt
     counter in login_codes.attempts handles the single-address case. */
  verify: { limit: 10, window: HOUR, prefix: 'verify' },
  /* "Five chain submissions per user per day." */
  chain: { limit: 5, window: DAY, prefix: 'chain' },
  /* "Thirty friend adds per user per day." */
  friend_add: { limit: 30, window: DAY, prefix: 'friendadd' },
  /* Promotion codes. Ten tries an hour per player: plenty for typos, far too
     few to guess a code by working through variations of a known one. */
  redeem: { limit: 10, window: HOUR, prefix: 'redeem' },
};

/* One statement, one round trip, and atomic.

   The obvious read-then-write version races: two requests that both read
   count = 5 both write 6 and both get through. SQLite's upsert settles it in a
   single statement, and because `window_at` is only moved forward when the old
   window has actually lapsed, a burst cannot keep pushing the window out in
   front of itself the way a naive "reset on every hit" would.

   RETURNING gives back the post-increment count, so the decision needs no
   second read. The counter is incremented even on a rejected request: it costs
   nothing, the window still expires on schedule, and it means a client hammering
   a blocked key does not get a free unblock by racing the boundary. */
export async function consume(db, kind, subject, now) {
  const spec = LIMITS[kind];
  if (!spec) throw new Error('ratelimit: unknown kind ' + kind);

  const key = spec.prefix + ':' + String(subject).toLowerCase();
  const windowStartedBefore = now - spec.window;

  const row = await first(db,
    `INSERT INTO rate_limits (key, count, window_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count     = CASE WHEN rate_limits.window_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_at = CASE WHEN rate_limits.window_at <= ? THEN ? ELSE rate_limits.window_at END
     RETURNING count, window_at`,
    key, now, windowStartedBefore, windowStartedBefore, now);

  const count = row ? row.count : 1;
  const windowAt = row ? row.window_at : now;
  const resetAt = windowAt + spec.window;

  return {
    allowed: count <= spec.limit,
    count,
    limit: spec.limit,
    resetAt,
    retryAfter: Math.max(1, resetAt - now),
  };
}

/* Read without incrementing. Used by nothing on the hot path -- it exists for
   the admin surface and for tests that want to assert a counter without
   disturbing it. */
export async function peek(db, kind, subject, now) {
  const spec = LIMITS[kind];
  const key = spec.prefix + ':' + String(subject).toLowerCase();
  const row = await first(db, 'SELECT count, window_at FROM rate_limits WHERE key = ?', key);
  if (!row || row.window_at <= now - spec.window) return { count: 0, limit: spec.limit };
  return { count: row.count, limit: spec.limit };
}

/* Housekeeping, called from the cron. Rows whose window lapsed long ago are
   dead weight; nothing reads them and the upsert would reset them anyway. */
export function sweep(db, now) {
  return db.prepare('DELETE FROM rate_limits WHERE window_at < ?').bind(now - 7 * DAY).run();
}
