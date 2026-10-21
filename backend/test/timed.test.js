/* Timed friend challenges: the same chain for both, each on their own clock, the faster wins. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0 } from './helpers/harness.js';
import { judge, checkPlay, MIN_MS, MAX_PLAY_MS } from '../src/lib/timed.js';

async function befriend(h, x, y) {
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: y.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: x.cookie, body: { code } });
  const r = await call(h.env, 'POST', '/api/player/friends/' + x.user.id + '/accept', { cookie: y.cookie });
  assert.equal(r.status, 200);
}
const sapien = async (h, who) => assert.equal((await call(h.env, 'POST', '/api/player/trial', { cookie: who.cookie })).status, 200);

async function pair() {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await befriend(h, kai, ama);
  await sapien(h, kai);
  return { h, kai, ama };
}

const challenge = (h, who, to) => call(h.env, 'POST', '/api/timed', { cookie: who.cookie, body: { to } });
const list = (h, who) => call(h.env, 'GET', '/api/timed', { cookie: who.cookie });
const start = (h, who, id) => call(h.env, 'POST', '/api/timed/' + id + '/start', { cookie: who.cookie });
const finish = (h, who, id, moves) => call(h.env, 'POST', '/api/timed/' + id + '/finish', { cookie: who.cookie, body: { moves } });

const wordsOf = (h, id) => JSON.parse(h.db.one('SELECT chain_words FROM timed WHERE id = ?', id).chain_words);
/* How the chain was solved with no help, in `baseMs` of the game's clock. */
function solved(words, baseMs, hints = null) {
  return {
    v: 1,
    finals: words.map((w, i) => (i === 0 ? null : w)),
    hints: words.map((w, i) => (hints && hints[i]) || 0),
    baseMs,
  };
}
const record = async (h, who) => (await call(h.env, 'GET', '/api/player/analytics?game=wordchain', { cookie: who.cookie })).data.timedRecord;

/* Play one whole challenge: Ama runs it taking `aWall` seconds on the server's clock (and her
   game clock says `aBase`), then Kai does, with his own numbers. */
async function play(h, kai, ama, id, ama_t, kai_t) {
  const words = wordsOf(h, id);
  h.setNow(h.now() + 5);
  await start(h, ama, id);
  h.setNow(h.now() + ama_t.wall);
  const a = await finish(h, ama, id, solved(words, ama_t.base, ama_t.hints));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  await start(h, kai, id);
  h.setNow(h.now() + kai_t.wall);
  const k = await finish(h, kai, id, solved(words, kai_t.base, kai_t.hints));
  assert.equal(k.status, 200, JSON.stringify(k.body));
  return { a, k };
}

/* ------------------------------------------------------------------- the rules */

test('who is faster: whole seconds, and a tie to the second is a draw', () => {
  assert.equal(judge(90000, 100000), 'a');
  assert.equal(judge(100000, 90000), 'b');
  assert.equal(judge(90000, 90999), 'draw');
  assert.equal(judge(90999, 91000), 'a');
});

test('the clock check: not faster than seven words allow, not longer than the time that passed, not hours', () => {
  assert.equal(checkPlay({ baseMs: MIN_MS - 1, startedSec: 0, nowSec: 100 }).error, 'too_fast');
  assert.equal(checkPlay({ baseMs: 60000, startedSec: 0, nowSec: 5 }).error, 'too_fast', 'opened five seconds ago');
  assert.equal(checkPlay({ baseMs: MAX_PLAY_MS + 1, startedSec: 0, nowSec: 99999 }).error, 'too_long');
  assert.equal(checkPlay({ baseMs: 90000, startedSec: 0, nowSec: 100 }).baseMs, 90000, 'a pause is free');
  assert.equal(checkPlay({ baseMs: 300000, startedSec: 0, nowSec: 100 }).baseMs, 100000, 'brought down to the time that passed');
});

/* ------------------------------------------------------------------- challenging */

