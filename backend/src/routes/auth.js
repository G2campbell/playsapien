/* Authentication: email codes, Google, and session management.

   Spec §1 settles the design and this file implements it without revisiting it.
   Two things are worth having in mind while reading:

   The code IS the credential, and the link carries the same six digits. That is
   the whole answer to the wrong-browser problem -- a player who lands in a mail
   app's in-app browser reads the digits and types them into the tab they
   already have open, and the link is a convenience for desktop rather than the
   only path.

   Nothing in here tells the caller whether an address has an account. Not the
   start endpoint, not the verify endpoint, not a timing difference big enough
   to read over the internet. The user row is created lazily, on the first
   successful verify, so "does this address exist" is a question the API has no
   opinion on until someone proves they can read the mail. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { effectivePlan } from '../lib/plan.js';
import { first, run, all, isUniqueViolation, MINUTE } from '../lib/db.js';
import { newId } from '../lib/id.js';
import {
  sha256Hex, timingSafeEqual, randomSixDigits, randomBytes, base64url,
  hmacSign, hmacVerify, pkceVerifier, pkceChallenge, verifyJwt,
} from '../lib/crypto.js';
import {
  normaliseEmail, isEmail, isSixDigits, cleanDisplayName, utcDay,
} from '../lib/validate.js';
import { consume } from '../middleware/ratelimit.js';
import { createSession, clearedCookie, revokeSession } from '../middleware/session.js';

/* Ten minutes, single use, five attempts then burned. Spec §1. Five is enough
   for a misread digit and a fat-fingered retry; a million-space code with five
   guesses is a one in two hundred thousand chance of a blind hit, and the
   per-IP limit in §5 caps how many of those anyone gets. */
export const CODE_TTL = 10 * MINUTE;
export const MAX_ATTEMPTS = 5;

/* ================================================================= email */

/* POST /api/auth/email/start  { email } -> { sent: true }

   Always { sent: true }. Always. A rate-limited caller gets 429, because that
   is about the caller and not about the address, but every other outcome --
   unknown address, mail provider down, no API key configured -- reports sent.
   Anything else turns this endpoint into an account-existence oracle. */
