/* Friendships, the a_id < b_id invariant, and the friends-only leaderboard. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, utcDay } from './helpers/harness.js';

const TODAY = utcDay(T0);

async function codeFor(h, cookie) {
  const res = await call(h.env, 'GET', '/api/player/friends/code', { cookie });
  assert.equal(res.status, 200);
  return res.data.code;
}

async function postScore(h, cookie, score, game = 'sojourner') {
  const res = await call(h.env, 'POST', '/api/play/result', {
    cookie,
    body: {
      game, day: TODAY, mode: 'daily', score,
      max_score: game === 'wordchain' ? 7 : 1000,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

test('request, accept, and the pair invariant holds either way round', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  const amaCode = await codeFor(h, ama.cookie);
  const request = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: amaCode } });
  assert.equal(request.status, 200);
  assert.equal(request.data.state, 'pending');

  /* One row, and a_id is the lexicographically smaller id whichever direction
     the request went. */
  const row = h.db.one('SELECT a_id, b_id, state, requested_by FROM friendships');
  const [lo, hi] = [kai.user.id, ama.user.id].sort();
  assert.equal(row.a_id, lo);
  assert.equal(row.b_id, hi);
  assert.ok(row.a_id < row.b_id);
  assert.equal(row.requested_by, kai.user.id);
  assert.equal(row.state, 'pending');

  /* The other side sees it as incoming, not outgoing. */
  const theirList = await call(h.env, 'GET', '/api/player/friends', { cookie: ama.cookie });
  assert.equal(theirList.data.incoming.length, 1);
  assert.equal(theirList.data.incoming[0].id, kai.user.id);
  assert.equal(theirList.data.outgoing.length, 0);

  const mine = await call(h.env, 'GET', '/api/player/friends', { cookie: kai.cookie });
  assert.equal(mine.data.outgoing.length, 1);
  assert.equal(mine.data.incoming.length, 0);

  const accepted = await call(h.env,
    'POST', '/api/player/friends/' + kai.user.id + '/accept', { cookie: ama.cookie });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.state, 'accepted');

  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM friendships').n, 1);
  assert.equal(h.db.one('SELECT state FROM friendships').state, 'accepted');

  for (const who of [kai, ama]) {
    const list = await call(h.env, 'GET', '/api/player/friends', { cookie: who.cookie });
    assert.equal(list.data.accepted.length, 1, 'both sides agree');
  }
});

test('the invariant holds when the request goes the other way', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  const kaiCode = await codeFor(h, kai.cookie);
  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: ama.cookie, body: { code: kaiCode } });

  const row = h.db.one('SELECT a_id, b_id, requested_by FROM friendships');
  assert.ok(row.a_id < row.b_id);
  assert.equal(row.requested_by, ama.user.id);
});

test('a duplicate request is rejected', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const amaCode = await codeFor(h, ama.cookie);

  const first = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: amaCode } });
  assert.equal(first.status, 200);

  const again = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: amaCode } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_requested');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM friendships').n, 1);

  /* And once accepted, adding again says so rather than reopening it. */
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept',
    { cookie: ama.cookie });
  const third = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: amaCode } });
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'already_friends');
});

test('adding someone who already asked accepts instead of asking back', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });

  /* Ama, not having noticed the request, pastes Kai's code. Both taps are the
     same gesture and the result is a friendship, not two crossed requests. */
  const res = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: ama.cookie, body: { code: await codeFor(h, kai.cookie) } });
  assert.equal(res.status, 200);
  assert.equal(res.data.state, 'accepted');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM friendships').n, 1);
});

test('you cannot accept your own request, or add yourself', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  const self = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, kai.cookie) } });
  assert.equal(self.error.code, 'self');

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });
  const own = await call(h.env, 'POST', '/api/player/friends/' + ama.user.id + '/accept',
    { cookie: kai.cookie });
  assert.equal(own.status, 400);
  assert.equal(own.error.code, 'own_request');
});

test('rotating a code revokes the old one', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  const old = await codeFor(h, kai.cookie);
  const rotated = await call(h.env, 'POST', '/api/player/friends/code/rotate',
    { cookie: kai.cookie });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.code, old);

  const stale = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: ama.cookie, body: { code: old } });
  assert.equal(stale.status, 400);
  assert.equal(stale.error.code, 'bad_code');

  const fresh = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: ama.cookie, body: { code: rotated.data.code } });
  assert.equal(fresh.status, 200);
});

test('an invite code is accepted however the player retypes it', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const code = await codeFor(h, kai.cookie);

  /* Lowercased, with a space and a dash in it, the way it gets pasted out of a
     chat message. */
  const mangled = code.toLowerCase().slice(0, 4) + ' - ' + code.toLowerCase().slice(4);
  const res = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: ama.cookie, body: { code: mangled } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('remove declines, withdraws and unfriends; block is final', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });
  const declined = await call(h.env, 'DELETE', '/api/player/friends/' + kai.user.id,
    { cookie: ama.cookie });
  assert.equal(declined.status, 200);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM friendships').n, 0);

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept',
    { cookie: ama.cookie });
  const blocked = await call(h.env, 'POST', '/api/player/friends/' + ama.user.id + '/block',
    { cookie: kai.cookie });
  assert.equal(blocked.status, 200);
  assert.equal(h.db.one('SELECT state FROM friendships').state, 'blocked');

  /* A blocked row is not removable by the ordinary delete, and a new request
     cannot get past the primary key. The refusal says nothing about the block. */
  const undo = await call(h.env, 'DELETE', '/api/player/friends/' + ama.user.id,
    { cookie: kai.cookie });
  assert.equal(undo.status, 404);

  const retry = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: ama.cookie, body: { code: await codeFor(h, kai.cookie) } });
  assert.equal(retry.status, 400);
  assert.equal(retry.error.code, 'bad_code');
});

