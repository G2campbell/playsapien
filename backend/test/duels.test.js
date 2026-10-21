/* 1v1 Word Chain, through the API: challenges, turns, ties, invites, and the record. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';
import WORDLIST from '../src/lib/wordlist.js';
import Engine from '../../packages/scoring/wordchain.cjs';

const DICT = WORDLIST.split('\n');

async function befriend(h, x, y) {
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: y.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: x.cookie, body: { code } });
  const r = await call(h.env, 'POST', '/api/player/friends/' + x.user.id + '/accept', { cookie: y.cookie });
  assert.equal(r.status, 200);
}

async function sapien(h, who) {
  const r = await call(h.env, 'POST', '/api/player/trial', { cookie: who.cookie });
  assert.equal(r.status, 200, 'the trial makes them Sapien');
}

/* Kai (Sapien) and Ama (free), already friends. */
async function pair() {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await befriend(h, kai, ama);
  await sapien(h, kai);
  return { h, kai, ama };
}

const challenge = (h, who, body) => call(h.env, 'POST', '/api/duels', { cookie: who.cookie, body });
const list = (h, who) => call(h.env, 'GET', '/api/duels', { cookie: who.cookie });
const view = (h, who, id) => call(h.env, 'GET', '/api/duels/' + id, { cookie: who.cookie });
const guess = (h, who, id, g) => call(h.env, 'POST', '/api/duels/' + id + '/guess', { cookie: who.cookie, body: { guess: g } });
const hint = (h, who, id) => call(h.env, 'POST', '/api/duels/' + id + '/hint', { cookie: who.cookie });

const MINE = ['SUN', 'FLOWER', 'POT', 'LUCK', 'CHARM', 'BRACELET', 'WATCH', 'DOG'];   /* a puzzle of their own */

/* The words are the server's secret; the tests read them straight from the database. */
const wordsOf = (h, id) => JSON.parse(h.db.one('SELECT chain_words FROM duels WHERE id = ?', id).chain_words);

/* A real word that starts with the same letter as `answer` and is not it, so it counts as a miss. */
function missFor(answer) {
  const w = DICT.find((x) => x[0] === answer[0] && x.length >= 3 && x.length <= 6 && !Engine.sameLemma(x, answer));
  assert.ok(w);
  return w;
}

/* Solve `count` words in a row, from the word the player is on. */
async function solve(h, who, id, count) {
  const words = wordsOf(h, id);
  let last;
  for (let k = 0; k < count; k++) {
    const v = (await view(h, who, id)).data;
    last = await guess(h, who, id, words[v.mine.pos]);
    assert.equal(last.data.outcome, 'correct');
  }
  return last;
}

const record = async (h, who) => (await call(h.env, 'GET', '/api/player/analytics?game=wordchain', { cookie: who.cookie })).data.record;

/* ------------------------------------------------------------------ challenging */

test('a Sapien challenges a friend: the friend gets the first turn, and the puzzle stays secret', async () => {
  const { h, kai, ama } = await pair();
  const res = await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'practice' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.state, 'active');
  const id = res.data.id;

  const theirs = await list(h, ama);
  assert.equal(theirs.data.yourTurn, 1, 'the badge: one game waiting on Ama');
  assert.equal(theirs.data.games[0].yourTurn, true);
  assert.equal(theirs.data.games[0].opponent.id, kai.user.id);
  const mine = await list(h, kai);
  assert.equal(mine.data.yourTurn, 0);
  assert.equal(mine.data.games[0].yourTurn, false);

  /* a notice tells Ama */
  assert.ok(h.db.many("SELECT kind FROM notices WHERE user_id = ?", ama.user.id).some((n) => n.kind === 'duel_challenge'));

  /* what Ama can see: the given word and a first letter, never the rest */
  const words = wordsOf(h, id);
  const v = (await view(h, ama, id)).data;
  assert.equal(v.given, words[0]);
  assert.deepEqual(v.mine.solved, [words[0]]);
  assert.equal(v.mine.prefix, words[1][0]);
  const text = JSON.stringify(v);
  for (const w of words.slice(2)) assert.equal(text.includes('"' + w + '"'), false, w);
  /* a stranger cannot see it at all */
  const eve = await signIn(h, 'eve@example.com');
  assert.equal((await view(h, eve, id)).status, 404);
});

