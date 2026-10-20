/* Option D: the game sends its moves, the server replays them and decides the score. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, utcDay } from './helpers/harness.js';
import { sojournerEngine, MAX_TOTAL } from '../src/lib/sojourner.js';

const TODAY = utcDay(T0);
const FOCUS = 'United States of America';
const eng = sojournerEngine();

/* A game played perfectly: the exact region for every place. `secs` is what the
   clock said was left, when every place was answered. */
function perfectMoves(day = TODAY, focus = FOCUS, secs = 30) {
  const picks = eng.dailyPicks(day, focus);
  const bag = eng.sprintBag('sprint|' + day, focus);
  return {
    v: 1, focus,
    rounds: picks.map((p) => eng.asEntry(p).t[0]),
    sprint: { answers: bag.map((b) => b.e.t[0]), secs },
  };
}

const post = (h, who, body) =>
  call(h.env, 'POST', '/api/play/result', { cookie: who.cookie, body: { game: 'sojourner', day: TODAY, mode: 'daily', ...body } });

async function befriend(h, x, y) {
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: y.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: x.cookie, body: { code } });
  await call(h.env, 'POST', '/api/player/friends/' + x.user.id + '/accept', { cookie: y.cookie });
}

/* ------------------------------------------------------------------ engine */

test('a perfect game scores the whole of phase 1, the sprint, the sweep and the clock', () => {
  const v = eng.verify(perfectMoves(TODAY, FOCUS, 30), TODAY);
  assert.equal(v.ok, true);
  assert.equal(v.rounds.reduce((n, r) => n + r.pts, 0), 750);
  assert.equal(v.sprint.score, 320 + 25 + 30);
  assert.equal(v.total, 750 + 320 + 25 + 30);
  assert.equal(v.max, MAX_TOTAL);
  assert.equal(MAX_TOTAL, 1155);
});

test('the clock is clamped to a minute, and counts only for a finished sprint', () => {
  assert.equal(eng.verify(perfectMoves(TODAY, FOCUS, 5000), TODAY).sprint.bonus, 60);
  assert.equal(eng.verify(perfectMoves(TODAY, FOCUS, -9), TODAY).sprint.bonus, 0);
  const m = perfectMoves(TODAY, FOCUS, 40);
  m.sprint.answers.pop();                                  /* time ran out on the last place */
  const v = eng.verify(m, TODAY);
  assert.equal(v.sprint.bonus, 0);
  assert.equal(v.sprint.sweep, 0);
  assert.equal(v.sprint.right, 11);
});

test('a wrong guess is scored by distance, and a different day is a different game', () => {
  const m = perfectMoves();
  const right = eng.verify(m, TODAY).total;
  m.rounds[0] = m.rounds[0] === 1 ? 2 : 1;                 /* some other region */
  assert.ok(eng.verify(m, TODAY).total < right);
  /* Today's perfect answers are not perfect for another day's places. */
  assert.ok(eng.verify(perfectMoves(), utcDay(T0 + 86400 * 3)).total < right);
});

test('moves that cannot be a game do not replay', () => {
  const ok = perfectMoves();
  const bad = (edit) => { const m = structuredClone(ok); edit(m); return eng.verify(m, TODAY); };
  assert.equal(bad((m) => { m.v = 2; }).ok, false);
  assert.equal(bad((m) => { m.focus = 'Atlantis'; }).error, 'bad_focus');
  assert.equal(bad((m) => { m.rounds.pop(); }).error, 'bad_moves');
  assert.equal(bad((m) => { m.rounds[2] = 0; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.rounds[2] = 1.5; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.rounds[2] = 99999999; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.rounds[2] = '5'; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.sprint.answers.push(1); }).error, 'bad_moves');   /* more than were asked */
  assert.equal(bad((m) => { delete m.sprint; }).error, 'bad_moves');
  assert.equal(eng.verify(null, TODAY).error, 'bad_moves');
});

test('the map fingerprint ignores what the game hangs on its pool, and notices a real change', async () => {
  const { default: Engine } = await import('../../packages/scoring/sojourner.cjs');
  const { default: meta } = await import('../../games/sojourner/baked/assets/meta.json', { with: { type: 'json' } });
  const { default: pool } = await import('../../games/sojourner/baked/assets/pool.json', { with: { type: 'json' } });
  const keyOf = (p) => Engine.make({ ...meta, pool: p }).keyHash();
  const base = keyOf(pool);

  /* The game attaches each place's reveal story (and more) to its pool entries
     once play begins. That once changed the fingerprint and bounced every result. */
  const annotated = structuredClone(pool);
  annotated.forEach((p, i) => { p.fs = ['a story ' + i]; p.fl = 'xx'; p.extra = { any: 'thing' }; });
  assert.equal(keyOf(annotated), base);

  const moved = structuredClone(pool);
  moved[5].x += 1;
  assert.notEqual(keyOf(moved), base);
});

/* ------------------------------------------------------------------- route */

