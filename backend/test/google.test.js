/* Google sign-in: PKCE, the state cookie, and ID token verification.

   Google cannot be reached from a test, so two things are stubbed: the token
   endpoint (via deps.fetchImpl) and the JWKS (via deps.googleJwks). Everything
   else is the real path -- the same googleStart, the same googleCallback, the
   same verifyJwt doing the same signature, issuer, audience and expiry checks.

   The ID tokens here are signed with an RSA key pair the test generates, and
   the matching public key is what the stubbed JWKS returns. That makes the
   signature check real: a token signed with the wrong key, or altered after
   signing, fails here for exactly the reason it would fail against Google. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, T0, ORIGIN } from './helpers/harness.js';

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    pair,
    jwks: { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid }] },
    kid,
  };
}

async function signToken(key, claims, { kid = key.kid } = {}) {
  const header = b64urlJson({ alg: 'RS256', kid, typ: 'JWT' });
  const payload = b64urlJson(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.pair.privateKey,
    new TextEncoder().encode(header + '.' + payload));
  return header + '.' + payload + '.' + b64url(sig);
}

function claims(over = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '108127441234567890123',
    email: 'kai@gmail.com',
    email_verified: true,
    name: 'Kai',
    iat: T0 - 30,
    exp: T0 + 3600,
    ...over,
  };
}

/* Drive the whole flow: start, capture the state cookie, then call back with a
   token the test signed itself. */
async function roundTrip(h, token, { state, cookie } = {}) {
  const start = await call(h.env, 'GET', '/api/auth/google/start', { raw: true });
  assert.equal(start.status, 302);

  const location = new URL(start.res.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge'));
  assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), ORIGIN + '/api/auth/google/callback');

  const oauthCookie = start.setCookies.find((c) => c.startsWith('ps_oauth='));
  assert.ok(oauthCookie, 'the state cookie is set');
  assert.match(oauthCookie, /HttpOnly/);
  assert.match(oauthCookie, /SameSite=Lax/);

  const sent = state !== undefined ? state : location.searchParams.get('state');
  const jar = cookie !== undefined ? cookie : oauthCookie.split(';')[0];

  h.env.DEPS.fetchImpl = async () => new Response(JSON.stringify({ id_token: token }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  return await call(h.env, 'GET',
    '/api/auth/google/callback?code=auth-code-from-google&state=' + encodeURIComponent(sent || ''),
    { raw: true, headers: jar ? { cookie: jar } : {} });
}

test('a valid Google round trip signs the player in', async () => {
  const key = await makeKeyPair('kid-1');
  const h = makeEnv({ jwks: key.jwks });

  const res = await roundTrip(h, await signToken(key, claims()));
  assert.equal(res.status, 302);
  assert.equal(res.res.headers.get('location'), ORIGIN + '/');
  assert.ok(res.cookie, 'a session cookie was set');
  /* And the one-shot state cookie is cleared on the way out. */
  assert.ok(res.setCookies.some((c) => c.startsWith('ps_oauth=;')));

  const user = h.db.one('SELECT id, email, email_verified, display_name FROM users');
  assert.equal(user.email, 'kai@gmail.com');
  assert.equal(user.email_verified, 1);
  assert.equal(user.display_name, 'Kai');

  const identity = h.db.one('SELECT provider, subject FROM identities');
  assert.equal(identity.provider, 'google');
  assert.equal(identity.subject, '108127441234567890123');

  const session = await call(h.env, 'GET', '/api/auth/session', { cookie: res.cookie });
  assert.equal(session.data.user.email, 'kai@gmail.com');
});

test('a token signed with the wrong key is refused', async () => {
  const real = await makeKeyPair('kid-1');
  const impostor = await makeKeyPair('kid-1');
  const h = makeEnv({ jwks: real.jwks });

  const res = await roundTrip(h, await signToken(impostor, claims()));
  assert.equal(res.status, 302);
  assert.match(res.res.headers.get('location'), /signin_error=token_invalid/);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
});

test('an altered payload is refused even though the shape is right', async () => {
  const key = await makeKeyPair('kid-1');
  const h = makeEnv({ jwks: key.jwks });

  const token = await signToken(key, claims());
  const [header, , sig] = token.split('.');
  const swapped = header + '.' + b64urlJson(claims({ sub: 'somebody-else' })) + '.' + sig;

  const res = await roundTrip(h, swapped);
  assert.match(res.res.headers.get('location'), /signin_error=token_invalid/);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
});

test('the wrong audience, the wrong issuer and an expired token are all refused', async () => {
  const key = await makeKeyPair('kid-1');

  for (const over of [
    { aud: 'someone-elses-client-id' },
    { iss: 'https://accounts.evil.example' },
    { exp: T0 - 120 },
  ]) {
    const h = makeEnv({ jwks: key.jwks });
    const res = await roundTrip(h, await signToken(key, claims(over)));
    assert.match(res.res.headers.get('location'), /signin_error=token_invalid/,
      JSON.stringify(over));
    assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
  }
});

test('a mismatched state is refused, and so is a missing cookie', async () => {
  const key = await makeKeyPair('kid-1');

  const h1 = makeEnv({ jwks: key.jwks });
  const wrongState = await roundTrip(h1, await signToken(key, claims()),
    { state: 'not-the-state-we-issued' });
  assert.match(wrongState.res.headers.get('location'), /signin_error=state_mismatch/);

  const h2 = makeEnv({ jwks: key.jwks });
  const noCookie = await roundTrip(h2, await signToken(key, claims()), { cookie: null });
  assert.match(noCookie.res.headers.get('location'), /signin_error=state_missing/);

  const h3 = makeEnv({ jwks: key.jwks });
  const forged = await roundTrip(h3, await signToken(key, claims()),
    { cookie: 'ps_oauth=' + btoa('{}') + '.notavalidsignature' });
  assert.match(forged.res.headers.get('location'), /signin_error=state_bad/);
});

test('google and email sign-in land on the same account for one verified address', async () => {
  const key = await makeKeyPair('kid-1');
  const h = makeEnv({ jwks: key.jwks });

  /* Email first. */
  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@gmail.com' } });
  const verified = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@gmail.com', code: h.sent[0].code } });
  const userId = verified.data.user.id;

  /* Then Google, with the same verified address. */
  const res = await roundTrip(h, await signToken(key, claims()));
  assert.equal(res.status, 302);

  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 1);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM identities').n, 2);
  const session = await call(h.env, 'GET', '/api/auth/session', { cookie: res.cookie });
  assert.equal(session.data.user.id, userId);
});