test('starting a challenge is Sapien, and a chain of your own is checked', async () => {
  const { h, kai, ama } = await pair();
  const free = await challenge(h, ama, { to: { friend_id: kai.user.id }, chain: { source: 'practice' } });
  assert.equal(free.status, 403);
  assert.equal(free.error.code, 'sapien_required');

  const bad = (chain) => challenge(h, kai, { to: { friend_id: ama.user.id }, chain });
  assert.equal((await bad({ source: 'mine', words: ['ONE', 'TWO'] })).error.code, 'bad_chain');
  assert.equal((await bad({ source: 'mine', words: ['ONE', 'TWO', 'T H', 'FOUR'] })).error.code, 'bad_chain');
  assert.equal((await bad({ source: 'nonsense' })).error.code, 'bad_chain');
  const stranger = await signIn(h, 'stranger@example.com');
  assert.equal((await challenge(h, kai, { to: { friend_id: stranger.user.id }, chain: { source: 'practice' } })).error.code, 'not_friends');

  const mine = await bad({ source: 'mine', words: MINE.map((w) => w.toLowerCase()) });
  assert.equal(mine.status, 201);
  assert.deepEqual(wordsOf(h, mine.data.id), MINE);
});

test('"PlaySapien picks" deals from the practice pile, never the daily-only pool, and not the same chain twice', async () => {
  const { h, kai, ama } = await pair();
  const refs = [];
  for (let i = 0; i < 4; i++) {
    const r = await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'practice' } });
    assert.equal(r.status, 201);
    const ref = h.db.one('SELECT chain_ref FROM duels WHERE id = ?', r.data.id).chain_ref;
    const idx = Number(ref.split(':')[1]);
    assert.ok(idx < 34 || idx >= 34 + 250, 'chain ' + idx + ' is not in the daily-only pool');
    refs.push(ref);
  }
  assert.equal(new Set(refs).size, 4, 'no chain dealt twice between the same two players');
});

/* ------------------------------------------------------------------------ turns */

test('right word, go again; a wrong guess passes the turn; and it alternates', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'mine', words: MINE } })).data.id;

  /* Kai may not move: it is Ama's turn */
  assert.equal((await guess(h, kai, id, 'FLOWER')).status, 409);

  const first = await guess(h, ama, id, 'FLOWER');
  assert.equal(first.data.outcome, 'correct');
  assert.equal(first.data.turnOver, false, 'right word, go again');
  assert.equal(first.data.solved, 'FLOWER');
  assert.equal(first.data.game.mine.solved.length, 2);

  const miss = await guess(h, ama, id, missFor('POT'));
  assert.equal(miss.data.outcome, 'wrong');
  assert.equal(miss.data.turnOver, true);
  assert.equal(miss.data.game.yourTurn, false);

  /* now Kai, who has solved nothing yet */
  assert.equal((await list(h, kai)).data.yourTurn, 1);
  assert.ok(h.db.many('SELECT kind FROM notices WHERE user_id = ?', kai.user.id).some((n) => n.kind === 'duel_turn'));
  const k = await guess(h, kai, id, 'FLOWER');
  assert.equal(k.data.outcome, 'correct');
  assert.equal((await guess(h, ama, id, 'POT')).status, 409, 'Ama has to wait while Kai is mid-turn');
});

test('guesses that are not attempts cost nothing and keep the turn', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'mine', words: MINE } })).data.id;
  const nonword = await guess(h, ama, id, 'QQQQQ');
  assert.equal(nonword.data.outcome, 'notword');
  assert.equal(nonword.data.turnOver, false);
  const letter = await guess(h, ama, id, DICT.find((w) => w[0] !== 'F' && w.length > 3));
  assert.equal(letter.data.outcome, 'letter');
  /* a real wrong guess, made twice: the second is a free repeat */
  const wrong = missFor('FLOWER');
  assert.equal((await guess(h, ama, id, wrong)).data.outcome, 'wrong');
  assert.equal((await guess(h, kai, id, missFor('FLOWER'))).data.outcome, 'wrong');   /* Kai's own miss */
  const back = (await view(h, ama, id)).data;
  assert.deepEqual(back.mine.tried, [wrong], 'her wrong guess is remembered for next time');
  assert.equal((await guess(h, ama, id, wrong)).data.outcome, 'repeat');
  assert.equal((await view(h, ama, id)).data.yourTurn, true, 'still her turn: a repeat is free');
  assert.equal((await guess(h, ama, id, '123')).status, 400);
});

