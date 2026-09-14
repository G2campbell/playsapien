/* Chain submissions, the daily bank, and the admin review queue.

   Cloudflare Access is stubbed the same way Google is: the test generates a key
   pair, signs an assertion with it, and hands the matching JWKS to the stub, so
   the verification path under test is the real one. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, DAY, utcDay } from './helpers/harness.js';

const TEAM = 'playsapien.cloudflareaccess.test';
const AUD = 'aud-tag-for-the-admin-app';
const CHAIN = ['FIRE', 'PLACE', 'MAT', 'BLACK', 'BOARD', 'WALK', 'WAY', 'SIDE'];

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessSetup() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwks = { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', kid: 'access-1' }] };

  const sign = async (claims) => {
    const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const head = enc({ alg: 'RS256', kid: 'access-1', typ: 'JWT' });
    const body = enc(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
      new TextEncoder().encode(head + '.' + body));
    return head + '.' + body + '.' + b64url(sig);
  };

  const token = await sign({
    iss: 'https://' + TEAM, aud: AUD, email: 'admin@example.com',
    sub: 'admin-1', iat: T0 - 60, exp: T0 + 3600,
  });

  return { jwks, token, sign };
}

function adminEnv(access) {
  return makeEnv({
    vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
    accessJwks: access.jwks,
  });
}

const adminHeaders = (access) => ({ 'cf-access-jwt-assertion': access.token });

test('a chain is queued as pending and shows in the author list', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  const res = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: me.cookie, body: { words: CHAIN, credit: true } });
  assert.equal(res.status, 201);
  assert.equal(res.data.status, 'pending');

  const row = h.db.one('SELECT author_id, words, status, pool, words_hash FROM chains');
  assert.equal(row.author_id, me.user.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.pool, null, 'nothing reaches a pool without a human');
  assert.equal(row.words_hash.length, 64);
  assert.deepEqual(JSON.parse(row.words), CHAIN);

  const mine = await call(h.env, 'GET', '/api/wordchain/chains/mine', { cookie: me.cookie });
  assert.equal(mine.data.chains.length, 1);
  assert.equal(mine.data.chains[0].status, 'pending');
});

test('the same chain twice is one row', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  await call(h.env, 'POST', '/api/wordchain/chains', { cookie: me.cookie, body: { words: CHAIN } });

  /* Lowercased and padded: the same chain by any reading. */
  const again = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: me.cookie, body: { words: CHAIN.map((w) => ' ' + w.toLowerCase() + ' ') } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_submitted');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM chains').n, 1);

  /* Somebody else's identical chain is refused without saying it exists. */
  const other = await signIn(h, 'ama@example.com');
  const theirs = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: other.cookie, body: { words: CHAIN } });
  assert.equal(theirs.status, 409);
  assert.equal(theirs.body.error.code, 'duplicate_chain');
  assert.equal(theirs.body.data, null);
});

test('five chains a day, then the sixth is refused', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  const suffix = 'ABCDEFGHIJ';
  const chainN = (n) => CHAIN.slice(0, 7).concat(['TAIL' + suffix[n]]);

  for (let i = 0; i < 5; i++) {
    const res = await call(h.env, 'POST', '/api/wordchain/chains',
      { cookie: me.cookie, body: { words: chainN(i) } });
    assert.equal(res.status, 201, 'chain ' + (i + 1) + ': ' + JSON.stringify(res.body));
  }
  const sixth = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: me.cookie, body: { words: chainN(9) } });
  assert.equal(sixth.status, 429);
});

test('a malformed chain is refused', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  for (const words of [
    ['ONE', 'TWO'],                          /* too short */
    CHAIN.concat(['A', 'B', 'C', 'D', 'E']), /* too long */
    ['FIRE', 'PLACE', 'MAT', 'FIRE', 'BOARD', 'WALK', 'WAY', 'SIDE'],  /* a repeat */
    ['FIRE', 'PLACE', 'MAT', 'BLACK 2', 'BOARD', 'WALK', 'WAY', 'SIDE'],
    'not an array',
  ]) {
    const res = await call(h.env, 'POST', '/api/wordchain/chains',
      { cookie: me.cookie, body: { words } });
    assert.equal(res.status, 400, JSON.stringify(words));
  }
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM chains').n, 0);
});

