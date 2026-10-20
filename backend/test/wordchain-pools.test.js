/* Word Chain's three pools, the chain the server serves for a day, and practice usage. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, DAY, utcDay } from './helpers/harness.js';
import { poolOf, practiceBatch, poolStats, chainForDay, POOL_SIZES, BANK_SIZE } from '../src/lib/wcpools.js';
import Engine from '../../packages/scoring/wordchain.cjs';
import gamedata from '../../games/wordchain/src/gamedata.json' with { type: 'json' };

const TODAY = utcDay(T0);
const TODAY_NUM = Engine.dayNumber(TODAY);
const CAL = gamedata.calendar;
const DEVICE = '11111111-2222-4333-8444-555555555555';

const ids = (chains) => chains.map((c) => c.id);

/* ------------------------------------------------------------------- pools */

test('the pools: 250 daily-only, 100 reserve, and the rest (with the 34 originals) practice', () => {
  const by = { daily: 0, reserve: 0, practice: 0 };
  for (let i = 0; i < BANK_SIZE; i++) by[poolOf(i)]++;
  assert.equal(by.daily, POOL_SIZES.daily);
  assert.equal(by.reserve, POOL_SIZES.reserve);
  assert.equal(by.practice, BANK_SIZE - 350);
  for (let i = 0; i < CAL.legacy; i++) assert.equal(poolOf(i), 'practice', 'the originals were dailies long ago');
  assert.equal(poolOf(CAL.legacy), 'daily');                                  /* first of the newer chains */
  assert.equal(poolOf(CAL.legacy + 249), 'daily');
  assert.equal(poolOf(CAL.legacy + 250), 'reserve');
  assert.equal(poolOf(CAL.legacy + 350), 'practice');
});

test('practice never draws from the daily pool, and never today\'s chain', () => {
  const todaysIdx = Engine.idxForDay(CAL, BANK_SIZE, TODAY_NUM);
  for (let round = 0; round < 40; round++) {
    const batch = practiceBatch(TODAY_NUM, [], 30);
    for (const c of batch) {
      assert.notEqual(poolOf(c.id), 'daily', 'chain ' + c.id);
      assert.notEqual(c.id, todaysIdx);
    }
    assert.equal(new Set(ids(batch)).size, batch.length, 'no repeats within a batch');
  }
});

test('practice takes the practice pool first, then reserve chains that have been dailies, then unused reserve, then repeats', () => {
  /* Before the calendar starts no reserve chain has been a daily: tier 1 is the practice pool alone. */
  const before = Engine.dayNumber('2026-09-14');
  assert.ok(before < CAL.start);
  const tier1 = practiceBatch(before, [], 100).map((c) => c.id);
  assert.ok(tier1.slice(0, 70).every((i) => poolOf(i) === 'practice'), 'practice pool first');

  const all = (day, seen) => practiceBatch(day, seen, 30).map((c) => c.id);
  const stats = poolStats(before);
  assert.equal(stats.practice_ready, stats.practice - 1, 'today\'s chain, if it is in the practice pool, is held back');
  assert.equal(stats.reserve_unused, 100);

  /* A device that has seen all of tier 1 is next given reserve chains. */
  const todaysIdx = Engine.idxForDay(CAL, BANK_SIZE, before);
  const practiceIds = [];
  for (let i = 0; i < BANK_SIZE; i++) if (poolOf(i) === 'practice' && i !== todaysIdx) practiceIds.push(i);
  const seen = [];
  while (!practiceIds.every((i) => seen.includes(i))) seen.push(...all(before, seen));
  const afterTier1 = all(before, seen).filter((i) => !seen.includes(i));
  assert.ok(afterTier1.length > 0);
  assert.ok(afterTier1.every((i) => poolOf(i) === 'reserve'), 'then the reserve');

  /* Once the dailies have reached the reserve, the ones already played count as tier 1. */
  const later = CAL.start + 300;       /* reserve chains 250..299 have been dailies; 300 is today's */
  const lateStats = poolStats(later);
  assert.equal(lateStats.reserve_unused, 49, "350 - 300 not yet used, less today's own chain");
  assert.ok(lateStats.practice_ready > stats.practice_ready);

  /* A device that has seen everything gets repeats rather than nothing. */
  const everything = [];
  for (let i = 0; i < BANK_SIZE; i++) if (poolOf(i) !== 'daily') everything.push(i);
  const repeats = practiceBatch(later, everything, 10);
  assert.equal(repeats.length, 10);
  assert.ok(repeats.every((c) => poolOf(c.id) !== 'daily'));
});

/* ------------------------------------------------------------------ the day */