test('a Sapien challenges a friend: both are given the same chain, from the practice pile', async () => {
  const { h, kai, ama } = await pair();
  const res = await challenge(h, kai, { friend_id: ama.user.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.state, 'active');
  const id = res.data.id;

  const idx = Number(h.db.one('SELECT chain_ref FROM timed WHERE id = ?', id).chain_ref.split(':')[1]);
  assert.ok(idx < 34 || idx >= 34 + 250, 'not from the daily-only pool');

  /* waiting on both */
  assert.equal((await list(h, ama)).data.yourTurn, 1);
  assert.equal((await list(h, kai)).data.yourTurn, 1, 'the challenger has to run it too');
  assert.ok(h.db.many('SELECT kind FROM notices WHERE user_id = ?', ama.user.id).some((n) => n.kind === 'timed_challenge'));

  const a = await start(h, ama, id), k = await start(h, kai, id);
  assert.deepEqual(a.data.chain.words, k.data.chain.words, 'the very same chain');
  assert.equal(a.data.chain.words.length, 8);
  assert.equal(typeof a.data.chain.links[0].numberStrict, 'boolean');
});

test('starting a challenge is Sapien; only a friend can be challenged; strangers cannot see it', async () => {
  const { h, kai, ama } = await pair();
  const free = await challenge(h, ama, { friend_id: kai.user.id });
  assert.equal(free.status, 403);
  assert.equal(free.error.code, 'sapien_required');
  const stranger = await signIn(h, 'stranger@example.com');
  assert.equal((await challenge(h, kai, { friend_id: stranger.user.id })).error.code, 'not_friends');
  assert.equal((await challenge(h, kai, {})).status, 400);

  const id = (await challenge(h, kai, { friend_id: ama.user.id })).data.id;
  assert.equal((await start(h, stranger, id)).status, 404);
  assert.equal((await finish(h, stranger, id, {})).status, 404);
  assert.equal((await list(h, stranger)).data.games.length, 0);
});

test('five at a time with one friend, and no chain dealt twice between them', async () => {
  const { h, kai, ama } = await pair();
  const refs = [];
  for (let i = 0; i < 5; i++) {
    const r = await challenge(h, kai, { friend_id: ama.user.id });
    assert.equal(r.status, 201);
    refs.push(h.db.one('SELECT chain_ref FROM timed WHERE id = ?', r.data.id).chain_ref);
  }
  assert.equal(new Set(refs).size, 5);
  assert.equal((await challenge(h, kai, { friend_id: ama.user.id })).error.code, 'too_many_with_friend');
});

/* ----------------------------------------------------------------------- the run */

test('opening the chain starts the server clock once; every later open is the same', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { friend_id: ama.user.id })).data.id;
  const first = await start(h, ama, id);
  h.setNow(T0 + 3600);
  const again = await start(h, ama, id);
  assert.equal(again.data.startedAt, first.data.startedAt, 'the start does not move');
  assert.deepEqual(again.data.chain, first.data.chain);
  assert.equal(first.data.startedAt, T0);
  /* nothing to finish before it has been opened */
  assert.equal((await finish(h, kai, id, solved(wordsOf(h, id), 60000))).error.code, 'not_started');
});

test('times stay hidden until the challenge is over, then each sees both and the gap', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { friend_id: ama.user.id })).data.id;
  const words = wordsOf(h, id);

  await start(h, ama, id);
  h.setNow(T0 + 100);
  const a = await finish(h, ama, id, solved(words, 90000));
  assert.equal(a.data.mineMs, 90000);
  assert.equal(a.data.theirsFinished, false);
  assert.equal(a.data.theirMs, null);
  assert.equal(a.data.result, null);

  /* Kai can see that she has finished, but not her time */
  const k1 = (await list(h, kai)).data;
  assert.equal(k1.games[0].theirsFinished, true);
  assert.equal(k1.games[0].theirMs, null);
  assert.equal(JSON.stringify(k1).includes('90000'), false, 'her time is nowhere in his list');
  assert.ok(h.db.many('SELECT kind FROM notices WHERE user_id = ?', kai.user.id).some((n) => n.kind === 'timed_turn'));
  /* ...and Ama sees she is waiting, with her own time */
  const a1 = (await list(h, ama)).data;
  assert.equal(a1.yourTurn, 0);
  assert.equal(a1.games[0].mineMs, 90000);
  assert.equal(a1.games[0].yourTurn, false);

  await start(h, kai, id);
  h.setNow(T0 + 230);
  const k = await finish(h, kai, id, solved(words, 100000));
  assert.equal(k.data.state, 'done');
  assert.equal(k.data.result, 'loss');
  assert.equal(k.data.theirMs, 90000);
  assert.equal(k.data.diffMs, -10000, 'slower by ten seconds');
  assert.ok(h.db.many('SELECT body FROM notices WHERE user_id = ?', ama.user.id).some((n) => /by 0:10/.test(n.body)));

  const ama2 = (await list(h, ama)).data.games[0];
  assert.equal(ama2.result, 'win');
  assert.equal(ama2.diffMs, 10000, 'faster by ten seconds');
  assert.equal(ama2.theirMs, 100000);
  /* nothing more can be sent */
  assert.equal((await finish(h, kai, id, solved(words, 50000))).error.code, 'not_active');
});

