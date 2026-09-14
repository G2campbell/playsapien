/* Results, first-write-wins, and the derived streak. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, DAY, utcDay } from './helpers/harness.js';

const TODAY = utcDay(T0);
const YESTERDAY = utcDay(T0 - DAY);

function result(overrides = {}) {
  return {
    game: 'sojourner',
    day: TODAY,
    mode: 'daily',
    score: 640,
    max_score: 1000,
    detail: { rounds: [{ pts: 128 }] },
    duration_ms: 214000,
    ...overrides,
  };
}

test('a result is recorded, and the duplicate loses without overwriting', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  const first = await call(h.env, 'POST', '/api/play/result',
    { cookie: me.cookie, body: result() });
  assert.equal(first.status, 201);
  assert.equal(first.data.result.score, 640);

  const second = await call(h.env, 'POST', '/api/play/result',
    { cookie: me.cookie, body: result({ score: 990 }) });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'already_recorded');
  /* The 409 carries the row that won, so the client can reconcile without a
     second request. */
  assert.equal(second.body.data.result.score, 640);
  assert.equal(second.body.data.result.id, first.data.result.id);

  const rows = h.db.many('SELECT score FROM results');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 640, 'the stored row was not overwritten');
});

test('practice and daily are separate rows for one day', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  assert.equal((await call(h.env, 'POST', '/api/play/result',
    { cookie: me.cookie, body: result() })).status, 201);
  assert.equal((await call(h.env, 'POST', '/api/play/result',
    { cookie: me.cookie, body: result({ mode: 'practice', score: 100 }) })).status, 201);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 2);
});

test('the day, the score and the max are all enforced', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  const cases = [
    [result({ day: utcDay(T0 - 3 * DAY) }), 'stale_day'],
    [result({ day: utcDay(T0 + DAY) }), 'stale_day'],
    [result({ day: '2026-02-31' }), 'bad_day'],
    [result({ score: 1001 }), 'bad_score'],
    [result({ score: -1 }), 'bad_score'],
    [result({ score: 12.5 }), 'bad_score'],
    [result({ max_score: 999 }), 'bad_max_score'],
    [result({ game: 'chess' }), 'unknown_game'],
    [result({ mode: 'tournament' }), 'bad_mode'],
    [result({ duration_ms: 99 * 3600 * 1000 }), 'bad_duration'],
  ];
  for (const [body, code] of cases) {
    const res = await call(h.env, 'POST', '/api/play/result', { cookie: me.cookie, body });
    assert.equal(res.status, 400, code);
    assert.equal(res.error.code, code);
  }

  /* Yesterday is allowed: the grace for finishing across midnight UTC. */
  const grace = await call(h.env, 'POST', '/api/play/result',
    { cookie: me.cookie, body: result({ day: YESTERDAY }) });
  assert.equal(grace.status, 201);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 1);
});

test("word chain's declared maximum is seven, and 1000 is refused", async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  const wrong = await call(h.env, 'POST', '/api/play/result',
    { cookie: me.cookie, body: result({ game: 'wordchain', score: 7, max_score: 1000 }) });
  assert.equal(wrong.error.code, 'bad_max_score');

  const right = await call(h.env, 'POST', '/api/play/result', {
    cookie: me.cookie,
    body: result({ game: 'wordchain', score: 7, max_score: 7, duration_ms: 91000 }),
  });
  assert.equal(right.status, 201);
});

test('the sojourner alias translates the old body shape', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  /* Exactly what partD.js:341 posts today. */
  const res = await call(h.env, 'POST', '/api/sojourner/score', {
    cookie: me.cookie,
    body: { day: TODAY, total: 812, rounds: [{ place: 'Accra', country: 'GH', pts: 190, km: 12 }] },
  });
  assert.equal(res.status, 201);

  const row = h.db.one('SELECT game, score, max_score, detail FROM results');
  assert.equal(row.game, 'sojourner');
  assert.equal(row.score, 812);
  assert.equal(row.max_score, 1000);
  assert.equal(JSON.parse(row.detail).rounds[0].place, 'Accra');
});

test('an anonymous device can record a result and read it back', async () => {
  const h = makeEnv();
  const device = '11111111-2222-4333-8444-555555555555';

  const res = await call(h.env, 'POST', '/api/play/result',
    { body: result({ device_id: device }) });
  assert.equal(res.status, 201);
  assert.equal(h.db.one('SELECT user_id, device_id FROM results').user_id, null);

  const dup = await call(h.env, 'POST', '/api/play/result',
    { body: result({ device_id: device, score: 999 }) });
  assert.equal(dup.status, 409, 'first write wins for a device too');

  const read = await call(h.env, 'GET', '/api/play/day/' + TODAY + '?device_id=' + device);
  assert.equal(read.status, 200);
  assert.equal(read.data.results.length, 1);
  assert.equal(read.data.results[0].score, 640);

  const nameless = await call(h.env, 'POST', '/api/play/result', { body: result() });
  assert.equal(nameless.status, 400);
  assert.equal(nameless.error.code, 'no_identity');
});

