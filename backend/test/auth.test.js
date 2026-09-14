/* Sign-in: the email code path, its failure modes, and the rate limiter. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0 } from './helpers/harness.js';

test('a full email sign-in: start, verify, cookie, session', async () => {
  const h = makeEnv();

  const start = await call(h.env, 'POST', '/api/auth/email/start',
    { body: { email: 'Kai@Example.com' } });
  assert.equal(start.status, 200);
  assert.deepEqual(start.data, { sent: true });

  /* The address is normalised before the mail goes out, so a player who
     capitalised it in the form still gets one account. */
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, 'kai@example.com');
  assert.match(h.sent[0].code, /^[0-9]{6}$/);

  /* Only the hash is stored, and it is not the bare code. */
  const row = h.db.one('SELECT code_hash, attempts, consumed_at FROM login_codes');
  assert.equal(row.attempts, 0);
  assert.equal(row.consumed_at, null);
  assert.notEqual(row.code_hash, h.sent[0].code);
  assert.equal(row.code_hash.length, 64);

  const verify = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: h.sent[0].code } });
  assert.equal(verify.status, 200);
  assert.ok(verify.data.user.id.startsWith('u_'));
  assert.equal(verify.data.user.email, 'kai@example.com');
  assert.equal(verify.data.user.email_verified, true);

  const cookieHeader = verify.setCookies.find((c) => c.startsWith('ps_session='));
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /Secure/);
  assert.match(cookieHeader, /SameSite=Lax/);
  assert.match(cookieHeader, /Path=\//);

  /* The session row holds the hash of the cookie value, never the value. */
  const value = cookieHeader.slice('ps_session='.length).split(';')[0];
  const stored = h.db.one('SELECT id, user_id, expires_at FROM sessions');
  assert.notEqual(stored.id, value);
  assert.equal(stored.id.length, 64);
  assert.ok(stored.expires_at - T0 > 300 * 86400, 'session lasts about a year');

  const session = await call(h.env, 'GET', '/api/auth/session', { cookie: verify.cookie });
  assert.equal(session.status, 200);
  assert.equal(session.data.user.id, verify.data.user.id);

  /* And without the cookie it is null, not an error. */
  const anon = await call(h.env, 'GET', '/api/auth/session');
  assert.equal(anon.status, 200);
  assert.equal(anon.data.user, null);
});

test('signing in twice lands on the same account', async () => {
  const h = makeEnv();
  const a = await signIn(h, 'kai@example.com');
  const b = await signIn(h, 'kai@example.com');
  assert.equal(a.user.id, b.user.id);
  assert.notEqual(a.cookie, b.cookie, 'a second sign-in is a second session');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 1);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM identities').n, 1);
});

test('start says sent:true for an address with no account', async () => {
  const h = makeEnv();
  const res = await call(h.env, 'POST', '/api/auth/email/start',
    { body: { email: 'nobody@example.com' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { sent: true });
  /* Lazily created: no user row exists until somebody proves they read the
     mail, which is what stops this endpoint being an existence oracle. */
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
});

test('a wrong code is refused and counted', async () => {
  const h = makeEnv();
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@example.com' } });
  const real = h.sent[0].code;
  const wrong = real === '000000' ? '111111' : '000000';

  const res = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: wrong } });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, 'bad_code');
  assert.equal(res.cookie, null);
  assert.equal(h.db.one('SELECT attempts FROM login_codes').attempts, 1);

  /* The right code still works afterwards. */
  const good = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: real } });
  assert.equal(good.status, 200);
});

test('an expired code is refused', async () => {
  const h = makeEnv();
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@example.com' } });
  const code = h.sent[0].code;

  h.setNow(T0 + 11 * 60);   /* ten-minute expiry, so eleven minutes is past it */

  const res = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code } });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, 'bad_code');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
});

