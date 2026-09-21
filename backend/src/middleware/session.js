/* Sessions.

   The cookie value is 32 random bytes, base64url. What is stored in
   `sessions.id` is its SHA-256 and never the value itself, so a dump of the
   sessions table is not a pile of working credentials -- the same reasoning
   that puts a hash in a password column, applied to the thing that actually
   grants access here. No salt and no work factor, deliberately: a 256-bit
   random token has no dictionary to be attacked with, and a slow hash on the
   session lookup would tax every request to defend against nothing.

   Expiry is one year, sliding. Spec §1: sign-in is rare by design, roughly once
   per device ever, so the cookie has to outlive any plausible gap between
   visits or the whole "you sign in once" premise collapses.

   Sliding does NOT mean writing on every request. A player who opens the app
   forty times a day would otherwise generate forty writes for no information
   gain, and D1 writes are the expensive half. The row is touched only when it
   is more than a day stale, which keeps "your devices" accurate to the day --
   which is the granularity that screen displays anyway. */

import { effectivePlan } from '../lib/plan.js';
import { sha256Hex, randomBytes, base64url } from '../lib/crypto.js';
import { first, run, DAY, YEAR } from '../lib/db.js';

export const COOKIE_NAME = 'ps_session';

/* How stale last_used_at may get before a use rewrites it. */
const TOUCH_AFTER = DAY;

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;  // first wins
    out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/* Secure is unconditional. The API is only ever reached over https in every
   environment that matters, and `wrangler dev` on http://localhost is the one
   exception browsers already make for Secure cookies on localhost.

   SameSite=Lax rather than Strict because the Google OAuth callback is a
   top-level navigation arriving from accounts.google.com, and Strict would
   withhold the cookie on exactly that request. Lax still blocks the
   cross-site POST that matters. */
export function sessionCookie(value, maxAgeSec) {
  return COOKIE_NAME + '=' + value +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAgeSec;
}

export function clearedCookie() {
  return COOKIE_NAME + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

/* Create a session and return the cookie header to set. The caller gets the
   value exactly once, here; it is never readable again from anywhere. */
export async function createSession(db, userId, { now, ua, ipCc }) {
  const value = base64url(randomBytes(32));
  const id = await sha256Hex(value);
  await run(db,
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_used_at, ua, ip_cc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, userId, now, now + YEAR, now, truncateUa(ua), ipCc || null);
  return { value, id, cookie: sessionCookie(value, YEAR) };
}

/* The user agent is kept only so "your devices" can say "Chrome on a Mac"
   rather than nothing. 180 characters is more than enough for that and stops
   the column becoming a fingerprint store by accident. */
function truncateUa(ua) {
  return ua ? String(ua).slice(0, 180) : null;
}

/* Resolve the cookie on an incoming request.

   Returns { session, user } or { session: null, user: null }. A revoked,
   expired or unknown cookie is simply not a session -- no distinction is made
   to the caller and none is made in the response, because "that session was
   revoked" is information a stolen cookie's holder does not need.

   A soft-deleted user (users.deleted_at) is treated as no session at all. The
   cascade removes the rows on hard delete, but a soft delete has to be caught
   here or a still-valid cookie would keep working. */
export async function loadSession(db, request, now) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const value = cookies[COOKIE_NAME];
  if (!value) return { session: null, user: null };

  const id = await sha256Hex(value);
  const row = await first(db,
    `SELECT s.id AS sid, s.user_id, s.created_at AS s_created, s.expires_at,
            s.last_used_at, s.ua, s.ip_cc,
            u.handle, u.display_name, u.email, u.email_verified, u.avatar,
            u.plan, u.plan_since, u.plan_until,
            u.created_at AS u_created, u.tz, u.strikes, u.blocked_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND u.deleted_at IS NULL`, id);

  if (!row) return { session: null, user: null };
  if (row.expires_at <= now) return { session: null, user: null };

  /* Sliding renewal, at most once a day per session. Two writes, not one: the
     session row and users.last_seen_at, which is what the profile screen reads
     and what a future "dormant account" sweep would need. They are batched so a
     failure leaves neither half applied. */
  if (now - row.last_used_at > TOUCH_AFTER) {
    await db.batch([
      db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?')
        .bind(now, now + YEAR, id),
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, row.user_id),
    ]);
  }

  return {
    session: {
      id: row.sid,
      user_id: row.user_id,
      created_at: row.s_created,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      ua: row.ua,
      ip_cc: row.ip_cc,
    },
    user: {
      id: row.user_id,
      handle: row.handle,
      display_name: row.display_name,
      email: row.email,
      email_verified: !!row.email_verified,
      avatar: row.avatar,
      /* plan travels on every authenticated request because entitlement checks
         are cheap only if the answer is already here. avatar_img deliberately
         does NOT -- this row is read on EVERY request, and 8 KB of picture on
         each one to serve the handful that draw it is the wrong trade. It
         comes down on /player/me instead. */
      /* EFFECTIVE, not stored: an expired Sapien grant is free from the second
         it lapses, not from whenever the nightly job next runs. */
      plan: effectivePlan(row.plan, row.plan_until, now),
      plan_since: row.plan_since || null,
      plan_until: effectivePlan(row.plan, row.plan_until, now) === 'sapien'
        ? (row.plan_until || null) : null,
      created_at: row.u_created,
      tz: row.tz,
      strikes: row.strikes,
      blocked: row.blocked_at != null,
    },
  };
}

export function revokeSession(db, sessionId, now) {
  return run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    now, sessionId);
}

/* Used on account deletion and on a "sign out everywhere". Cheaper and clearer
   than deleting: a revoked row keeps the device listing honest for a while. */
export function revokeAllSessions(db, userId, now) {
  return run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    now, userId);
}