/* ------------------------------------------------------------------ streaks */

async function post(h, cookie, day, score = 500, game = 'sojourner') {
  const res = await call(h.env, 'POST', '/api/play/result', {
    cookie,
    body: { game, day, mode: 'daily', score, max_score: game === 'wordchain' ? 7 : 1000 },
  });
  assert.equal(res.status, 201, 'posting ' + day + ': ' + JSON.stringify(res.body));
  return res;
}

function streakOf(h, userId, game) {
  return h.db.one('SELECT * FROM streaks WHERE user_id = ? AND game = ?', userId, game) ||
    { current: 0, longest: 0, played: 0 };
}

test('consecutive days build a streak', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  /* Five days ending today. The clock moves with the day, because the server
     only accepts today or yesterday. */
  for (let i = 4; i >= 0; i--) {
    h.setNow(T0 - i * DAY);
    await post(h, me.cookie, utcDay(T0 - i * DAY), 400 + i);
  }

  const s = streakOf(h, me.user.id, 'sojourner');
  assert.equal(s.current, 5);
  assert.equal(s.longest, 5);
  assert.equal(s.played, 5);
  assert.equal(s.last_day, TODAY);
  assert.equal(s.total_score, 400 + 401 + 402 + 403 + 404);

  const platform = streakOf(h, me.user.id, '*');
  assert.equal(platform.current, 5, 'the platform streak tracks it too');
});

test('a gap breaks the streak but not the record', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  /* Days -6, -5, -4 (three in a row), then a gap, then -1 and 0. */
  for (const back of [6, 5, 4, 1, 0]) {
    h.setNow(T0 - back * DAY);
    await post(h, me.cookie, utcDay(T0 - back * DAY));
  }
  h.setNow(T0);

  const s = streakOf(h, me.user.id, 'sojourner');
  assert.equal(s.current, 2, 'the run since the gap');
  assert.equal(s.longest, 3, 'the run before it is still the record');
  assert.equal(s.played, 5);
});

test('a streak that ended days ago reads zero', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  for (const back of [5, 4, 3]) {
    h.setNow(T0 - back * DAY);
    await post(h, me.cookie, utcDay(T0 - back * DAY));
  }

  /* Nothing since. Back at today, the current streak is over -- but the
     longest, the count and the last day all survive. */
  h.setNow(T0);
  await post(h, me.cookie, TODAY, 7, 'wordchain');

  const s = streakOf(h, me.user.id, 'sojourner');
  assert.equal(s.current, 0);
  assert.equal(s.longest, 3);
  assert.equal(s.last_day, utcDay(T0 - 3 * DAY));
});

test('a result arriving out of order joins the days either side of it', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  /* Day -2 and day 0 are recorded; day -1 is missing, so nothing joins up. */
  h.setNow(T0 - 2 * DAY);
  await post(h, me.cookie, utcDay(T0 - 2 * DAY));
  h.setNow(T0);
  await post(h, me.cookie, TODAY);

  let s = streakOf(h, me.user.id, 'sojourner');
  assert.equal(s.current, 1);
  assert.equal(s.longest, 1);

  /* Now day -1 arrives late, within the today-or-yesterday window. Because the
     streak is recomputed rather than incremented, the late arrival bridges the
     two ends instead of appending to whichever came last. */
  h.setNow(T0 - DAY + 3600);
  await post(h, me.cookie, utcDay(T0 - DAY));
  h.setNow(T0);
  /* One more write, on a game that changes nothing, to force a recompute at
     today's clock rather than yesterday's. */
  await post(h, me.cookie, TODAY, 7, 'wordchain');

  s = streakOf(h, me.user.id, 'sojourner');
  assert.equal(s.current, 3, 'the three days are contiguous now');
  assert.equal(s.longest, 3);
  assert.equal(s.played, 3);
});

test('practice never counts towards a streak', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');

  await call(h.env, 'POST', '/api/play/result', {
    cookie: me.cookie,
    body: { game: 'sojourner', day: TODAY, mode: 'practice', score: 900, max_score: 1000 },
  });

  const s = streakOf(h, me.user.id, 'sojourner');
  assert.equal(s.current, 0);
  assert.equal(s.played, 0);
});

test('the profile reports a streak row for every game, played or not', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'kai@example.com');
  await post(h, me.cookie, TODAY);

  const res = await call(h.env, 'GET', '/api/player/me', { cookie: me.cookie });
  assert.equal(res.status, 200);
  const games = res.data.streaks.map((s) => s.game).sort();
  assert.deepEqual(games, ['*', 'sojourner', 'wordchain']);
  assert.equal(res.data.streaks.find((s) => s.game === 'wordchain').current, 0);
  assert.equal(res.data.streaks.find((s) => s.game === 'sojourner').current, 1);
});