const get = (h, path, opts = {}) => call(h.env, 'GET', path, opts);

test('a day\'s chain is served from the calendar, with only what the game needs', async () => {
  const h = makeEnv();
  const res = await get(h, '/api/wordchain/chain/' + TODAY);
  assert.equal(res.status, 200);
  const idx = Engine.idxForDay(CAL, BANK_SIZE, TODAY_NUM);
  const want = gamedata.chains[idx];
  assert.equal(res.data.day, TODAY);
  assert.deepEqual(res.data.chain.words, want.words);
  assert.equal(res.data.chain.id, idx);
  assert.equal(res.data.chain.links.length, want.words.length - 1);
  assert.deepEqual(Object.keys(res.data.chain.links[0]).sort(), ['alt', 'numberStrict']);
  assert.equal(res.data.chain.author, null);
  /* nothing about its quality, level or pool */
  assert.equal(JSON.stringify(res.data).includes('level'), false);
});

test('a future day is never served, and neither is one too far back', async () => {
  const h = makeEnv();
  assert.equal((await get(h, '/api/wordchain/chain/' + utcDay(T0 + DAY))).status, 404);
  assert.equal((await get(h, '/api/wordchain/chain/' + utcDay(T0 + 30 * DAY))).status, 404);
  assert.equal((await get(h, '/api/wordchain/chain/' + utcDay(T0 - 60 * DAY))).status, 404);
  assert.equal((await get(h, '/api/wordchain/chain/' + utcDay(T0 - 39 * DAY))).status, 200);
  assert.equal((await get(h, '/api/wordchain/chain/nope')).status, 400);
});

test('walking the bank is limited: eighty chains a day, then a stop', async () => {
  const h = makeEnv();
  for (let i = 0; i < 80; i++) {
    const r = await get(h, '/api/wordchain/chain/' + utcDay(T0 - (i % 30) * DAY), { headers: { 'x-ps-device': DEVICE } });
    assert.equal(r.status, 200, 'request ' + i);
  }
  const over = await get(h, '/api/wordchain/chain/' + TODAY, { headers: { 'x-ps-device': DEVICE } });
  assert.equal(over.status, 429);
});

