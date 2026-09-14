/* The claim/merge from spec §2.

   The scenario the spec describes: a player with a long streak on their phone
   signs in on their laptop, and the laptop has a different device_id and no
   history. Union the days, keep the higher score on a collision, then recompute
   the streak from the merged set rather than trusting either side. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, DAY, utcDay } from './helpers/harness.js';

const PHONE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const LAPTOP = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/* Record an anonymous result for a device on a given day, with the clock moved
   so the server's today-or-yesterday window accepts it. */
async function anonResult(h, device, day, score, game = 'sojourner') {
  h.setNow(Math.floor(Date.parse(day + 'T12:00:00Z') / 1000));
  const res = await call(h.env, 'POST', '/api/play/result', {
    body: {
      game, day, mode: 'daily', score,
      max_score: game === 'wordchain' ? 7 : 1000,
      device_id: device,
    },
  });
  assert.equal(res.status, 201, day + ' on ' + device + ': ' + JSON.stringify(res.body));
}

test('two devices with overlapping days merge, higher score wins, streak recomputed', async () => {
  const h = makeEnv();

  /* The phone: days -4 through -2, a three-day run. */
  const d = (back) => utcDay(T0 - back * DAY);
  await anonResult(h, PHONE, d(4), 300);
  await anonResult(h, PHONE, d(3), 310);
  await anonResult(h, PHONE, d(2), 320);

  /* The laptop: days -2 through 0. Day -2 overlaps, and the laptop's score for
     it is higher; day -3 is missing from the laptop entirely. */
  await anonResult(h, LAPTOP, d(2), 900);
  await anonResult(h, LAPTOP, d(1), 410);
  await anonResult(h, LAPTOP, d(0), 420);

  /* Sign in on the laptop. The client sends every device id the browser has
     ever seen, which after a localStorage import is both of them. */
  h.setNow(T0);
  const me = await signIn(h, 'kai@example.com');

  const claim = await call(h.env, 'POST', '/api/player/claim', {
    cookie: me.cookie,
    body: { device_ids: [PHONE, LAPTOP] },
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.deepEqual(claim.data.refused, []);

  /* Five distinct days, not six: the overlap collapsed. */
  const mine = h.db.many(
    'SELECT day, score FROM results WHERE user_id = ? ORDER BY day', me.user.id);
  assert.equal(mine.length, 5);
  assert.deepEqual(mine.map((r) => r.day), [d(4), d(3), d(2), d(1), d(0)]);

  /* The collision kept the higher score. */
  assert.equal(mine.find((r) => r.day === d(2)).score, 900);

  /* And the whole row went with it, not just the number -- the row that won is
     the laptop's, so its device_id travelled with the score. */
  const winner = h.db.one(
    'SELECT device_id FROM results WHERE user_id = ? AND day = ?', me.user.id, d(2));
  assert.equal(winner.device_id, LAPTOP);

  /* The losing row is left where it was, unattributed. Not deleted: deleting is
     the only irreversible thing the merge could do and it buys nothing. */
  const orphan = h.db.one(
    'SELECT user_id, score FROM results WHERE device_id = ? AND day = ?', PHONE, d(2));
  assert.equal(orphan.user_id, null);
  assert.equal(orphan.score, 320);

  /* The streak comes from the union: five contiguous days ending today. Neither
     device alone had five. */
  const s = h.db.one('SELECT * FROM streaks WHERE user_id = ? AND game = ?',
    me.user.id, 'sojourner');
  assert.equal(s.current, 5);
  assert.equal(s.longest, 5);
  assert.equal(s.played, 5);
  assert.equal(s.total_score, 300 + 310 + 900 + 410 + 420);

  /* All five surviving rows were adopted rather than swapped: the day -2
     collision was between two devices, and it was settled before anything was
     written, so no row of the account's was ever displaced. */
  assert.equal(claim.data.merged, 5);
  assert.equal(claim.data.replaced, 0);
});

test('a device result higher than the account\'s displaces it', async () => {
  const h = makeEnv();
  const day = utcDay(T0);

  h.setNow(T0);
  const me = await signIn(h, 'kai@example.com');
  const owned = await call(h.env, 'POST', '/api/play/result', {
    cookie: me.cookie,
    body: { game: 'sojourner', day, mode: 'daily', score: 200, max_score: 1000 },
  });
  assert.equal(owned.status, 201);

  await anonResult(h, PHONE, day, 950);
  h.setNow(T0);

  const claim = await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: [PHONE] } });
  assert.equal(claim.data.replaced, 1);
  assert.equal(claim.data.merged, 0);

  const rows = h.db.many('SELECT id, score, device_id FROM results WHERE user_id = ?', me.user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 950);
  assert.equal(rows[0].device_id, PHONE);
  /* The displaced row is gone, not orphaned: the unique index allows one row
     per (user, game, day, mode) and there is nothing else for it to belong to. */
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 1);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results WHERE id = ?', owned.data.result.id).n, 0);
});