test("a blocked author's chain never leaves the queue, and they are not told", async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  h.db.raw.prepare('UPDATE users SET blocked_at = ? WHERE id = ?').run(T0, me.user.id);

  const res = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: me.cookie, body: { words: CHAIN } });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'pending', 'the response is indistinguishable');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM chains').n, 0, 'and nothing was written');
});

test('admin promotes a chain to daily, schedules it, and the bank serves it', async () => {
  const access = await accessSetup();
  const h = adminEnv(access);
  const author = await signIn(h, 'kai@example.com');

  const submitted = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: author.cookie, body: { words: CHAIN } });
  const chainId = submitted.data.id;

  const queue = await call(h.env, 'GET', '/api/admin/queue', { headers: adminHeaders(access) });
  assert.equal(queue.status, 200);
  assert.equal(queue.data.pending.length, 1);
  assert.equal(queue.data.pending[0].author.name, '');

  const tomorrow = utcDay(T0 + DAY);
  const decided = await call(h.env, 'POST', '/api/admin/chains/' + chainId, {
    headers: adminHeaders(access),
    body: { action: 'daily', scheduled_for: tomorrow },
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.scheduled_for, tomorrow);

  /* The author is told, by notice. */
  const notices = await call(h.env, 'GET', '/api/player/notices', { cookie: author.cookie });
  assert.equal(notices.data.notices[0].kind, 'chain_accepted');

  /* A second chain cannot take the same slot. */
  const second = await call(h.env, 'POST', '/api/wordchain/chains', {
    cookie: author.cookie, body: { words: CHAIN.slice(0, 7).concat(['OTHER']) },
  });
  const clash = await call(h.env, 'POST', '/api/admin/chains/' + second.data.id, {
    headers: adminHeaders(access),
    body: { action: 'daily', scheduled_for: tomorrow },
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.error.code, 'slot_taken');

  /* Tomorrow's chain is not served today: the schedule is not a public list. */
  const early = await call(h.env, 'GET', '/api/wordchain/bank/' + tomorrow);
  assert.equal(early.status, 404);

  h.setNow(T0 + DAY);
  const bank = await call(h.env, 'GET', '/api/wordchain/bank/' + tomorrow);
  assert.equal(bank.status, 200);
  assert.deepEqual(bank.data.chain.words, CHAIN);
  assert.equal(bank.data.chain.author, null, 'no display name has been set yet');
});

test('an unscheduled daily approval picks a free slot in the next ten days', async () => {
  const access = await accessSetup();
  const h = adminEnv(access);
  const author = await signIn(h, 'kai@example.com');
  const submitted = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: author.cookie, body: { words: CHAIN } });

  const res = await call(h.env, 'POST', '/api/admin/chains/' + submitted.data.id,
    { headers: adminHeaders(access), body: { action: 'daily' } });
  assert.equal(res.status, 200);

  const slot = res.data.scheduled_for;
  assert.ok(slot > utcDay(T0), 'never today, which may already be half played');
  assert.ok(slot <= utcDay(T0 + 10 * DAY));
});

test('a content rejection writes an incident and a strike, and tells the author nothing', async () => {
  const access = await accessSetup();
  const h = adminEnv(access);
  const author = await signIn(h, 'kai@example.com');
  const submitted = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: author.cookie, body: { words: CHAIN } });

  const res = await call(h.env, 'POST', '/api/admin/chains/' + submitted.data.id, {
    headers: adminHeaders(access),
    body: { action: 'reject', reason: 'slur spelled by the sequence' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.incident, true);

  const incident = h.db.one('SELECT author_id, words, reason FROM incidents');
  assert.equal(incident.author_id, author.user.id);
  assert.deepEqual(JSON.parse(incident.words), CHAIN);
  assert.equal(h.db.one('SELECT strikes FROM users WHERE id = ?', author.user.id).strikes, 1);

  /* The author sees 'rejected' and not a word of why. */
  const mine = await call(h.env, 'GET', '/api/wordchain/chains/mine', { cookie: author.cookie });
  assert.equal(mine.data.chains[0].status, 'rejected');
  assert.equal(JSON.stringify(mine.body).includes('slur'), false);

  const notices = await call(h.env, 'GET', '/api/player/notices', { cookie: author.cookie });
  assert.equal(notices.data.unread, 0);

  const list = await call(h.env, 'GET', '/api/admin/incidents', { headers: adminHeaders(access) });
  assert.equal(list.data.incidents.length, 1);
  assert.equal(list.data.incidents[0].author.strikes, 1);
});