export async function emailStart(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send a JSON body with an email address.');

  const email = normaliseEmail(body.value && body.value.email);
  /* A malformed address is refused rather than absorbed. It cannot belong to
     anyone, so refusing it reveals nothing, and absorbing it would mean typos
     silently consume the sender's hourly allowance. */
  if (!isEmail(email)) return err('invalid_email', 'That does not look like an email address.', 400);

  /* Before the hash, before the insert, before the mail. Spec §5: limits go in
     front of expensive work, and everything after this line is expensive. */
  const gate = await consume(ctx.db, 'signin', email, ctx.now);
  if (!gate.allowed) {
    return ERRORS.rateLimited(gate.retryAfter,
      'Too many sign-in codes for that address. Try again in about an hour.');
  }

  const code = randomSixDigits();
  const codeHash = await sha256Hex(code + ctx.env.LOGIN_CODE_PEPPER);

  /* Any code still outstanding for this address is burned first. Without this,
     six starts leave six live codes and the attempt counter is effectively
     thirty guesses rather than five. */
  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE login_codes SET consumed_at = ?
        WHERE email = ? AND purpose = 'signin' AND consumed_at IS NULL`)
      .bind(ctx.now, email),
    ctx.db.prepare(
      `INSERT INTO login_codes (id, email, code_hash, purpose, attempts, created_at, expires_at)
       VALUES (?, ?, ?, 'signin', 0, ?, ?)`)
      .bind(newId('lc'), email, codeHash, ctx.now, ctx.now + CODE_TTL),
  ]);

  /* A send failure is logged and swallowed. The player sees the same response
     either way and retries; the log is where the operator finds out. */
  try {
    await ctx.deps.sendLoginCode({ to: email, code, ttlMinutes: CODE_TTL / 60 });
  } catch (e) {
    console.error('[auth] sign-in mail failed for a recipient: ' + (e && e.message));
  }

  return ok({ sent: true });
}

/* POST /api/auth/email/verify  { email, code } -> sets cookie, { user } */
export async function emailVerify(ctx) {
  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send a JSON body with an email and a code.');

  const email = normaliseEmail(body.value && body.value.email);
  const code = String((body.value && body.value.code) || '').replace(/[\s-]/g, '');

  const gate = await consume(ctx.db, 'verify', ctx.ip || 'unknown', ctx.now);
  if (!gate.allowed) {
    return ERRORS.rateLimited(gate.retryAfter, 'Too many attempts. Try again in about an hour.');
  }

  /* Shape checks after the rate limit, not before: a flood of malformed
     requests should still consume the attacker's budget. */
  if (!isEmail(email) || !isSixDigits(code)) return badCode();

  const row = await first(ctx.db,
    `SELECT id, code_hash, attempts, expires_at, consumed_at
       FROM login_codes
      WHERE email = ? AND purpose = 'signin' AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`, email);

  /* No code, expired, or already spent: one response for all three. Telling
     someone their code expired is friendlier and tells an attacker that the
     address was sent one. */
  if (!row || row.expires_at <= ctx.now) return badCode();

  if (row.attempts >= MAX_ATTEMPTS) {
    await run(ctx.db, 'UPDATE login_codes SET consumed_at = ? WHERE id = ?', ctx.now, row.id);
    return badCode();
  }

  const given = await sha256Hex(code + ctx.env.LOGIN_CODE_PEPPER);
  if (!timingSafeEqual(given, row.code_hash)) {
    const attempts = row.attempts + 1;
    /* The burn happens on the write that takes attempts to five, not on the
       sixth request. A player who has used all five attempts has no live code
       left, so the sixth is refused because there is nothing to check -- which
       is the same refusal as a wrong code, and looks identical from outside. */
    await run(ctx.db,
      'UPDATE login_codes SET attempts = ?, consumed_at = ? WHERE id = ?',
      attempts, attempts >= MAX_ATTEMPTS ? ctx.now : null, row.id);
    return badCode();
  }

  /* Single use: consumed before the session exists, so a replay of the same
     request cannot produce a second session even if the rest of this handler
     fails. */
  await run(ctx.db, 'UPDATE login_codes SET attempts = ?, consumed_at = ? WHERE id = ?',
    row.attempts + 1, ctx.now, row.id);

  const user = await upsertUserForIdentity(ctx, {
    provider: 'email',
    subject: email,
    email,
    emailVerified: true,
  });

  return await signIn(ctx, user);
}

function badCode() {
  return err('bad_code', 'That code is not right, or it has expired. Ask for a new one.', 400);
}

/* ================================================================= google */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/* The PKCE verifier and the CSRF state both have to survive a round trip
   through Google and come back, and the Worker has nowhere to put them -- it is
   stateless and a D1 row for a ten-minute handshake is a table of litter. They
   go in a short-lived cookie instead, signed with a Worker secret so the
   browser cannot forge one.

   Signed, not encrypted. The contents are not secret from the user whose
   browser they are in: the state is a nonce and the verifier is only useful to
   whoever also holds the authorisation code, which is this Worker. What matters
   is that neither can be *chosen* by an attacker, and a signature settles
   that. */
const OAUTH_COOKIE = 'ps_oauth';
const OAUTH_TTL = 10 * MINUTE;

function oauthCookie(value, maxAge) {
  /* SameSite=Lax: the callback is a top-level GET navigation from Google, which
     Lax permits and Strict would not. Path is /api/auth/google so it is not
     attached to anything else. */
  return OAUTH_COOKIE + '=' + value +
    '; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=' + maxAge;
}

function clearedOauthCookie() {
  return OAUTH_COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=0';
}

/* GET /api/auth/google/start -> 302 to Google */
export async function googleStart(ctx) {
  if (!ctx.env.GOOGLE_CLIENT_ID || !ctx.env.GOOGLE_CLIENT_SECRET) {
    return err('google_unconfigured', 'Google sign-in is not set up on this deployment.', 503);
  }

  const state = base64url(randomBytes(24));
  const verifier = pkceVerifier();
  const challenge = await pkceChallenge(verifier);

  /* Where to send the browser afterwards. Only a path is accepted, and it is
     resolved against APP_ORIGIN at the end -- an open redirect here would let
     someone hand out a playsapien.com sign-in link that lands on their own
     site with the player's guard down. */
  const rawNext = ctx.url.searchParams.get('next') || '/';
  const next = /^\/(?!\/)[^\s]*$/.test(rawNext) ? rawNext : '/';

  const payload = JSON.stringify({ s: state, v: verifier, n: next, e: ctx.now + OAUTH_TTL });
  const packed = base64url(new TextEncoder().encode(payload));
  const signature = await hmacSign(ctx.env.OAUTH_STATE_SECRET, packed);

  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set('client_id', ctx.env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', googleRedirectUri(ctx.env));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  /* Ask for an account picker rather than silently reusing whichever Google
     account the browser happens to be signed into. Players with a work and a
     personal account do exist and a silent pick strands them on the wrong one. */
  u.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      location: u.toString(),
      'set-cookie': oauthCookie(packed + '.' + signature, OAUTH_TTL),
      'cache-control': 'no-store',
    },
  });
}

export function googleRedirectUri(env) {
  return String(env.APP_ORIGIN || '').replace(/\/$/, '') + '/api/auth/google/callback';
}

/* GET /api/auth/google/callback -> sets cookie, 302 home */
export async function googleCallback(ctx) {
  const home = String(ctx.env.APP_ORIGIN || '').replace(/\/$/, '') || '/';
  const bail = (reason) => new Response(null, {
    status: 302,
    headers: {
      /* The player is a browser mid-navigation, so the failure has to be a
         redirect with a reason the shell can read, not a JSON error. The reason
         is a fixed token, never anything derived from the query string. */
      location: home + '/?signin_error=' + reason,
      'set-cookie': clearedOauthCookie(),
      'cache-control': 'no-store',
    },
  });

  const cookies = parseCookieHeader(ctx.req.headers.get('cookie'));
  const packed = cookies[OAUTH_COOKIE];
  if (!packed) return bail('state_missing');

  const dot = packed.lastIndexOf('.');
  if (dot < 1) return bail('state_malformed');
  const body = packed.slice(0, dot), signature = packed.slice(dot + 1);
  if (!(await hmacVerify(ctx.env.OAUTH_STATE_SECRET, body, signature))) return bail('state_bad');

  let stash;
  try { stash = JSON.parse(new TextDecoder().decode(base64urlToBytesLocal(body))); }
  catch { return bail('state_malformed'); }
  if (!stash || stash.e <= ctx.now) return bail('state_expired');

  /* The CSRF check. The state in the URL was chosen by whoever started the
     flow; the state in the cookie was chosen by this Worker and is bound to
     this browser. If they differ, the authorisation code arriving is not the
     one this browser asked for. */
  const returned = ctx.url.searchParams.get('state');
  if (!returned || !timingSafeEqual(returned, stash.s)) return bail('state_mismatch');

  if (ctx.url.searchParams.get('error')) return bail('declined');
  const code = ctx.url.searchParams.get('code');
  if (!code) return bail('no_code');

  let tokens;
  try {
    const res = await ctx.deps.fetchImpl(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: ctx.env.GOOGLE_CLIENT_ID,
        client_secret: ctx.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(ctx.env),
        grant_type: 'authorization_code',
        code_verifier: stash.v,
      }).toString(),
    });
    if (!res.ok) throw new Error('token endpoint ' + res.status);
    tokens = await res.json();
  } catch (e) {
    console.error('[auth] google token exchange failed: ' + (e && e.message));
    return bail('exchange_failed');
  }

  if (!tokens || !tokens.id_token) return bail('no_id_token');

  /* The ID token is verified, not decoded. A JWT read without checking its
     signature is a string an attacker wrote: it arrives over a channel we do
     not control end to end, and "it came from the token endpoint" is an
     argument, not a proof. Signature against Google's JWKS, then iss, aud and
     exp, and only then are the claims worth anything. */
  let claims;
  try {
    const jwks = await ctx.deps.googleJwks();
    claims = await verifyJwt(tokens.id_token, jwks, {
      issuers: GOOGLE_ISSUERS,
      audience: ctx.env.GOOGLE_CLIENT_ID,
      now: ctx.now,
    });
  } catch (e) {
    console.error('[auth] google id_token rejected: ' + (e && e.message));
    return bail('token_invalid');
  }

  if (!claims.sub) return bail('token_invalid');

  const user = await upsertUserForIdentity(ctx, {
    provider: 'google',
    subject: claims.sub,
    /* email_verified from Google is respected rather than assumed. A Google
       Workspace account can carry an unverified address, and treating it as
       verified would let someone take over a PlaySapien account keyed to that
       address without ever reading its mail. */
    email: claims.email_verified === true ? normaliseEmail(claims.email) : null,
    emailVerified: claims.email_verified === true,
    displayName: cleanDisplayName(claims.name || claims.given_name || ''),
  });

  const created = await createSession(ctx.db, user.id, {
    now: ctx.now, ua: ctx.req.headers.get('user-agent'), ipCc: ctx.ipCc,
  });

  const target = home + (stash.n && stash.n !== '/' ? stash.n : '/');
  const headers = new Headers({ location: target, 'cache-control': 'no-store' });
  headers.append('set-cookie', created.cookie);
  headers.append('set-cookie', clearedOauthCookie());
  return new Response(null, { status: 302, headers });
}

/* Local copies, so this module does not import the cookie parser twice under
   two names or reach into crypto.js for one decode. */
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

function base64urlToBytesLocal(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ================================================================= shared */

/* Find or create the user behind a proven identity.

   The identity row is the key, not the email. A player who signs in with Google
   and later with the same address by code should land on one account, which is
   why the email is looked up as a fallback -- but only when the provider has
   actually verified it. Linking on an unverified address would be a takeover
   primitive.

   Ordering matters. The identity lookup comes first so that a returning player
   is one indexed read, and the email fallback only runs for a first-time
   identity. */
export async function upsertUserForIdentity(ctx, { provider, subject, email, emailVerified, displayName }) {
  const existing = await first(ctx.db,
    `SELECT u.id, u.handle, u.display_name, u.email, u.email_verified, u.avatar,
            u.avatar_img, u.plan, u.plan_since, u.plan_until,
            u.created_at, u.tz, u.strikes, u.blocked_at
       FROM identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ? AND i.subject = ? AND u.deleted_at IS NULL`, provider, subject);

  if (existing) {
    /* A returning player. Touch last_seen_at, and fill in anything that was
       blank -- a display name from Google, a verified email that was not
       previously set. Never overwrite something the player has chosen. */
    const patch = [];
    const params = [];
    if (email && !existing.email) { patch.push('email = ?', 'email_verified = ?'); params.push(email, emailVerified ? 1 : 0); }
    else if (emailVerified && existing.email === email && !existing.email_verified) { patch.push('email_verified = 1'); }
    if (displayName && !existing.display_name) { patch.push('display_name = ?'); params.push(displayName); }
    patch.push('last_seen_at = ?'); params.push(ctx.now);
    try {
      await run(ctx.db, 'UPDATE users SET ' + patch.join(', ') + ' WHERE id = ?', ...params, existing.id);
    } catch (e) {
      /* The only way this fails is the unique index on users.email, when the
         address is already on another account. Leaving the existing row
         untouched is the right outcome: the player is signed in either way and
         nothing has been merged behind their back. */
      if (!isUniqueViolation(e)) throw e;
    }
    return shapeUser(existing, ctx.now);
  }

  if (email && emailVerified) {
    const byEmail = await first(ctx.db,
      `SELECT id, handle, display_name, email, email_verified, avatar,
              avatar_img, plan, plan_since, plan_until, created_at,
              tz, strikes, blocked_at
         FROM users WHERE email = ? AND deleted_at IS NULL`, email);
    if (byEmail) {
      await ctx.db.batch([
        ctx.db.prepare(
          `INSERT INTO identities (id, user_id, provider, subject, created_at)
           VALUES (?, ?, ?, ?, ?)`)
          .bind(newId('id'), byEmail.id, provider, subject, ctx.now),
        ctx.db.prepare('UPDATE users SET email_verified = 1, last_seen_at = ? WHERE id = ?')
          .bind(ctx.now, byEmail.id),
      ]);
      return shapeUser(byEmail, ctx.now);
    }
  }

  /* Brand new. The user row and its identity are written together: a user with
     no identity is unreachable, and an identity with no user is a foreign key
     violation, so neither half is allowed to land alone. */
  const id = newId('u');
  const row = {
    id,
    handle: null,
    display_name: displayName || '',
    email: email || null,
    email_verified: emailVerified ? 1 : 0,
    avatar: null,
    avatar_img: null,
    plan: 'free',
    plan_since: null,
    plan_until: null,
    created_at: ctx.now,
    tz: null,
    strikes: 0,
    blocked_at: null,
  };
  await ctx.db.batch([
    ctx.db.prepare(
      `INSERT INTO users (id, handle, display_name, email, email_verified, avatar,
                          created_at, last_seen_at, tz, strikes)
       VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, NULL, 0)`)
      .bind(id, row.display_name, row.email, row.email_verified, ctx.now, ctx.now),
    ctx.db.prepare(
      `INSERT INTO identities (id, user_id, provider, subject, created_at)
       VALUES (?, ?, ?, ?, ?)`)
      .bind(newId('id'), id, provider, subject, ctx.now),
  ]);
  return shapeUser(row, ctx.now);
}

/* The SELF shape. Everything here is sent to the player about themselves, on
   /auth/session and /player/me and nowhere else. avatar_img is the reason that
   distinction matters: it is kilobytes, so it must never leak into a list of
   other people -- friends and leaderboards build their own, smaller shapes. */
export function shapeUser(row, now = Math.floor(Date.now() / 1000)) {
  /* `now` is passed by every caller that has a request context, so that the
     plan it reports agrees with the clock the rest of that request used --
     which matters in tests, and on the second a grant expires. */
  const plan = effectivePlan(row.plan, row.plan_until, now);
  return {
    id: row.id,
    handle: row.handle,
    display_name: row.display_name || '',
    email: row.email,
    email_verified: !!row.email_verified,
    avatar: row.avatar,
    avatar_img: row.avatar_img || null,
    plan,
    plan_since: row.plan_since || null,
    plan_until: plan === 'sapien' ? (row.plan_until || null) : null,
    created_at: row.created_at,
    tz: row.tz,
    strikes: row.strikes || 0,
    blocked: row.blocked_at != null,
  };
}

async function signIn(ctx, user) {
  const created = await createSession(ctx.db, user.id, {
    now: ctx.now, ua: ctx.req.headers.get('user-agent'), ipCc: ctx.ipCc,
  });
  return ok({ user }, { cookies: [created.cookie] });
}

/* ================================================================= session */

/* GET /api/auth/session -> { user } | { user: null }

   Never 401. "Are you signed in" is a question a signed-out client is entitled
   to ask, and answering it with an error makes every caller special-case a
   status code for the ordinary path. */
export async function sessionInfo(ctx) {
  /* ctx.user has no avatar_img -- the session lookup leaves it out because
     that row is read on every request. This endpoint is what a GAME calls to
     find out whose face to put in the bar, so it is one of the two places the
     picture has to come down. One extra read, on a call each surface makes
     once per load. */
  let user = ctx.user;
  if (user) {
    const img = await first(ctx.db, 'SELECT avatar_img FROM users WHERE id = ?', user.id);
    user = { ...user, avatar_img: (img && img.avatar_img) || null };
  }
  return ok({ user, today: utcDay(ctx.now) });
}

/* POST /api/auth/logout -> clears cookie */
export async function logout(ctx) {
  if (ctx.session) await revokeSession(ctx.db, ctx.session.id, ctx.now);
  /* The cookie is cleared whether or not there was a session to revoke. A
     client asking to be signed out should end up signed out, not told that it
     already was. */
  return ok({ ok: true }, { cookies: [clearedCookie()] });
}

/* GET /api/auth/devices -> active sessions */
export async function listDevices(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const rows = await all(ctx.db,
    `SELECT id, created_at, last_used_at, expires_at, ua, ip_cc
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_used_at DESC LIMIT 50`, ctx.user.id, ctx.now);

  return ok({
    devices: rows.map((r) => ({
      id: r.id,
      /* The row id is the hash of the cookie, so handing it out is safe: it
         cannot be turned back into a session value, and it is what the revoke
         endpoint takes. */
      current: ctx.session && r.id === ctx.session.id,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      expires_at: r.expires_at,
      ua: r.ua,
      country: r.ip_cc,
    })),
  });
}

/* DELETE /api/auth/devices/:id -> revoke one */
export async function revokeDevice(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const target = ctx.params.id;

  const res = await run(ctx.db,
    `UPDATE sessions SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ctx.now, target, ctx.user.id);

  /* Scoped to the caller's own user_id, so a guessed id from another account
     changes nothing and reports not found -- the same answer as an id that does
     not exist, which is what keeps it from being a probe. */
  const changed = res && res.meta ? res.meta.changes : 0;
  if (!changed) return ERRORS.notFound('No such session.');

  const revokedSelf = ctx.session && target === ctx.session.id;
  return ok({ revoked: target, signed_out: !!revokedSelf },
    revokedSelf ? { cookies: [clearedCookie()] } : undefined);
}