test('a Lifeline reveals a letter and ends the turn', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'mine', words: MINE } })).data.id;
  const r = await hint(h, ama, id);
  assert.equal(r.data.outcome, 'hint');
  assert.equal(r.data.turnOver, true);
  assert.equal(r.data.prefix, 'FL');
  assert.equal(r.data.game.yourTurn, false);
  /* when Ama's turn comes round, the letter is still there */
  await guess(h, kai, id, missFor('FLOWER'));
  assert.equal((await view(h, ama, id)).data.mine.prefix, 'FL');
});

/* ------------------------------------------------------------------ the endings */

test('the first mover finishing gives the other player one more turn: a miss loses, finishing ties', async () => {
  const { h, kai, ama } = await pair();
  const lose = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'mine', words: MINE } })).data.id;
  const done = await solve(h, ama, lose, 7);                     /* Ama finishes in one turn */
  assert.equal(done.data.game.mine.finished, true);
  assert.equal(done.data.over, null, 'not over: Kai has a turn left');
  const k = (await view(h, kai, lose)).data;
  assert.equal(k.yourTurn, true);
  assert.equal(k.theirs.finished, true);
  assert.ok(h.db.many('SELECT body FROM notices WHERE user_id = ?', kai.user.id).some((n) => /one turn to tie/.test(n.body)));

  const miss = await guess(h, kai, lose, missFor('FLOWER'));
  assert.equal(miss.data.over, 'a');                              /* the first mover, Ama, wins */
  assert.equal(miss.data.game.result, 'loss');
  assert.equal(miss.data.game.chain.length, 8, 'the whole chain is shown once it is over');
  assert.equal((await view(h, ama, lose)).data.result, 'win');

  /* the same again, but Kai finishes in his turn: a draw */
  const tie = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'mine', words: MINE } })).data.id;
  await solve(h, ama, tie, 7);
  const draw = await solve(h, kai, tie, 7);
  assert.equal(draw.data.over, 'draw');
  assert.equal((await view(h, ama, tie)).data.result, 'draw');
});

test('the second mover finishing first wins at once', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'mine', words: MINE } })).data.id;
  await guess(h, ama, id, missFor('FLOWER'));                     /* Ama misses straight away */
  const win = await solve(h, kai, id, 7);                         /* Kai finishes in his first turn */
  assert.equal(win.data.over, 'b');
  assert.equal(win.data.game.result, 'win');
  assert.equal((await view(h, ama, id)).data.result, 'loss');
  assert.equal((await guess(h, ama, id, 'FLOWER')).status, 409, 'nothing more can be played');
});

test('resigning hands the other player the win', async () => {
  const { h, kai, ama } = await pair();
  const id = (await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'practice' } })).data.id;
  const r = await call(h.env, 'POST', '/api/duels/' + id + '/resign', { cookie: ama.cookie });
  assert.equal(r.status, 200);
  assert.equal((await view(h, kai, id)).data.result, 'win');
  assert.equal((await view(h, ama, id)).data.result, 'loss');
});