test('Lifelines are charged from how the chain was solved, not from what the game says', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { friend_id: ama.user.id })).data.id;
  const words = wordsOf(h, id);
  await start(h, ama, id);
  h.setNow(T0 + 100);
  const long = words.findIndex((w, k) => k > 0 && w.length >= 4);      // a word that can take two and still be typed
  const hints = words.map((w, i) => (i === long ? 2 : 0));            // 15 + 25 = 40 s
  const r = await finish(h, ama, id, solved(words, 90000, hints));
  assert.equal(r.data.penaltyMs, 40000);
  assert.equal(r.data.mineMs, 130000);
});

test('a pause is free, an impossible time is not: brought down, refused, or refused', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { friend_id: ama.user.id })).data.id;
  const words = wordsOf(h, id);
  await start(h, ama, id);

  h.setNow(T0 + 4);                                                  // opened four seconds ago
  assert.equal((await finish(h, ama, id, solved(words, 3000))).error.code, 'too_fast');
  h.setNow(T0 + 120);
  assert.equal((await finish(h, ama, id, solved(words, 5000))).error.code, 'too_fast', 'seven words in five seconds');
  const bad = solved(words, 90000); bad.finals[3] = 'ZZZZZ';
  assert.equal((await finish(h, ama, id, bad)).error.code, 'not_solved');
  assert.equal((await finish(h, ama, id, null)).status, 400);
  /* none of those used up her attempt */
  assert.equal((await list(h, ama)).data.games[0].yourTurn, true);

  /* a claim longer than the time that passed is brought down to it */
  const r = await finish(h, ama, id, solved(words, 500000));
  assert.equal(r.status, 200);
  assert.equal(r.data.mineMs, 120000);
});

test('times that read the same to the second are a draw', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { friend_id: ama.user.id })).data.id;
  const { k } = await play(h, kai, ama, id, { wall: 120, base: 90000 }, { wall: 120, base: 90400 });
  assert.equal(k.data.result, 'draw');
});

/* ------------------------------------------------------------------- the record */

test('wins, draws and losses per friend, with the running time differential', async () => {
  const { h, kai, ama } = await pair();
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, bo);
  const make = async (to) => (await challenge(h, kai, { friend_id: to.user.id })).data.id;
  const T = (s) => ({ wall: s + 30, base: s * 1000 });

  /* vs Ama (she is "a" in play()): Kai wins by 40 s, loses by 10 s, draws */
  let id = await make(ama); await play(h, kai, ama, id, T(160), T(120));    // Kai 2:00 vs Ama 2:40: +0:40
  id = await make(ama);     await play(h, kai, ama, id, T(100), T(110));    // Kai 1:50 vs Ama 1:40: -0:10
  id = await make(ama);     await play(h, kai, ama, id, T(100), T(100));    // draw: 0
  /* vs Bo: Kai is slower by 30 s */
  id = await make(bo);
  {
    const words = wordsOf(h, id);
    h.setNow(h.now() + 5); await start(h, bo, id); h.setNow(h.now() + 100); await finish(h, bo, id, solved(words, 70000));
    await start(h, kai, id); h.setNow(h.now() + 130); await finish(h, kai, id, solved(words, 100000));
  }
  /* an unfinished one does not count */
  await make(bo);

  const rec = await record(h, kai);
  assert.deepEqual(rec.total, { w: 1, d: 1, l: 2, diff_ms: 40000 - 10000 + 0 - 30000 });
  assert.equal(rec.friends[0].friend.id, ama.user.id, 'most-played first');
  assert.deepEqual([rec.friends[0].w, rec.friends[0].d, rec.friends[0].l, rec.friends[0].diff_ms], [1, 1, 1, 30000]);
  assert.deepEqual([rec.friends[1].w, rec.friends[1].d, rec.friends[1].l, rec.friends[1].diff_ms], [0, 0, 1, -30000]);
  /* Ama's is the mirror image, and only Word Chain's card carries one */
  const mirror = await record(h, ama);
  assert.deepEqual(mirror.total, { w: 1, d: 1, l: 1, diff_ms: -30000 });
  const other = await call(h.env, 'GET', '/api/player/analytics?game=sojourner', { cookie: kai.cookie });
  assert.equal(other.data.timedRecord, undefined);
  /* 1v1 and timed are separate records */
  assert.deepEqual((await call(h.env, 'GET', '/api/player/analytics?game=wordchain', { cookie: kai.cookie })).data.record.total, { w: 0, d: 0, l: 0 });
});

