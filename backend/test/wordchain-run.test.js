/* Option D, stage 2: Word Chain is ranked on the game's own clock (pauses are free),
   kept honest by the server's start stamp. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn, T0, utcDay } from './helpers/harness.js';
import { isWord } from '../src/lib/dictionary.js';
import Engine from '../../packages/scoring/wordchain.cjs';
import gamedata from '../../games/wordchain/src/gamedata.json' with { type: 'json' };

const TODAY = utcDay(T0);
const chainOf = (day) => gamedata.chains[Engine.idxForDay(gamedata.calendar, gamedata.chains.length, Engine.dayNumber(day))];
const CHAIN = chainOf(TODAY);

/* A chain solved with no help: every word typed, no Lifelines. `baseMs` is the
   game's playing time, penalty not included. */
function plainMoves(baseMs = 100000, chain = CHAIN) {
  return {
    v: 1,
    finals: chain.words.map((w, i) => (i === 0 ? null : w)),
    hints: chain.words.map(() => 0),
    baseMs,
  };
}

async function start(h, who, day = TODAY) {
  const res = await call(h.env, 'POST', '/api/play/run', { cookie: who && who.cookie, body: { game: 'wordchain', day } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.data.token;
}

const finish = (h, who, body) =>
  call(h.env, 'POST', '/api/play/result', {
    cookie: who.cookie,
    body: { game: 'wordchain', day: TODAY, mode: 'daily', score: 7, max_score: 7, ...body },
  });

async function befriend(h, x, y) {
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: y.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: x.cookie, body: { code } });
  await call(h.env, 'POST', '/api/player/friends/' + x.user.id + '/accept', { cookie: y.cookie });
}

/* ------------------------------------------------------------------ engine */

test('every chain in the bank is eight plain words, so a daily is always seven links', () => {
  for (const c of gamedata.chains) {
    assert.equal(c.words.length, 8);
    assert.ok(c.words.every((w) => /^[A-Z]+$/.test(w)), c.words.join(' '));
  }
});

test('the rules: exact, the other number, and a forgiven typo are right; a different word is not', () => {
  const dict = (w) => isWord(w);
  assert.equal(Engine.guessCorrect('ARM', 'ARM', {}, dict), true);
  assert.equal(Engine.guessCorrect('ARMS', 'ARM', { numberStrict: false }, dict), true);
  assert.equal(Engine.guessCorrect('ARMS', 'ARM', { numberStrict: true }, dict), false);
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => 'AR' + c).filter((w) => w !== 'ARM');
  const typo = letters.find((w) => !isWord(w)), real = letters.find((w) => isWord(w));
  assert.ok(typo && real);
  assert.equal(Engine.guessCorrect(typo, 'ARM', {}, dict), true, 'one letter out and not a word');
  assert.equal(Engine.guessCorrect(real, 'ARM', {}, dict), false, 'one letter out but a real word');
  assert.equal(Engine.guessCorrect('LEG', 'ARM', {}, dict), false);
});

test('Lifelines cost 15, then 25, then 40 seconds on a word', () => {
  assert.deepEqual([0, 1, 2, 3].map(Engine.hintsCost), [0, 15, 40, 80]);
});

test('a solved chain replays, Lifelines are counted, and a word bought in full needs no guess', () => {
  const ok = Engine.verify(gamedata, plainMoves(), TODAY, isWord);
  assert.equal(ok.ok, true);
  assert.equal(ok.penaltyMs, 0);
  assert.equal(ok.baseMs, 100000);

  /* One Lifeline on word 2, which is still typed. */
  const m = plainMoves(); m.hints[2] = 1;
  assert.ok(CHAIN.words[2].length >= 3);
  assert.equal(Engine.verify(gamedata, m, TODAY, isWord).penaltyMs, 15000);

  /* A short word bought in full: no guess, and exactly length-1 Lifelines. */
  const short = CHAIN.words.findIndex((w, i) => i > 0 && w.length <= 4);
  if (short > 0) {
    const b = plainMoves();
    b.finals[short] = null; b.hints[short] = CHAIN.words[short].length - 1;
    const v = Engine.verify(gamedata, b, TODAY, isWord);
    assert.equal(v.ok, true);
    assert.equal(v.penaltyMs, Engine.hintsCost(CHAIN.words[short].length - 1) * 1000);
  }
});