test('the win-draw-loss record, per friend, on the Word Chain analytics card', async () => {
  const { h, kai, ama } = await pair();
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, bo);

  const g = async (to, chain = { source: 'mine', words: MINE }) =>
    (await challenge(h, kai, { to: { friend_id: to.user.id }, chain })).data.id;

  /* vs Ama: Kai wins one (Ama misses, Kai finishes), loses one (Ama finishes, Kai misses), draws one */
  let id = await g(ama);
  await guess(h, ama, id, missFor('FLOWER')); await solve(h, kai, id, 7);                     // Kai wins
  id = await g(ama);
  await solve(h, ama, id, 7); await guess(h, kai, id, missFor('FLOWER'));                     // Kai loses
  id = await g(ama);
  await solve(h, ama, id, 7); await solve(h, kai, id, 7);                                     // draw
  /* vs Bo: Bo resigns */
  id = await g(bo);
  await call(h.env, 'POST', '/api/duels/' + id + '/resign', { cookie: bo.cookie });           // Kai wins
  /* an unfinished game does not count */
  await g(bo);

  const rec = await record(h, kai);
  assert.deepEqual(rec.total, { w: 2, d: 1, l: 1 });
  assert.equal(rec.friends[0].friend.id, ama.user.id, 'most-played first');
  assert.deepEqual([rec.friends[0].w, rec.friends[0].d, rec.friends[0].l], [1, 1, 1]);
  assert.deepEqual([rec.friends[1].w, rec.friends[1].d, rec.friends[1].l], [1, 0, 0]);
  /* Ama's view is the mirror image */
  const mirror = await record(h, ama);
  assert.deepEqual(mirror.total, { w: 1, d: 1, l: 1 });     /* her three games against Kai, from her side */
  /* and only Word Chain's card has one */
  const other = await call(h.env, 'GET', '/api/player/analytics?game=sojourner', { cookie: kai.cookie });
  assert.equal(other.data.record, undefined);
});

/* --------------------------------------------------------- inviting with a challenge */

test('a challenge sent with an invite to an address with no account waits, and starts once they join and accept', async () => {
  const { h, kai } = await pair();
  const res = await challenge(h, kai, { to: { invite: 'Newcomer@Example.com' }, chain: { source: 'practice' } });
  assert.equal(res.status, 201);
  assert.equal(res.data.state, 'invited');
  assert.equal(h.invites.length, 1, 'the invitation email went out');
  const id = res.data.id;

  const mine = (await list(h, kai)).data.games[0];
  assert.equal(mine.state, 'invited');
  assert.equal(mine.waitingOn, 'ne***@example.com', 'the masked address, not the address');
  assert.equal(JSON.stringify(h.db.many('SELECT invite_label, invite_key FROM duels')).includes('Newcomer'), false);
  assert.equal((await guess(h, kai, id, 'X')).status, 409, 'nobody can move yet');

  /* they join with that address */
  const newcomer = await signIn(h, 'newcomer@example.com');
  const theirs = (await list(h, newcomer)).data;
  assert.equal(theirs.games[0].needsFriendAccept, true);
  assert.equal(theirs.games[0].opponent.id, kai.user.id);
  assert.equal(theirs.yourTurn, 0, 'not their turn until they accept');

  /* accepting the friend request starts it, and it is their turn */
  const acc = await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept', { cookie: newcomer.cookie });
  assert.equal(acc.status, 200);
  const after = (await list(h, newcomer)).data;
  assert.equal(after.yourTurn, 1);
  assert.equal(after.games[0].state, 'active');
});

test('a challenge to an existing player by invite code sends a friend request, and starts on accept', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await sapien(h, kai);
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: ama.cookie })).data.code;

  const res = await challenge(h, kai, { to: { invite: code }, chain: { source: 'practice' } });
  assert.equal(res.status, 201);
  assert.equal(res.data.state, 'invited');
  assert.equal((await call(h.env, 'GET', '/api/player/friends', { cookie: ama.cookie })).data.incoming.length, 1);
  assert.equal((await list(h, ama)).data.games[0].needsFriendAccept, true);

  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept', { cookie: ama.cookie });
  assert.equal((await list(h, ama)).data.yourTurn, 1);
  assert.equal((await list(h, ama)).data.games[0].state, 'active');
});

test('inviting a typed address says the same thing whether or not it has an account', async () => {
  const { h, kai, ama } = await pair();
  const stranger = await challenge(h, kai, { to: { invite: 'nobody@example.com' }, chain: { source: 'practice' } });
  const existing = await challenge(h, kai, { to: { invite: 'ama@example.com' }, chain: { source: 'practice' } });
  assert.equal(stranger.status, existing.status);
  assert.deepEqual(Object.keys(stranger.data).sort(), Object.keys(existing.data).sort());
  assert.equal(stranger.data.state, existing.data.state, 'both answer "invited"');
});

