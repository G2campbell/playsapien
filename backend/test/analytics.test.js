/* Analytics: the player's own numbers, ranked against everyone, friends and a group. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, utcDay } from './helpers/harness.js';

const TODAY = utcDay(T0);
const dayBefore = (n) => utcDay(T0 - n * 86400);
let seq = 0;

/* Results go straight into the table: the route only accepts today or
   yesterday, and these tests need weeks of history. They are verified ones,
   because only verified results are ranked. */
function put(h, who, game, day, score, mode = 'daily') {
  h.db.raw.prepare(
    `INSERT INTO results (id, user_id, game, day, mode, score, max_score, created_at, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run('r_test' + (++seq), who.user.id, game, day, mode, score,
      game === 'sojourner' ? 1155 : 7, T0);
}

async function befriend(h, x, y) {
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: y.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: x.cookie, body: { code } });
  const r = await call(h.env, 'POST', '/api/player/friends/' + x.user.id + '/accept', { cookie: y.cookie });
  assert.equal(r.status, 200);
}

const get = (h, who, query = '') =>
  call(h.env, 'GET', '/api/player/analytics' + query, { cookie: who.cookie });

async function world() {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  const cy = await signIn(h, 'cy@example.com');          /* a stranger */
  await befriend(h, kai, ama); await befriend(h, kai, bo);
  assert.equal((await call(h.env, 'POST', '/api/player/trial', { cookie: kai.cookie })).status, 200);
  const g = await call(h.env, 'POST', '/api/player/groups/add',
    { cookie: kai.cookie, body: { name: 'Family', friend_id: ama.user.id } });
  return { h, kai, ama, bo, cy, group: g.data.group };
}

test('daily: rank and share beaten, among all players, friends and a group', async () => {
  const { h, kai, ama, bo, cy, group } = await world();
  put(h, kai, 'sojourner', TODAY, 700);
  put(h, ama, 'sojourner', TODAY, 900);
  put(h, bo, 'sojourner', TODAY, 500);
  put(h, cy, 'sojourner', TODAY, 800);
  /* A practice run, and an old day, change nothing about today. */
  put(h, kai, 'sojourner', TODAY, 1155, 'practice');
  put(h, cy, 'sojourner', dayBefore(1), 1155);

  const r = await get(h, kai, '?game=sojourner&group=' + group.id);
  assert.equal(r.status, 200);
  const d = r.data.daily;
  assert.equal(Math.round(d.you.value), 700);                          /* basis points round a little */
  assert.equal(d.you.max, 1155);
  assert.equal(d.provisional, true);
  assert.deepEqual(d.compare.all, { rank: 3, of: 4, beat: 33 });       /* behind ama and cy */
  assert.deepEqual(d.compare.friends, { rank: 2, of: 3, beat: 50 });   /* behind ama */
  assert.deepEqual(d.compare.group, { rank: 2, of: 2, beat: 0 });
  assert.equal(r.data.group.name, 'Family');

  /* Without a group, there is no group comparison. */
  const plain = await get(h, kai, '?game=sojourner');
  assert.equal(plain.data.daily.compare.group, undefined);
  assert.equal(plain.data.group, null);
});

test('a tie is neither ahead nor behind, and a player alone has nobody to beat', async () => {
  const { h, kai, ama, cy } = await world();
  put(h, kai, 'sojourner', TODAY, 600);
  put(h, ama, 'sojourner', TODAY, 600);
  const tie = await get(h, kai, '?game=sojourner');
  assert.deepEqual(tie.data.daily.compare.all, { rank: 1, of: 2, beat: 0 });

  put(h, cy, 'wordchain', TODAY, 5);
  const alone = await get(h, cy, '?game=wordchain');
  assert.deepEqual(alone.data.daily.compare.all, { rank: 1, of: 1, beat: null });
});

test('not played today: no number, and the games count is still told', async () => {
  const { h, kai } = await world();
  put(h, kai, 'sojourner', dayBefore(1), 700);
  const r = await get(h, kai, '?game=sojourner');
  assert.equal(r.data.daily.you, null);
  assert.deepEqual(r.data.daily.compare, {});
  assert.equal(r.data.daily.games, 1);
});

test('last dozen and lifetime appear at 12 and 13 results, and rank only those who have them', async () => {
  const { h, kai, ama, bo } = await world();
  put(h, kai, 'sojourner', TODAY, 700);
  const early = await get(h, kai, '?game=sojourner');
  assert.equal(early.data.dozen.you, null);
  assert.equal(early.data.dozen.games, 1);
  assert.equal(early.data.dozen.needed, 12);

  for (let i = 1; i <= 11; i++) put(h, kai, 'sojourner', dayBefore(i), 600);   /* 12 in all */
  for (let i = 0; i <= 11; i++) put(h, ama, 'sojourner', dayBefore(i), 900);   /* 12 in all */
  for (let i = 0; i <= 4; i++) put(h, bo, 'sojourner', dayBefore(i), 100);     /* too few */

  const r = await get(h, kai, '?game=sojourner');
  assert.equal(Math.round(r.data.dozen.you.value), 608);                      /* (700 + 11x600) / 12 */
  assert.equal(r.data.dozen.you.max, 1155);
  assert.deepEqual(r.data.dozen.compare.friends, { rank: 2, of: 2, beat: 0 }); /* bo is not counted */
  assert.equal(r.data.lifetime.you, null);                                     /* 13th result not yet */

  put(h, kai, 'sojourner', dayBefore(12), 600);
  const r13 = await get(h, kai, '?game=sojourner');
  assert.equal(r13.data.lifetime.games, 13);
  assert.ok(r13.data.lifetime.you);
  assert.equal(r13.data.lifetime.compare.all.of, 1);                           /* only kai has 13 */
});

test('the front door puts every game on one scale: a percentage of each maximum', async () => {
  const { h, kai } = await world();
  put(h, kai, 'sojourner', TODAY, 693);      /* 60% of 1155 */
  put(h, kai, 'wordchain', TODAY, 7);        /* 100% */
  const r = await get(h, kai, '?game=all');
  assert.deepEqual(r.data.daily.you, { value: 80, max: 100 });
  const one = await get(h, kai);
  assert.deepEqual(one.data.daily.you, { value: 80, max: 100 }, 'all is the default');
});

test('free accounts get Daily only, and the server says so itself', async () => {
  const { h, cy } = await world();
  put(h, cy, 'sojourner', TODAY, 400);
  const r = await get(h, cy, '?game=sojourner');
  assert.equal(r.data.plan, 'free');
  assert.ok(r.data.daily.you);
  assert.deepEqual(r.data.dozen, { locked: true });
  assert.deepEqual(r.data.lifetime, { locked: true });
});

test('bad requests: signed out, unknown game, and a group that is not yours', async () => {
  const { h, kai, ama, group } = await world();
  assert.equal((await call(h.env, 'GET', '/api/player/analytics')).status, 401);
  const g = await get(h, kai, '?game=chess');
  assert.equal(g.status, 400);
  assert.equal(g.error.code, 'unknown_game');
  assert.equal((await get(h, kai, '?group=nope')).status, 404);
  /* Ama cannot read Kai's group, or learn it exists. */
  const other = await get(h, ama, '?group=' + group.id);
  assert.equal(other.status, 404);
  assert.equal(other.error.code, 'no_group');
});

test('a player who deletes their account drops out of every ranking', async () => {
  const { h, kai, ama } = await world();
  put(h, kai, 'sojourner', TODAY, 700);
  put(h, ama, 'sojourner', TODAY, 900);
  h.db.raw.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(T0, ama.user.id);
  const r = await get(h, kai, '?game=sojourner');
  assert.deepEqual(r.data.daily.compare.all, { rank: 1, of: 1, beat: null });
});