test('blocking an author stops submissions and nothing else', async () => {
  const access = await accessSetup();
  const h = adminEnv(access);
  const author = await signIn(h, 'kai@example.com');

  const blocked = await call(h.env, 'POST', '/api/admin/users/' + author.user.id + '/block',
    { headers: adminHeaders(access), body: {} });
  assert.equal(blocked.status, 200);

  /* They can still play. */
  const played = await call(h.env, 'POST', '/api/play/result', {
    cookie: author.cookie,
    body: { game: 'sojourner', day: utcDay(T0), mode: 'daily', score: 500, max_score: 1000 },
  });
  assert.equal(played.status, 201);

  const unblocked = await call(h.env, 'POST', '/api/admin/users/' + author.user.id + '/block',
    { headers: adminHeaders(access), body: { unblock: true } });
  assert.equal(unblocked.data.blocked, false);
});

test('the admin surface is closed without a valid Access assertion', async () => {
  const access = await accessSetup();

  /* Unconfigured: 503, and it does nothing rather than falling open. */
  const open = makeEnv();
  const unconfigured = await call(open.env, 'GET', '/api/admin/queue');
  assert.equal(unconfigured.status, 503);

  const h = adminEnv(access);
  assert.equal((await call(h.env, 'GET', '/api/admin/queue')).status, 403);
  assert.equal((await call(h.env, 'GET', '/api/admin/queue',
    { headers: { 'cf-access-jwt-assertion': 'not.a.jwt' } })).status, 403);

  /* A well-formed assertion for a different Access application. */
  const wrongAud = await access.sign({
    iss: 'https://' + TEAM, aud: 'some-other-app', email: 'admin@example.com',
    iat: T0 - 60, exp: T0 + 3600,
  });
  assert.equal((await call(h.env, 'GET', '/api/admin/queue',
    { headers: { 'cf-access-jwt-assertion': wrongAud } })).status, 403);

  /* And a player's own session is not an admin credential. */
  const player = await signIn(h, 'kai@example.com');
  assert.equal((await call(h.env, 'GET', '/api/admin/queue', { cookie: player.cookie })).status, 403);
});

test('profile edits: handle uniqueness, avatar shape, display name cleanup', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  const set = await call(h.env, 'PATCH', '/api/player/me', {
    cookie: kai.cookie,
    body: { handle: 'Kai_G2', display_name: '   Kai   Campbell  ', avatar: 'nyansapo-3', tz: 'Africa/Accra' },
  });
  assert.equal(set.status, 200);
  assert.equal(set.data.user.handle, 'kai_g2', 'handles are folded to lowercase');
  assert.equal(set.data.user.display_name, 'Kai Campbell');
  assert.equal(set.data.user.tz, 'Africa/Accra');

  const taken = await call(h.env, 'PATCH', '/api/player/me',
    { cookie: ama.cookie, body: { handle: 'kai_g2' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.error.code, 'handle_taken');

  for (const body of [
    { handle: 'no' }, { handle: 'has spaces' }, { avatar: 'https://evil.example/x.png' },
    { tz: 'not a zone; drop table' },
  ]) {
    const res = await call(h.env, 'PATCH', '/api/player/me', { cookie: ama.cookie, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('a daily slot in the past or today is refused', async () => {
  const access = await accessSetup();
  const h = adminEnv(access);
  const author = await signIn(h, 'kai@example.com');
  const submitted = await call(h.env, 'POST', '/api/wordchain/chains',
    { cookie: author.cookie, body: { words: CHAIN } });

  for (const slot of [utcDay(T0), utcDay(T0 - DAY), 'not-a-day']) {
    const res = await call(h.env, 'POST', '/api/admin/chains/' + submitted.data.id,
      { headers: adminHeaders(access), body: { action: 'daily', scheduled_for: slot } });
    assert.equal(res.status, 400, slot);
  }
  assert.equal(h.db.one('SELECT status, scheduled_for FROM chains').status, 'pending');
});
