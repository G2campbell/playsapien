/* The test harness: a fresh database, a stubbed environment, and a way to call
   the Worker's fetch handler the way Cloudflare would.

   Two things are stubbed, and they are the two things that reach the network
   and therefore cannot be exercised offline:

     sendLoginCode   the Resend call. The stub records what would have been
                     sent, including the six digits, which is how the sign-in
                     tests get hold of a code without reading mail.

     googleJwks      Google's key set. A real Google sign-in test would need
                     Google to sign a token, so instead the test signs one with
                     a key pair it generated and hands the matching JWKS to the
                     stub. The verification path under test is then the real
                     one -- verifyJwt, the same function, the same claim checks.

   The clock is injected too, so that "today" is a decision the test makes
   rather than whatever day it happens to be run on. Every rule in this API that
   involves time reads it through deps.now(). */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../../src/index.js';
import { makeDb } from './d1.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATION = join(here, '..', '..', 'migrations', '0001_init.sql');

export const ORIGIN = 'https://playsapien.test';

/* A fixed instant, so a test that says "yesterday" means the same thing in
   January as in June. 2026-09-14T12:00:00Z -- midday, so neither the
   today-or-yesterday window nor a streak walk is sitting on a boundary by
   accident. */
export const T0 = Math.floor(Date.parse('2026-09-14T12:00:00Z') / 1000);
export const DAY = 86400;

export function makeEnv(overrides = {}) {
  const db = makeDb(MIGRATION);
  const sent = [];
  let clock = overrides.now || T0;

  const env = {
    DB: db,
    APP_ORIGIN: ORIGIN,
    ALLOWED_ORIGINS: '',
    LOGIN_CODE_PEPPER: 'test-pepper-not-a-real-secret',
    OAUTH_STATE_SECRET: 'test-oauth-secret-not-a-real-secret',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    MAIL_FROM: 'PlaySapien <hello@playsapien.test>',
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    ...overrides.vars,

    DEPS: {
      now: () => clock,
      sendLoginCode: async (opts) => { sent.push(opts); return { sent: true }; },
      googleJwks: async () => overrides.jwks || { keys: [] },
      accessJwks: async () => overrides.accessJwks || { keys: [] },
      fetchImpl: overrides.fetchImpl || (async () => {
        throw new Error('a test reached the network; stub it in makeEnv');
      }),
      ...overrides.deps,
    },
  };

  return {
    env,
    db,
    sent,
    /* Move the clock. Days are UTC, so advancing by whole days lands on the
       same time of day and never straddles a boundary. */
    setNow: (t) => { clock = t; },
    advanceDays: (n) => { clock += n * DAY; return clock; },
    now: () => clock,
  };
}

/* Call the Worker. Returns { status, body, res, cookie } where `cookie` is the
   session cookie value if one was set, ready to hand to the next call. */
export async function call(env, method, path, { body, cookie, headers = {}, raw } = {}) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.headers.set('content-type', 'application/json');
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (cookie) init.headers.set('cookie', cookie);
  /* CF-Connecting-IP is what the rate limiter keys on for verify attempts, and
     the edge always sets it. A test that leaves it out shares one bucket with
     every other test in the file, which is a confusing way to fail. */
  if (!init.headers.has('cf-connecting-ip')) init.headers.set('cf-connecting-ip', '203.0.113.7');

  const res = await worker.fetch(new Request(ORIGIN + path, init), env, { waitUntil() {} });

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const session = setCookies.find((c) => c.startsWith('ps_session='));
  let sessionCookie = null;
  if (session) {
    const value = session.slice('ps_session='.length).split(';')[0];
    sessionCookie = value ? 'ps_session=' + value : null;
  }

  let parsed = null;
  if (!raw) {
    const text = await res.text();
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparseable: text }; }
  }

  return {
    status: res.status,
    body: parsed,
    data: parsed && parsed.ok ? parsed.data : null,
    error: parsed && parsed.ok === false ? parsed.error : null,
    res,
    setCookies,
    cookie: sessionCookie,
    /* An empty string means the cookie was explicitly cleared, which is a
       different assertion from "no cookie was set". */
    clearedCookie: !!session && sessionCookie === null,
  };
}

/* Sign a player in by email, end to end through the real endpoints, and return
   their session cookie. Used by every test that needs an account and is not
   itself testing sign-in. */
export async function signIn(h, email) {
  const start = await call(h.env, 'POST', '/api/auth/email/start', { body: { email } });
  if (start.status !== 200) throw new Error('start failed: ' + JSON.stringify(start.body));
  const last = h.sent[h.sent.length - 1];
  const verify = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email, code: last.code } });
  if (verify.status !== 200) throw new Error('verify failed: ' + JSON.stringify(verify.body));
  return { cookie: verify.cookie, user: verify.data.user };
}

export function utcDay(sec) {
  const d = new Date(sec * 1000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}