test('a lower score on a collision does not displace the account row', async () => {
  const h = makeEnv();
  const day = utcDay(T0);

  await anonResult(h, LAPTOP, day, 800);
  h.setNow(T0);
  const me = await signIn(h, 'kai@example.com');
  await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: [LAPTOP] } });

  await anonResult(h, PHONE, day, 200);
  h.setNow(T0);
  const claim = await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: [PHONE] } });

  assert.equal(claim.data.merged, 0);
  assert.equal(claim.data.replaced, 0);
  const mine = h.db.many('SELECT score FROM results WHERE user_id = ?', me.user.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].score, 800);
});

test('claiming is idempotent', async () => {
  const h = makeEnv();
  await anonResult(h, PHONE, utcDay(T0 - DAY), 500);
  await anonResult(h, PHONE, utcDay(T0), 600);

  h.setNow(T0);
  const me = await signIn(h, 'kai@example.com');
  const once = await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: [PHONE] } });
  const twice = await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: [PHONE] } });

  assert.equal(once.data.merged, 2);
  assert.equal(twice.data.merged, 0);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results WHERE user_id = ?', me.user.id).n, 2);

  const s = h.db.one('SELECT current FROM streaks WHERE user_id = ? AND game = ?',
    me.user.id, 'sojourner');
  assert.equal(s.current, 2);
});

test('a device already claimed by someone else is refused, not stolen', async () => {
  const h = makeEnv();
  await anonResult(h, PHONE, utcDay(T0), 700);

  h.setNow(T0);
  const owner = await signIn(h, 'owner@example.com');
  await call(h.env, 'POST', '/api/player/claim',
    { cookie: owner.cookie, body: { device_ids: [PHONE] } });

  const thief = await signIn(h, 'thief@example.com');
  const attempt = await call(h.env, 'POST', '/api/player/claim',
    { cookie: thief.cookie, body: { device_ids: [PHONE] } });

  assert.equal(attempt.status, 200);
  assert.deepEqual(attempt.data.claimed, []);
  assert.deepEqual(attempt.data.refused, [PHONE]);
  assert.equal(
    h.db.one('SELECT user_id FROM results WHERE device_id = ?', PHONE).user_id,
    owner.user.id);
});

test('the merge spans games and updates the platform streak', async () => {
  const h = makeEnv();
  const d = (back) => utcDay(T0 - back * DAY);

  await anonResult(h, PHONE, d(1), 500, 'sojourner');
  await anonResult(h, LAPTOP, d(0), 7, 'wordchain');

  h.setNow(T0);
  const me = await signIn(h, 'kai@example.com');
  await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: [PHONE, LAPTOP] } });

  const soj = h.db.one('SELECT * FROM streaks WHERE user_id = ? AND game = ?', me.user.id, 'sojourner');
  const wc = h.db.one('SELECT * FROM streaks WHERE user_id = ? AND game = ?', me.user.id, 'wordchain');
  const all = h.db.one('SELECT * FROM streaks WHERE user_id = ? AND game = ?', me.user.id, '*');

  assert.equal(soj.current, 1, 'yesterday still counts, inside the grace');
  assert.equal(wc.current, 1);
  assert.equal(all.current, 2, 'two days of showing up, across two games');
  assert.equal(all.total_score, 507);
});

test('claim rejects junk and requires a session', async () => {
  const h = makeEnv();
  const anon = await call(h.env, 'POST', '/api/player/claim', { body: { device_ids: [PHONE] } });
  assert.equal(anon.status, 401);

  const me = await signIn(h, 'kai@example.com');
  const empty = await call(h.env, 'POST', '/api/player/claim',
    { cookie: me.cookie, body: { device_ids: ['not-a-uuid', 42] } });
  assert.equal(empty.status, 400);
});

test('deleting an account takes the play data and leaves the incidents', async () => {
  const h = makeEnv();
  h.setNow(T0);
  const me = await signIn(h, 'kai@example.com');
  await call(h.env, 'POST', '/api/play/result', {
    cookie: me.cookie,
    body: { game: 'sojourner', day: utcDay(T0), mode: 'daily', score: 500, max_score: 1000 },
  });

  /* An incident that names them, written the way the admin path writes it. */
  h.db.raw.prepare(
    'INSERT INTO incidents (id, chain_id, author_id, words, reason, at) VALUES (?,?,?,?,?,?)')
    .run('inc_1', 'c_1', me.user.id, '["A","B"]', 'test', T0);

  const gone = await call(h.env, 'DELETE', '/api/player/me', { cookie: me.cookie });
  assert.equal(gone.status, 200);

  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM users').n, 0);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 0);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM streaks').n, 0);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM sessions').n, 0);

  const incident = h.db.one('SELECT author_id, words FROM incidents');
  assert.equal(incident.author_id, null, 'the author is nulled');
  assert.equal(incident.words, '["A","B"]', 'the words and the reason survive');

  const after = await call(h.env, 'GET', '/api/auth/session', { cookie: me.cookie });
  assert.equal(after.data.user, null);
});