test('moves that are not a solved chain, or carry no sane time, do not replay', () => {
  const bad = (edit) => { const m = plainMoves(); edit(m); return Engine.verify(gamedata, m, TODAY, isWord); };
  assert.equal(bad((m) => { m.finals[3] = 'ZZZZZ'; }).error, 'not_solved');
  assert.equal(bad((m) => { m.finals[3] = null; }).error, 'not_solved', 'skipped without buying it');
  assert.equal(bad((m) => { m.hints[3] = 4; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.hints[3] = -1; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.hints[3] = 1.5; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.finals[3] = 'lower'; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.finals[0] = 'FIRE'; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.finals.pop(); }).error, 'bad_moves');
  assert.equal(bad((m) => { m.v = 2; }).error, 'bad_moves');
  assert.equal(bad((m) => { delete m.baseMs; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.baseMs = -5; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.baseMs = 1234.5; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.baseMs = '90000'; }).error, 'bad_moves');
  assert.equal(bad((m) => { m.baseMs = 7 * 3600000; }).error, 'bad_moves');
  /* Another day's chain does not solve today's. */
  assert.equal(Engine.verify(gamedata, plainMoves(100000, chainOf(utcDay(T0 + 86400 * 3))), TODAY, isWord).ok, false);
  assert.equal(Engine.verify(gamedata, null, TODAY, isWord).error, 'bad_moves');
});

/* ------------------------------------------------------------------ the stamp */

test('a start stamp is handed out signed, to anyone, for today or yesterday only', async () => {
  const h = makeEnv();
  const anon = await call(h.env, 'POST', '/api/play/run', { body: { game: 'wordchain', day: TODAY } });
  assert.equal(anon.status, 200);
  assert.equal(anon.data.day, TODAY);
  assert.equal(anon.data.started_at, T0);
  assert.match(anon.data.token, /^2026-09-14\.\d+\.[A-Za-z0-9_-]+$/);

  const post = (body) => call(h.env, 'POST', '/api/play/run', { body });
  assert.equal((await post({ game: 'sojourner', day: TODAY })).error.code, 'no_runs');
  assert.equal((await post({ game: 'wordchain', day: 'nope' })).error.code, 'bad_day');
  assert.equal((await post({ game: 'wordchain', day: utcDay(T0 - 5 * 86400) })).error.code, 'stale_day');
  assert.equal((await post({ game: 'wordchain', day: utcDay(T0 + 86400) })).error.code, 'stale_day');
});

/* ------------------------------------------------------------------- ranked */

test('the ranked time is the time on the game clock the player watched', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const run = await start(h, kai);
  h.setNow(T0 + 150);                          /* 2:30 passed on the server's clock */

  /* The game's clock stopped for 10 seconds (a pause), so it says 2:20. */
  const res = await finish(h, kai, { moves: plainMoves(140000), run });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.result.verified, true);
  assert.equal(res.data.result.score, 7);

  const row = h.db.one('SELECT duration_ms, verified, moves, detail FROM results');
  assert.equal(row.duration_ms, 140000, 'the pause is not counted against them');
  assert.equal(row.verified, 1);
  const detail = JSON.parse(row.detail);
  assert.equal(detail.ranked, true);
  assert.equal(detail.wall_ms, 150000);
  assert.deepEqual(JSON.parse(row.moves), plainMoves(140000));
});

test('a long interruption costs nothing: a twenty minute phone call, a ninety second game', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const run = await start(h, kai);
  h.setNow(T0 + 20 * 60 + 90);
  const res = await finish(h, kai, { moves: plainMoves(90000), run });
  assert.equal(res.data.result.verified, true);
  assert.equal(h.db.one('SELECT duration_ms FROM results').duration_ms, 90000);
});

test('the Lifeline penalty is worked out from the moves, not taken from the game', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const run = await start(h, kai);
  h.setNow(T0 + 160);
  const m = plainMoves(100000); m.hints[2] = 2;                    /* 15 + 25 = 40 s */
  /* The game's own total claims it paid nothing. */
  const res = await finish(h, kai, { moves: m, run, duration_ms: 100000 });
  assert.equal(res.status, 201);
  const row = h.db.one('SELECT duration_ms, detail FROM results');
  assert.equal(row.duration_ms, 100000 + 40000);
  assert.equal(JSON.parse(row.detail).hints, 2);
});