test('the server decides the score: a result with moves ignores the number sent with it', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const m = perfectMoves(TODAY, FOCUS, 30);
  const expected = eng.verify(m, TODAY).total;

  const res = await post(h, kai, { moves: m, score: 1, max_score: 5, key: eng.keyHash() });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.result.score, expected);
  assert.equal(res.data.result.max_score, 1155);
  assert.equal(res.data.result.verified, true);

  const row = h.db.one('SELECT score, verified, moves, detail FROM results');
  assert.equal(row.score, expected);
  assert.equal(row.verified, 1);
  assert.deepEqual(JSON.parse(row.moves), m);
  assert.equal(JSON.parse(row.detail).rounds.length, 5);

  /* The player's streak counts it. */
  assert.equal(res.data.streaks.find((s) => s.game === 'sojourner').current, 1);
});

test('tampered moves, a bad day and practice are refused', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');

  const tampered = perfectMoves(); tampered.rounds[0] = -4;
  const a = await post(h, kai, { moves: tampered });
  assert.equal(a.status, 400); assert.equal(a.error.code, 'bad_moves');

  const stale = await post(h, kai, { moves: perfectMoves(utcDay(T0 - 5 * 86400)), day: utcDay(T0 - 5 * 86400) });
  assert.equal(stale.error.code, 'stale_day');

  const practice = await post(h, kai, { moves: perfectMoves(), mode: 'practice' });
  assert.equal(practice.error.code, 'bad_mode');

  /* Word Chain takes moves too, but these are not a solved chain. */
  const wc = await call(h.env, 'POST', '/api/play/result', { cookie: kai.cookie,
    body: { game: 'wordchain', day: TODAY, mode: 'daily', moves: { v: 1 } } });
  assert.equal(wc.error.code, 'bad_moves');

  const huge = perfectMoves(); huge.junk = 'x'.repeat(5000);
  assert.equal((await post(h, kai, { moves: huge })).error.code, 'moves_too_large');

  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 0, 'nothing refused was stored');
});

test('a game built from a different map is told to try again, not refused', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const res = await post(h, kai, { moves: perfectMoves(), key: 'not-this-map' });
  assert.equal(res.status, 503);
  assert.equal(res.error.code, 'key_mismatch');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 0);
  /* With the right key, the same moves go through. */
  assert.equal((await post(h, kai, { moves: perfectMoves(), key: eng.keyHash() })).status, 201);
});

test('first write wins, but moves replace a bare score that was there first', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const m = perfectMoves();

  const bare = await post(h, kai, { score: 900, max_score: 1155 });
  assert.equal(bare.status, 201);
  assert.equal(bare.data.result.verified, false);

  const replayed = await post(h, kai, { moves: m });
  assert.equal(replayed.status, 201);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 1, 'upgraded in place, not doubled');
  assert.equal(h.db.one('SELECT verified FROM results').verified, 1);
  assert.equal(h.db.one('SELECT score FROM results').score, eng.verify(m, TODAY).total);

  /* Now it is verified, a second send -- or a bare score -- loses. */
  assert.equal((await post(h, kai, { moves: perfectMoves(TODAY, FOCUS, 1) })).status, 409);
  const late = await post(h, kai, { score: 5, max_score: 1155 });
  assert.equal(late.status, 409);
  assert.equal(late.body.data.result.verified, true);
});

test('only verified results are ranked: friends, standings and Analytics', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, ama); await befriend(h, kai, bo);

  const kaiMoves = perfectMoves(TODAY, FOCUS, 10);
  await post(h, kai, { moves: kaiMoves });
  await post(h, ama, { moves: perfectMoves(TODAY, FOCUS, 50) });
  await post(h, bo, { score: 1155, max_score: 1155 });              /* a claimed perfect game, no moves */

  const board = await call(h.env, 'GET', '/api/play/leaderboard/sojourner/' + TODAY, { cookie: kai.cookie });
  assert.deepEqual(board.data.entries.map((e) => e.user_id), [ama.user.id, kai.user.id]);
  assert.equal(board.data.entries[0].score, eng.verify(perfectMoves(TODAY, FOCUS, 50), TODAY).total);

  const table = await call(h.env, 'GET', '/api/play/standings', { cookie: kai.cookie });
  assert.equal(table.data.entries.some((e) => e.user_id === bo.user.id), false);

  /* Bo still has a result and a streak of their own -- it just ranks for nobody. */
  const boStreak = h.db.one("SELECT current FROM streaks WHERE user_id = ? AND game = 'sojourner'", bo.user.id);
  assert.equal(boStreak.current, 1);

  const an = await call(h.env, 'GET', '/api/player/analytics?game=sojourner', { cookie: kai.cookie });
  assert.deepEqual(an.data.daily.compare.friends, { rank: 2, of: 2, beat: 0 });   /* bo is not counted */
});

test('an anonymous device can send moves too, and keeps them when it signs in', async () => {
  const h = makeEnv();
  const device = '11111111-2222-4333-8444-555555555555';
  const anon = await call(h.env, 'POST', '/api/play/result', {
    body: { game: 'sojourner', day: TODAY, mode: 'daily', moves: perfectMoves(), device_id: device },
  });
  assert.equal(anon.status, 201);
  assert.equal(anon.data.result.verified, true);

  const kai = await signIn(h, 'kai@example.com');
  const claim = await call(h.env, 'POST', '/api/player/claim', { cookie: kai.cookie, body: { device_ids: [device] } });
  assert.equal(claim.status, 200);
  const row = h.db.one('SELECT user_id, verified FROM results');
  assert.equal(row.user_id, kai.user.id);
  assert.equal(row.verified, 1);
});