test('a notice is written for a request and for an acceptance', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });

  const theirs = await call(h.env, 'GET', '/api/player/notices', { cookie: ama.cookie });
  assert.equal(theirs.data.unread, 1);
  assert.equal(theirs.data.notices[0].kind, 'friend_request');

  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept',
    { cookie: ama.cookie });
  const mine = await call(h.env, 'GET', '/api/player/notices', { cookie: kai.cookie });
  assert.equal(mine.data.notices[0].kind, 'friend_accepted');

  const marked = await call(h.env, 'POST', '/api/player/notices/read',
    { cookie: kai.cookie, body: { ids: [mine.data.notices[0].id] } });
  assert.equal(marked.data.marked, 1);
  const after = await call(h.env, 'GET', '/api/player/notices', { cookie: kai.cookie });
  assert.equal(after.data.unread, 0);
});

/* ------------------------------------------------------------- leaderboard */

test('the leaderboard holds the caller and accepted friends only', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');   /* accepted friend */
  const yaw = await signIn(h, 'yaw@example.com');   /* pending only */
  const nii = await signIn(h, 'nii@example.com');   /* a stranger */

  await postScore(h, kai.cookie, 700);
  await postScore(h, ama.cookie, 900);
  await postScore(h, yaw.cookie, 950);
  await postScore(h, nii.cookie, 1000);

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept',
    { cookie: ama.cookie });

  /* Yaw's request is never accepted, so Yaw is not a friend. */
  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, yaw.cookie) } });

  const board = await call(h.env, 'GET', '/api/play/leaderboard/sojourner/' + TODAY,
    { cookie: kai.cookie });
  assert.equal(board.status, 200);

  const ids = board.data.entries.map((e) => e.user_id);
  assert.deepEqual(ids.sort(), [kai.user.id, ama.user.id].sort());
  assert.equal(board.data.entries.length, 2);

  /* Ordered by score, and the caller is marked. */
  assert.equal(board.data.entries[0].user_id, ama.user.id);
  assert.equal(board.data.entries[0].rank, 1);
  assert.equal(board.data.entries[1].you, true);

  /* Nii, with the top score on the day, appears on nobody's board. */
  assert.equal(ids.includes(nii.user.id), false);
  assert.equal(ids.includes(yaw.user.id), false);
});

test('the leaderboard needs a session, and a practice run never appears', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');

  const anon = await call(h.env, 'GET', '/api/play/leaderboard/sojourner/' + TODAY);
  assert.equal(anon.status, 401);

  await call(h.env, 'POST', '/api/play/result', {
    cookie: kai.cookie,
    body: { game: 'sojourner', day: TODAY, mode: 'practice', score: 1000, max_score: 1000 },
  });
  const board = await call(h.env, 'GET', '/api/play/leaderboard/sojourner/' + TODAY,
    { cookie: kai.cookie });
  assert.equal(board.data.entries.length, 0);
});

test('standings cover the caller and friends over a rolling window', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const nii = await signIn(h, 'nii@example.com');

  await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: await codeFor(h, ama.cookie) } });
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept',
    { cookie: ama.cookie });

  await postScore(h, kai.cookie, 500);
  await postScore(h, kai.cookie, 7, 'wordchain');
  await postScore(h, ama.cookie, 800);
  await postScore(h, nii.cookie, 1000);

  const res = await call(h.env, 'GET', '/api/play/standings', { cookie: kai.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.entries.length, 2);

  const me = res.data.entries.find((e) => e.you);
  assert.equal(me.total_score, 507);
  assert.equal(me.days, 1, 'two games on one day is one day of showing up');
  assert.deepEqual(Object.keys(me.games).sort(), ['sojourner', 'wordchain']);
  assert.equal(res.data.entries.some((e) => e.user_id === nii.user.id), false);
});

test('thirty friend adds a day, and the thirty-first is refused', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');

  /* The limit is on the attempt, not on the success, so a bad code still
     spends the budget. Thirty rejected attempts, then a thirty-first that gets
     the rate limiter instead of the validator. */
  for (let i = 0; i < 30; i++) {
    const res = await call(h.env, 'POST', '/api/player/friends/add',
      { cookie: kai.cookie, body: { code: 'AAAAAAAA' } });
    assert.equal(res.status, 400, 'add ' + (i + 1));
  }
  const over = await call(h.env, 'POST', '/api/player/friends/add',
    { cookie: kai.cookie, body: { code: 'AAAAAAAA' } });
  assert.equal(over.status, 429);
});