test('only ranked runs reach a friend, and the faster one is first', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, ama); await befriend(h, kai, bo);

  const kRun = await start(h, kai), aRun = await start(h, ama);
  h.setNow(T0 + 200);
  assert.equal((await finish(h, kai, { moves: plainMoves(190000), run: kRun })).status, 201);
  assert.equal((await finish(h, ama, { moves: plainMoves(130000), run: aRun })).status, 201);
  /* Bo never got a stamp: a fast time, ranked for nobody. */
  assert.equal((await finish(h, bo, { moves: plainMoves(20000) })).status, 201);

  const board = await call(h.env, 'GET', '/api/play/leaderboard/wordchain/' + TODAY, { cookie: kai.cookie });
  assert.deepEqual(board.data.entries.map((e) => e.user_id), [ama.user.id, kai.user.id]);
  assert.equal(board.data.entries[0].duration_ms, 130000);
  const boRow = h.db.one('SELECT verified, duration_ms FROM results WHERE user_id = ?', bo.user.id);
  assert.equal(boRow.verified, 0);
  assert.equal(boRow.duration_ms, 20000, 'kept as their own record, on their own clock');
});

/* ----------------------------------------------------------------- unranked */

async function unranked(setup, why) {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const body = await setup(h, kai);
  const res = await finish(h, kai, body);
  assert.equal(res.status, 201, why + ' ' + JSON.stringify(res.body));
  assert.equal(res.data.result.verified, false, why);
  const row = h.db.one('SELECT verified, moves, detail FROM results');
  assert.equal(row.verified, 0);
  assert.equal(JSON.parse(row.detail).why, why);
  assert.ok(row.moves, 'the moves are still kept');
  assert.equal(res.data.streaks.find((s) => s.game === 'wordchain').current, 1, 'it still counts for the streak');
}

test('a valid daily is stored but not ranked when the clock cannot be vouched for', async () => {
  await unranked(async () => ({ moves: plainMoves(120000) }), 'no_run');

  await unranked(async (h, kai) => {
    const run = await start(h, kai);
    return { moves: plainMoves(120000), run: run.slice(0, -3) + 'abc' };
  }, 'bad_token');

  await unranked(async (h, kai) => {
    const run = await start(h, kai);
    h.setNow(T0 + 120);
    /* A stamp edited to claim a later start. */
    const [d, , sig] = run.split('.');
    return { moves: plainMoves(20000), run: d + '.' + (T0 + 110) + '.' + sig };
  }, 'bad_token');

  await unranked(async (h, kai) => {
    const run = await start(h, kai, utcDay(T0 - 86400));          /* yesterday's stamp */
    h.setNow(T0 + 120);
    return { moves: plainMoves(118000), run };
  }, 'wrong_day');

  await unranked(async (h, kai) => {
    const run = await start(h, kai);
    h.setNow(T0 + 120);
    return { moves: plainMoves(4000), run };                       /* seven words in four seconds */
  }, 'too_fast');

  await unranked(async (h, kai) => {
    const run = await start(h, kai);
    h.setNow(T0 + 3 * 3600);
    return { moves: plainMoves(61 * 60 * 1000), run };             /* more than an hour of actual play */
  }, 'too_long');

  /* The game's clock says it played for longer than the server saw pass: the
     start stamp was held back, or the number was edited upwards. */
  await unranked(async (h, kai) => {
    const run = await start(h, kai);
    h.setNow(T0 + 60);
    return { moves: plainMoves(200000), run };
  }, 'late_start');
});

test('a little network delay at the start does not cost a player their ranking', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const run = await start(h, kai);
  h.setNow(T0 + 60);
  /* The game's clock says 63 s: its first word appeared 3 s before the stamp. */
  const res = await finish(h, kai, { moves: plainMoves(63000), run });
  assert.equal(res.data.result.verified, true);
  assert.equal(h.db.one('SELECT duration_ms FROM results').duration_ms, 63000);
});

test('a chain that was not solved is refused outright, with a token or without', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const run = await start(h, kai);
  h.setNow(T0 + 90);
  const m = plainMoves(89000); m.finals[4] = 'WRONG';
  const res = await finish(h, kai, { moves: m, run });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, 'not_solved');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 0);
});

test('one daily a day: the first finish stands, and a ranked run replaces an unranked one', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const run = await start(h, kai);
  h.setNow(T0 + 100);

  const first = await finish(h, kai, { moves: plainMoves(99000) });                     /* no stamp: unranked */
  assert.equal(first.data.result.verified, false);
  const second = await finish(h, kai, { moves: plainMoves(99000), run });
  assert.equal(second.status, 201);                                                     /* upgraded in place */
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM results').n, 1);
  assert.equal(h.db.one('SELECT verified FROM results').verified, 1);

  h.setNow(T0 + 105);
  const third = await finish(h, kai, { moves: plainMoves(50000), run });
  assert.equal(third.status, 409, 'a ranked time is never improved by sending again');
  assert.equal(h.db.one('SELECT duration_ms FROM results').duration_ms, 99000);
});
