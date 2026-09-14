import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { KEYS } from '../src/storage.js';
import { FakeStorage, HostileStorage, mockFetch, offlineFetch } from './helpers/fake.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(fetchImpl, seed = {}, opts = {}) {
  const storage = new FakeStorage(seed);
  const PS = createClient().init({ baseUrl: '/api', storage, fetch: fetchImpl, ...opts });
  return { PS, storage };
}

/* ------------------------------------------------------------------ device */

test('a UUIDv4 device id is minted once into ps:device and then reused', () => {
  const { PS, storage } = setup(offlineFetch());
  const id = storage.getItem(KEYS.device);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(PS.deviceId(), id);
  assert.equal(PS.deviceId(), id);
});

test('the device id rides along on every request', async () => {
  const f = mockFetch({ user: null });
  const { PS } = setup(f);
  await PS.session();
  assert.equal(f.calls.at(-1).headers['X-PS-Device'], PS.deviceId());
});

/* ----------------------------------------------------------- offline paths */

test('with a dead backend nothing throws and every call returns a usable shape', async () => {
  const { PS } = setup(offlineFetch());

  const s = await PS.session();
  assert.deepEqual(s, { ok: false, source: 'offline', error: 'offline', user: null });

  const m = await PS.me();
  assert.equal(m.ok, false);
  assert.equal(m.user, null);
  // streaks is an array: the backend returns one row per game plus '*' for the
  // platform streak. An empty array is the safe offline read for .find().
  assert.deepEqual(m.streaks, []);

  const fr = await PS.friends();
  assert.deepEqual(fr.friends, []);
  assert.deepEqual(fr.pending, []);

  const n = await PS.notices();
  assert.deepEqual(n.notices, []);

  const t = await PS.today();
  assert.deepEqual(t.results, []);

  const lb = await PS.leaderboard('sojourner');
  assert.deepEqual(lb.entries, []);

  const a = await PS.addFriend('ABCD1234');
  assert.equal(a.ok, false);

  const o = await PS.signOut();
  assert.equal(o.ok, false);
});

test('a 500 from every endpoint never throws', async () => {
  const { PS } = setup(mockFetch(() => 500));
  const calls = [
    PS.session(), PS.me(), PS.friends(), PS.notices(), PS.today(),
    PS.leaderboard('wordchain', '2025-06-01'), PS.standings(),
    PS.signInEmail('a@b.co'), PS.verifyEmail('a@b.co', '123456'),
    PS.addFriend('CODE'), PS.signOut(), PS.claim(),
    PS.saveResult({ game: 'sojourner', score: 700, maxScore: 1000 }),
    PS.readNotices(['n1'])
  ];
  const out = await Promise.all(calls);           // rejects here would fail the test
  for (const r of out) assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(out[0].user, null);
});

test('a malformed JSON body is treated as a failure, not a crash', async () => {
  const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } });
  const { PS } = setup(badJson);
  const s = await PS.session();
  assert.equal(s.user, null);
  assert.equal(s.ok, true);                        // 200 is still a 200
});

/* ------------------------------------------------------- offline-first write */

test('saveResult writes localStorage before it touches the network', async () => {
  const storage = new FakeStorage();
  const PS = createClient().init({ storage, fetch: offlineFetch() });
  const p = PS.saveResult({
    game: 'sojourner', day: '2025-06-01', score: 812, maxScore: 978,
    detail: { rounds: [1, 2] }, durationMs: 240000
  });
  // not awaited yet — the local copy must already be there
  const stored = JSON.parse(storage.getItem('ps:result:sojourner:2025-06-01:daily'));
  assert.equal(stored.score, 812);
  assert.equal(stored.max_score, 978);
  assert.equal(stored.duration_ms, 240000);

  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.synced, false);
  assert.equal(r.queued, true);
});

test('a failed write is queued and retried on the next load', async () => {
  const storage = new FakeStorage();
  const down = createClient().init({ storage, fetch: offlineFetch() });
  await down.saveResult({ game: 'wordchain', day: '2025-06-01', score: 6, maxScore: 8 });
  assert.equal(down.queue().length, 1);
  assert.equal(down.queue()[0].path, '/play/result');

  // next load, same device, backend now up
  const f = mockFetch({ ok: true });
  const up = createClient().init({ storage, fetch: f });
  await tick();                                    // init flushes without blocking
  assert.equal(up.queue().length, 0);
  assert.equal(f.calls.filter((c) => c.url === '/api/play/result').length, 1);
  assert.equal(f.calls[0].body.score, 6);
});