test('a player who has blocked you never sees the challenge, and you are not told', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await sapien(h, kai);
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/block', { cookie: ama.cookie });
  const res = await challenge(h, kai, { to: { invite: 'ama@example.com' }, chain: { source: 'practice' } });
  assert.equal(res.status, 201);
  assert.equal(res.data.state, 'invited');
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM duels').n, 0, 'nothing was created');
  assert.equal((await list(h, ama)).data.games.length, 0);
});

test('declining the friend request, un-friending, or blocking ends the games between the two, with no result', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  await sapien(h, kai);

  /* declined */
  const codeA = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: ama.cookie })).data.code;
  await challenge(h, kai, { to: { invite: codeA }, chain: { source: 'practice' } });
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/reject', { cookie: ama.cookie });
  assert.equal(h.db.one('SELECT state FROM duels').state, 'cancelled');

  /* un-friended mid-game */
  await befriend(h, kai, bo);
  const id = (await challenge(h, kai, { to: { friend_id: bo.user.id }, chain: { source: 'practice' } })).data.id;
  assert.equal(h.db.one('SELECT state FROM duels WHERE id = ?', id).state, 'active');
  await call(h.env, 'DELETE', '/api/player/friends/' + bo.user.id, { cookie: kai.cookie });
  assert.equal(h.db.one('SELECT state FROM duels WHERE id = ?', id).state, 'cancelled');
  assert.equal((await record(h, kai)).total.w + (await record(h, kai)).total.l, 0, 'a cancelled game is not a result');
});

test('a challenge can be withdrawn or declined before it starts, but not afterwards', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await sapien(h, kai);
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: ama.cookie })).data.code;
  const id = (await challenge(h, kai, { to: { invite: code }, chain: { source: 'practice' } })).data.id;
  const r = await call(h.env, 'POST', '/api/duels/' + id + '/cancel', { cookie: kai.cookie });
  assert.equal(r.status, 200);
  assert.equal(h.db.one('SELECT state FROM duels').state, 'cancelled');

  const { h: h2, kai: k2, ama: a2 } = await pair();
  const live = (await challenge(h2, k2, { to: { friend_id: a2.user.id }, chain: { source: 'practice' } })).data.id;
  const late = await call(h2.env, 'POST', '/api/duels/' + live + '/cancel', { cookie: k2.cookie });
  assert.equal(late.status, 409);
});

test('limits: five games with one friend at a time', async () => {
  const { h, kai, ama } = await pair();
  for (let i = 0; i < 5; i++) {
    assert.equal((await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'practice' } })).status, 201);
  }
  const sixth = await challenge(h, kai, { to: { friend_id: ama.user.id }, chain: { source: 'practice' } });
  assert.equal(sixth.error.code, 'too_many_with_friend');
});

test('the list puts the games waiting on you first', async () => {
  const { h, kai, ama } = await pair();
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, bo);
  await sapien(h, ama);
  /* Ama challenges Kai (Kai to move) and Kai challenges Bo, then Kai challenges Ama (Ama to move) */
  const toKai = (await challenge(h, ama, { to: { friend_id: kai.user.id }, chain: { source: 'practice' } })).data.id;
  await challenge(h, kai, { to: { friend_id: bo.user.id }, chain: { source: 'practice' } });
  const k = (await list(h, kai)).data;
  assert.equal(k.yourTurn, 1);
  assert.equal(k.games[0].id, toKai, 'the game waiting on Kai comes first');
  assert.equal(k.games[0].yourTurn, true);
  assert.equal(k.games[1].yourTurn, false);
});

test('signed-out callers get nothing', async () => {
  const h = makeEnv();
  assert.equal((await call(h.env, 'GET', '/api/duels')).status, 401);
  assert.equal((await call(h.env, 'POST', '/api/duels', { body: {} })).status, 401);
});