test('an unverified Google address does not link to an existing account', async () => {
  const key = await makeKeyPair('kid-1');
  const h = makeEnv({ jwks: key.jwks });

  await call(h.env, 'POST', '/api/auth/email/start', { body: { email: 'kai@gmail.com' } });
  const verified = await call(h.env, 'POST', '/api/auth/email/verify',
    { body: { email: 'kai@gmail.com', code: h.sent[0].code } });

  const res = await roundTrip(h, await signToken(key, claims({ email_verified: false })));
  assert.equal(res.status, 302);

  /* Two accounts, not one. Linking on an unverified address would be a
     takeover primitive. */
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 2);
  const session = await call(h.env, 'GET', '/api/auth/session', { cookie: res.cookie });
  assert.notEqual(session.data.user.id, verified.data.user.id);
  assert.equal(session.data.user.email, null);
});

test('google start refuses an off-site next parameter', async () => {
  const h = makeEnv();
  const res = await call(h.env, 'GET', '/api/auth/google/start?next=https://evil.example/steal',
    { raw: true });
  const state = new URL(res.res.headers.get('location')).searchParams.get('state');
  assert.ok(state);
  /* The rejected value never reaches the redirect; the callback will send the
     browser to APP_ORIGIN and nowhere else. That is asserted by the happy-path
     test above, which lands on ORIGIN + '/'. */
  const cookie = res.setCookies.find((c) => c.startsWith('ps_oauth='));
  const packed = cookie.slice('ps_oauth='.length).split(';')[0].split('.')[0];
  const stash = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8'));
  assert.equal(stash.n, '/');
});

test('google sign-in is unavailable rather than broken when unconfigured', async () => {
  const h = makeEnv({ vars: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
  const res = await call(h.env, 'GET', '/api/auth/google/start');
  assert.equal(res.status, 503);
  assert.equal(res.error.code, 'google_unconfigured');
});