test('a permanently-rejected write is dropped, not carried forever', async () => {
  const storage = new FakeStorage();
  const down = createClient().init({ storage, fetch: offlineFetch() });
  await down.saveResult({ game: 'sojourner', day: '2025-06-01', score: 1, maxScore: 1000 });

  // 409: first write wins (spec §5). Retrying it every load would be pointless.
  const up = createClient().init({ storage, fetch: mockFetch(() => [409, { error: 'exists' }]), autoFlush: false });
  const r = await up.flush();
  assert.deepEqual(r, { sent: 0, dropped: 1, left: 0 });
  assert.equal(up.queue().length, 0);
});

test('a 503 keeps the entry queued and counts the attempt', async () => {
  const storage = new FakeStorage();
  const down = createClient().init({ storage, fetch: offlineFetch() });
  await down.saveResult({ game: 'sojourner', day: '2025-06-01', score: 5, maxScore: 1000 });

  const up = createClient().init({ storage, fetch: mockFetch(() => 503), autoFlush: false });
  const r = await up.flush();
  assert.equal(r.left, 1);
  assert.equal(up.queue()[0].tries >= 1, true);
});

test('replaying the same day replaces its queue entry rather than doubling it', async () => {
  const { PS } = setup(offlineFetch());
  await PS.saveResult({ game: 'sojourner', day: '2025-06-01', score: 1, maxScore: 10 });
  await PS.saveResult({ game: 'sojourner', day: '2025-06-01', score: 9, maxScore: 10 });
  assert.equal(PS.queue().length, 1);
  assert.equal(PS.queue()[0].body.score, 9);
});

test('a successful write is not queued at all', async () => {
  const { PS } = setup(mockFetch({ ok: true }));
  const r = await PS.saveResult({ game: 'wordchain', day: '2025-06-01', score: 8, maxScore: 8 });
  assert.equal(r.synced, true);
  assert.equal(PS.queue().length, 0);
});

/* ------------------------------------------------------------ offline reads */

test('reads fall back to the last good response when the server goes away', async () => {
  const storage = new FakeStorage();
  const good = createClient().init({ storage, fetch: mockFetch({ friends: [{ handle: 'ama' }], pending: [], code: 'NYAN2025' }) });
  const a = await good.friends();
  assert.equal(a.source, 'network');
  assert.equal(a.code, 'NYAN2025');

  const bad = createClient().init({ storage, fetch: offlineFetch() });
  const b = await bad.friends();
  assert.equal(b.source, 'cache');
  assert.equal(b.ok, false);
  assert.deepEqual(b.friends, [{ handle: 'ama' }]);
});

test('today() falls back to results this device actually played', async () => {
  const { PS } = setup(offlineFetch());
  await PS.saveResult({ game: 'sojourner', day: '2025-06-01', score: 700, maxScore: 978 });
  await PS.saveResult({ game: 'wordchain', day: '2025-06-01', score: 8, maxScore: 8 });
  await PS.saveResult({ game: 'sojourner', day: '2025-05-30', score: 100, maxScore: 978 });

  const t = await PS.today('2025-06-01');
  assert.equal(t.source, 'local');
  assert.equal(t.results.length, 2);
  assert.deepEqual(t.results.map((r) => r.game).sort(), ['sojourner', 'wordchain']);
});

test('an offline leaderboard shows the one entry it can honestly show', async () => {
  const { PS } = setup(offlineFetch());
  await PS.saveResult({ game: 'sojourner', day: '2025-06-01', score: 700, maxScore: 978 });
  const lb = await PS.leaderboard('sojourner', '2025-06-01');
  assert.equal(lb.source, 'local');
  assert.equal(lb.entries.length, 1);
  assert.equal(lb.entries[0].you, true);
  assert.equal(lb.entries[0].score, 700);
});

/* ------------------------------------------------------------------- auth */

test('sign-in validates the address locally before spending a send', async () => {
  const f = mockFetch({ sent: true });
  const { PS } = setup(f);
  assert.deepEqual(await PS.signInEmail('not-an-email'), { ok: false, sent: false, error: 'bad_email' });
  assert.equal(f.calls.length, 0);

  const r = await PS.signInEmail('  Ama@Example.COM ');
  assert.equal(r.sent, true);
  assert.equal(f.calls[0].body.email, 'ama@example.com');     // normalised
});