test('a player\'s chain the admin scheduled for a day is the day\'s chain, with its author', async () => {
  const h = makeEnv();
  const author = await signIn(h, 'ama@example.com');
  h.db.raw.prepare("UPDATE users SET display_name = 'Ama', name_chosen_at = ? WHERE id = ?").run(T0, author.user.id);
  const words = ['SUN', 'FLOWER', 'POT', 'LUCK', 'CHARM', 'BRACELET', 'WATCH', 'DOG'];
  h.db.raw.prepare(
    `INSERT INTO chains (id, author_id, words, words_hash, status, pool, scheduled_for, created_at)
     VALUES ('c_mine', ?, ?, 'h1', 'approved', 'daily', ?, ?)`).run(author.user.id, JSON.stringify(words), TODAY, T0);

  const res = await get(h, '/api/wordchain/chain/' + TODAY);
  assert.deepEqual(res.data.chain.words, words);
  assert.equal(res.data.chain.id, 'c_mine');
  assert.equal(res.data.chain.author, 'Ama');
  assert.equal((await chainForDay(h.db, TODAY)).source, 'player');
  /* The next day is the calendar's again. */
  const next = await get(h, '/api/wordchain/chain/' + utcDay(T0 - DAY));
  assert.notDeepEqual(next.data.chain.words, words);

  /* And a finished daily is checked against THAT chain, not the calendar's. */
  const kai = await signIn(h, 'kai@example.com');
  const run = (await call(h.env, 'POST', '/api/play/run', { body: { game: 'wordchain', day: TODAY } })).data.token;
  h.setNow(T0 + 60);
  const solved = { v: 1, finals: words.map((w, i) => (i === 0 ? null : w)), hints: words.map(() => 0), baseMs: 55000 };
  const ok = await call(h.env, 'POST', '/api/play/result', { cookie: kai.cookie,
    body: { game: 'wordchain', day: TODAY, mode: 'daily', moves: solved, run } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.data.result.verified, true);

  const cal = gamedata.chains[Engine.idxForDay(CAL, BANK_SIZE, TODAY_NUM)].words;
  const wrong = { v: 1, finals: cal.map((w, i) => (i === 0 ? null : w)), hints: cal.map(() => 0), baseMs: 55000 };
  const ama = await signIn(h, 'bo@example.com');
  const refused = await call(h.env, 'POST', '/api/play/result', { cookie: ama.cookie,
    body: { game: 'wordchain', day: TODAY, mode: 'daily', moves: wrong, run } });
  assert.equal(refused.status, 400, 'the calendar chain does not solve a day the admin gave to a player');
});

/* ---------------------------------------------------------------- practice */

test('a practice top-up returns chains in the game\'s shape and respects what the device has', async () => {
  const h = makeEnv();
  const first = await get(h, '/api/wordchain/practice?n=15', { headers: { 'x-ps-device': DEVICE } });
  assert.equal(first.status, 200);
  assert.equal(first.data.chains.length, 15);
  for (const c of first.data.chains) {
    assert.equal(typeof c.id, 'number');
    assert.equal(c.words.length, 8);
    assert.equal(c.links.length, 7);
  }
  const seen = ids(first.data.chains).join(',');
  const second = await get(h, '/api/wordchain/practice?n=15&seen=' + seen, { headers: { 'x-ps-device': DEVICE } });
  const overlap = ids(second.data.chains).filter((i) => ids(first.data.chains).includes(i));
  assert.equal(overlap.length, 0, 'nothing the device already has, while there is more');
  assert.equal((await get(h, '/api/wordchain/practice?n=500')).data.chains.length, 30, 'a batch is capped');
});

test('practice top-ups are limited to twelve a day', async () => {
  const h = makeEnv();
  for (let i = 0; i < 12; i++) {
    assert.equal((await get(h, '/api/wordchain/practice?n=5', { headers: { 'x-ps-device': DEVICE } })).status, 200);
  }
  assert.equal((await get(h, '/api/wordchain/practice?n=5', { headers: { 'x-ps-device': DEVICE } })).status, 429);
});

/* ------------------------------------------------------------- usage stats */

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function adminSetup() {
  const TEAM = 'team.example.cloudflareaccess.com', AUD = 'aud-for-practice-stats';
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc({ iss: 'https://' + TEAM, aud: AUD, email: 'admin@example.com', sub: 'a1', iat: T0 - 60, exp: T0 + 3600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head + '.' + body));
  return {
    env: makeEnv({ vars: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
      accessJwks: { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', kid: 'k1' }] } }),
    headers: { 'cf-access-jwt-assertion': head + '.' + body + '.' + b64url(sig) },
  };
}

test('practice use is counted per player per day, and the admin can read the average and the peak', async () => {
  const { env, headers } = await adminSetup();
  const post = (device, id) => call(env.env, 'POST', '/api/wordchain/practice/played',
    { headers: { 'x-ps-device': device }, body: { id } });
  const dev2 = '22222222-3333-4444-8555-666666666666';

  /* Device 1 finishes 6 practice chains and tops up twice; device 2 finishes 2. */
  for (let k = 0; k < 6; k++) assert.equal((await post(DEVICE, k)).status, 200);
  for (let k = 0; k < 2; k++) assert.equal((await post(dev2, k)).status, 200);
  for (let k = 0; k < 2; k++) await call(env.env, 'GET', '/api/wordchain/practice?n=5', { headers: { 'x-ps-device': DEVICE } });
  /* A signed-in player counts under their account, not a device. */
  const kai = await signIn(env, 'kai@example.com');
  for (let k = 0; k < 4; k++) await call(env.env, 'POST', '/api/wordchain/practice/played', { cookie: kai.cookie, body: { id: k } });

  const res = await call(env.env, 'GET', '/api/admin/practice-stats?days=7', { headers });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const today = res.data.per_day[0];
  assert.equal(today.day, TODAY);
  assert.equal(today.players, 3);
  assert.equal(today.plays, 12);
  assert.equal(today.average, 4);
  assert.equal(today.peak, 6);
  assert.equal(today.topups, 2);
  assert.equal(today.heavy, 0);
  assert.equal(res.data.summary.peak_in_a_day, 6);
  assert.equal(res.data.summary.average_per_player_day, 4);
  assert.equal(res.data.pools.daily, 250);
  assert.equal(res.data.pools.reserve, 100);
  assert.ok(res.data.pools.practice_ready > 0);

  /* Not for the public. */
  const open = await call(env.env, 'GET', '/api/admin/practice-stats');
  assert.equal(open.status, 403);
});

test('a chain finished with no device or account is not counted, and a bad id is refused', async () => {
  const h = makeEnv();
  assert.equal((await call(h.env, 'POST', '/api/wordchain/practice/played', { body: { id: 3 } })).status, 200);
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM practice_stats').n, 0);
  assert.equal((await call(h.env, 'POST', '/api/wordchain/practice/played', { body: { id: 99999 } })).status, 400);
  assert.equal((await call(h.env, 'POST', '/api/wordchain/practice/played', { body: { id: 'x' } })).status, 400);
});