test('a code is single use', async () => {
  const h = makeEnv();
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@example.com' } });
  const code = h.sent[0].code;

  const first = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code } });
  assert.equal(first.status, 200);

  const replay = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code } });
  assert.equal(replay.status, 400);
  assert.equal(replay.error.code, 'bad_code');
});

test('five wrong attempts burn the code, and the sixth finds nothing', async () => {
  const h = makeEnv();
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@example.com' } });
  const real = h.sent[0].code;

  /* Six distinct wrong codes, none of them the real one. */
  const wrongs = [];
  for (let i = 0; wrongs.length < 6; i++) {
    const w = String(i).padStart(6, '0');
    if (w !== real) wrongs.push(w);
  }

  for (let i = 0; i < 5; i++) {
    const res = await call(h.env, 'POST', '/api/auth/email/verify',
      { body: { email: 'kai@example.com', code: wrongs[i] } });
    assert.equal(res.status, 400, 'attempt ' + (i + 1));
  }

  const burned = h.db.one('SELECT attempts, consumed_at FROM login_codes');
  assert.equal(burned.attempts, 5);
  assert.ok(burned.consumed_at !== null, 'the code is burned on the fifth wrong attempt');

  const sixth = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: wrongs[5] } });
  assert.equal(sixth.status, 400);
  assert.equal(sixth.error.code, 'bad_code');

  /* And the real code is dead too -- burning it means burning it. */
  const late = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: real } });
  assert.equal(late.status, 400);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
});

test('the seventh code request in an hour is blocked', async () => {
  const h = makeEnv();
  for (let i = 1; i <= 6; i++) {
    const res = await call(h.env, 'POST', '/api/auth/email/start',
      { body: { email: 'kai@example.com' } });
    assert.equal(res.status, 200, 'request ' + i);
  }
  assert.equal(h.sent.length, 6);

  const seventh = await call(h.env, 'POST', '/api/auth/email/start',
    { body: { email: 'kai@example.com' } });
  assert.equal(seventh.status, 429);
  assert.equal(seventh.error.code, 'rate_limited');
  assert.ok(Number(seventh.res.headers.get('retry-after')) > 0);
  assert.equal(h.sent.length, 6, 'no mail went out for the blocked request');

  /* A different address is a different bucket. */
  const other = await call(h.env, 'POST', '/api/auth/email/start',
    { body: { email: 'someone@example.com' } });
  assert.equal(other.status, 200);

  /* And the window lapses. */
  h.setNow(T0 + 3601);
  const later = await call(h.env, 'POST', '/api/auth/email/start',
    { body: { email: 'kai@example.com' } });
  assert.equal(later.status, 200);
});

test('a new code burns the one before it', async () => {
  const h = makeEnv();
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@example.com' } });
  const firstCode = h.sent[0].code;
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@example.com' } });
  const secondCode = h.sent[1].code;

  const stale = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: firstCode } });
  assert.equal(stale.status, 400, 'the superseded code no longer works');

  const fresh = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@example.com', code: secondCode } });
  assert.equal(fresh.status, 200);
});

test('logout revokes the session and clears the cookie', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  const out = await call(h.env, 'POST', '/api/auth/logout', { cookie: me.cookie });
  assert.equal(out.status, 200);
  assert.ok(out.setCookies.some((c) => /^ps_session=;/.test(c) && /Max-Age=0/.test(c)));

  const after = await call(h.env, 'GET', '/api/auth/session', { cookie: me.cookie });
  assert.equal(after.data.user, null, 'the revoked cookie no longer resolves');
});