test('verify requires six digits and caches the user it gets back', async () => {
  const f = mockFetch({ user: { id: 'u_1', handle: 'ama' } });
  const { PS, storage } = setup(f);
  assert.equal((await PS.verifyEmail('a@b.co', '123')).error, 'bad_code');
  assert.equal(f.calls.length, 0);

  const r = await PS.verifyEmail('a@b.co', '123-456');        // punctuation stripped
  assert.equal(r.ok, true);
  assert.equal(r.user.handle, 'ama');
  assert.equal(JSON.parse(storage.getItem('ps:cache:session')).user.handle, 'ama');
});

test('sign-out clears local session state even when the server is unreachable', async () => {
  const storage = new FakeStorage();
  const on = createClient().init({ storage, fetch: mockFetch({ user: { id: 'u_1' } }) });
  await on.session();
  assert.equal(JSON.parse(storage.getItem('ps:cache:session')).user.id, 'u_1');

  const off = createClient().init({ storage, fetch: offlineFetch() });
  await off.signOut();
  assert.equal(JSON.parse(storage.getItem('ps:cache:session')).user, null);
  assert.equal((await off.session()).user, null);
});

/* --------------------------------------------------------------- switches */

test('disabled means not one byte leaves the device', async () => {
  const f = mockFetch({ user: { id: 'u_1' } });
  const { PS, storage } = setup(f, {}, { enabled: false });
  await PS.session();
  await PS.me();
  await PS.saveResult({ game: 'sojourner', day: '2025-06-01', score: 1, maxScore: 10 });
  await PS.friends();
  assert.equal(f.calls.length, 0);
  // and the local copy is still kept, so the game is unaffected
  assert.notEqual(storage.getItem('ps:result:sojourner:2025-06-01:daily'), null);
});

test('the base url is configurable and defaults to /api', async () => {
  const f = mockFetch({ user: null });
  const PS = createClient().init({ storage: new FakeStorage(), fetch: f, baseUrl: 'https://playsapien.com/api/' });
  await PS.session();
  assert.equal(f.calls[0].url, 'https://playsapien.com/api/auth/session');
  assert.equal(createClient().config.baseUrl, '/api');
});

test('init prunes stale per-day keys', () => {
  const old = '2024-01-01';
  const storage = new FakeStorage({
    [`sojourner:${old}`]: '{}',
    [`wordchain:daily:${old}`]: '{}',
    'sojourner:settings': '{"units":"km"}',
    'wordchain:set': '{}'
  });
  createClient().init({ storage, fetch: offlineFetch() });
  assert.equal(storage.getItem(`sojourner:${old}`), null);
  assert.equal(storage.getItem(`wordchain:daily:${old}`), null);
  assert.equal(storage.getItem('sojourner:settings'), '{"units":"km"}');
  assert.equal(storage.getItem('wordchain:set'), '{}');
});

test('the whole SDK works with a localStorage that throws on every call', async () => {
  const PS = createClient().init({ storage: new HostileStorage(), fetch: offlineFetch() });
  assert.match(PS.deviceId(), /^[0-9a-f-]{36}$/);
  const r = await PS.saveResult({ game: 'sojourner', day: '2025-06-01', score: 1, maxScore: 10 });
  assert.equal(r.ok, false);
  assert.deepEqual(PS.queue(), []);
  assert.equal((await PS.session()).user, null);
  assert.deepEqual((await PS.today()).results, []);
});

test('dayKey is on the surface and is the UTC one', () => {
  const PS = createClient();
  assert.equal(PS.dayKey(Date.UTC(2025, 2, 9, 23, 30)), '2025-03-09');
  assert.equal(PS.prevDay('2025-03-09'), '2025-03-08');
});

test('saveResult defaults the day to today, UTC', async () => {
  const { PS, storage } = setup(offlineFetch());
  await PS.saveResult({ game: 'sojourner', score: 5, maxScore: 10 });
  const key = storage.keys().find((k) => k.startsWith('ps:result:'));
  assert.equal(key, 'ps:result:sojourner:' + PS.dayKey() + ':daily');
});

test('saveResult without a game is refused rather than stored under undefined', async () => {
  const { PS, storage } = setup(offlineFetch());
  const r = await PS.saveResult({ score: 5 });
  assert.equal(r.error, 'no_game');
  assert.equal(storage.keys().some((k) => k.startsWith('ps:result:')), false);
});