/* --------------------------------------------------------- inviting with a challenge */

test('a timed challenge sent with an invite waits for them to join and accept, then starts', async () => {
  const { h, kai } = await pair();
  const res = await challenge(h, kai, { invite: 'Newcomer@Example.com' });
  assert.equal(res.status, 201);
  assert.equal(res.data.state, 'invited');
  assert.equal(h.invites.length, 1);
  const id = res.data.id;
  assert.equal((await list(h, kai)).data.games[0].waitingOn, 'ne***@example.com');
  assert.equal((await start(h, kai, id)).status, 409, 'nobody can start yet');

  const newcomer = await signIn(h, 'newcomer@example.com');
  const theirs = (await list(h, newcomer)).data;
  assert.equal(theirs.games[0].needsFriendAccept, true);
  assert.equal(theirs.yourTurn, 0);
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept', { cookie: newcomer.cookie });
  const after = (await list(h, newcomer)).data;
  assert.equal(after.yourTurn, 1);
  assert.equal(after.games[0].state, 'active');
});

test('a blocked sender is not told, un-friending cancels, and an unstarted challenge can be withdrawn', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  await sapien(h, kai);
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/block', { cookie: ama.cookie });
  const res = await challenge(h, kai, { invite: 'ama@example.com' });
  assert.equal(res.status, 201);
  assert.equal(res.data.state, 'invited');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM timed').n, 0);

  await befriend(h, kai, bo);
  const id = (await challenge(h, kai, { friend_id: bo.user.id })).data.id;
  await call(h.env, 'DELETE', '/api/player/friends/' + bo.user.id, { cookie: kai.cookie });
  assert.equal(h.db.one('SELECT state FROM timed WHERE id = ?', id).state, 'cancelled');
  assert.equal((await record(h, kai)).total.w + (await record(h, kai)).total.l, 0, 'no result');

  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: bo.cookie })).data.code;
  const inv = (await challenge(h, kai, { invite: code })).data.id;
  const w = await call(h.env, 'POST', '/api/timed/' + inv + '/cancel', { cookie: kai.cookie });
  assert.equal(w.status, 200);
  assert.equal(h.db.one('SELECT state FROM timed WHERE id = ?', inv).state, 'cancelled');
});

test('the list puts what is waiting on you first; signed-out callers get nothing', async () => {
  const { h, kai, ama } = await pair();
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, bo);
  const mine = (await challenge(h, kai, { friend_id: bo.user.id })).data.id;     // Kai still has to run it
  const words = wordsOf(h, mine);
  await start(h, kai, mine); h.setNow(T0 + 100); await finish(h, kai, mine, solved(words, 80000));   // ...now he has
  await sapien(h, ama);
  const toKai = (await challenge(h, ama, { friend_id: kai.user.id })).data.id;
  const k = (await list(h, kai)).data;
  assert.equal(k.yourTurn, 1);
  assert.equal(k.games[0].id, toKai, 'the one waiting on Kai first');
  assert.equal(k.games[1].yourTurn, false);

  assert.equal((await call(h.env, 'GET', '/api/timed')).status, 401);
  assert.equal((await call(h.env, 'POST', '/api/timed', { body: {} })).status, 401);
});