test('devices list and revoke, scoped to the caller', async () => {
  const h = makeEnv();
  const a1 = await signIn(h, 'kai@example.com');
  const a2 = await signIn(h, 'kai@example.com');
  const other = await signIn(h, 'someone@example.com');

  const list = await call(h.env, 'GET', '/api/auth/devices', { cookie: a2.cookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.devices.length, 2);
  assert.equal(list.data.devices.filter((d) => d.current).length, 1);

  const theirs = await call(h.env, 'GET', '/api/auth/devices', { cookie: other.cookie });
  const stranger = theirs.data.devices[0].id;

  /* Another account's session id is not revocable, and reports not found
     rather than forbidden, so it cannot be used to test whether one exists. */
  const refused = await call(h.env, 'DELETE', '/api/auth/devices/' + stranger,
    { cookie: a2.cookie });
  assert.equal(refused.status, 404);

  const target = list.data.devices.find((d) => !d.current).id;
  const gone = await call(h.env, 'DELETE', '/api/auth/devices/' + target, { cookie: a2.cookie });
  assert.equal(gone.status, 200);
  assert.equal(gone.data.signed_out, false);

  const stale = await call(h.env, 'GET', '/api/auth/session', { cookie: a1.cookie });
  assert.equal(stale.data.user, null);
});

test('a session slides only when it is more than a day stale', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  const before = h.db.one('SELECT last_used_at, expires_at FROM sessions');

  h.setNow(T0 + 3600);
  await call(h.env, 'GET', '/api/auth/session', { cookie: me.cookie });
  const sameDay = h.db.one('SELECT last_used_at, expires_at FROM sessions');
  assert.deepEqual(sameDay, before, 'an hour later is not worth a write');

  h.setNow(T0 + 2 * 86400);
  await call(h.env, 'GET', '/api/auth/session', { cookie: me.cookie });
  const later = h.db.one('SELECT last_used_at, expires_at FROM sessions');
  assert.equal(later.last_used_at, T0 + 2 * 86400);
  assert.ok(later.expires_at > before.expires_at, 'and the expiry slid forward');
});

test('unknown endpoints and wrong verbs are told apart', async () => {
  const h = makeEnv();
  const missing = await call(h.env, 'GET', '/api/nope');
  assert.equal(missing.status, 404);
  const wrongVerb = await call(h.env, 'GET', '/api/auth/logout');
  assert.equal(wrongVerb.status, 405);
});

test('an internal failure returns an envelope with no stack trace', async () => {
  const h = makeEnv();
  /* Break the binding in a way no handler guards against. */
  h.env.DB = {
    prepare() { throw new Error('secret internal detail at /home/someone/src/index.js:42'); },
  };
  const res = await call(h.env, 'GET', '/api/auth/session', { cookie: 'ps_session=whatever' });
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'internal');
  assert.equal(res.body.error.message, 'Something went wrong.');
  assert.equal(JSON.stringify(res.body).includes('/home/someone'), false);
});

test('health needs nothing, and CORS is granted only to allowed origins', async () => {
  const h = makeEnv({ vars: { ALLOWED_ORIGINS: 'http://localhost:8788' } });

  const health = await call(h.env, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');

  const allowed = await call(h.env, 'GET', '/api/auth/session',
    { headers: { origin: 'http://localhost:8788' } });
  assert.equal(allowed.res.headers.get('access-control-allow-origin'), 'http://localhost:8788');
  assert.equal(allowed.res.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(allowed.res.headers.get('vary'), 'Origin');

  const stranger = await call(h.env, 'GET', '/api/auth/session',
    { headers: { origin: 'https://evil.example' } });
  assert.equal(stranger.res.headers.get('access-control-allow-origin'), null);
  /* Vary is set either way: without it a cache could hand the allowed-origin
     response to a request from a different one. */
  assert.equal(stranger.res.headers.get('vary'), 'Origin');

  const pre = await call(h.env, 'OPTIONS', '/api/play/result',
    { raw: true, headers: { origin: 'http://localhost:8788' } });
  assert.equal(pre.status, 204);
  assert.match(pre.res.headers.get('access-control-allow-methods'), /POST/);
});

test('a response never carries a cacheable header', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  const res = await call(h.env, 'GET', '/api/player/me', { cookie: me.cookie });
  assert.equal(res.res.headers.get('cache-control'), 'no-store');
});
