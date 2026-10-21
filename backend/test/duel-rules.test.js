/* The 1v1 rules, with no database: turns, equal turns, Lifelines, and what a player may see. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { play, viewFor, sideOf } from '../src/lib/duel.js';
import { isWord } from '../src/lib/dictionary.js';

const WORDS = ['MOON', 'LIGHT', 'HOUSE', 'HOLD', 'OVER', 'BOARD', 'WALK', 'OUT'];     /* 7 to solve */
const LINKS = WORDS.slice(1).map(() => ({ numberStrict: false }));

function duel(extra = {}) {
  return {
    id: 'd1', a_id: 'ua', b_id: 'ub', words: WORDS, links: LINKS, state: 'active', round: 1, mover: 'a',
    a_pos: 1, b_pos: 1, a_hints: 0, b_hints: 0, a_fin: null, b_fin: null, result: null, ...extra,
  };
}
const apply = (d, r) => ({ ...d, ...r.patch });
const guess = (g) => ({ type: 'guess', guess: g });
const HINT = { type: 'hint' };

/* a real word that starts with a different letter than HOLD, and a non-word */
const WRONG_LETTER = ['BOX', 'CAT', 'DOG', 'SKY'].find((w) => isWord(w) && w[0] !== 'H');
const REAL_WRONG = ['HAT', 'HAM', 'HEN', 'HIP'].find((w) => isWord(w));            /* a word starting with H, but not HOUSE */
/* real words starting with L, which are wrong for LIGHT */
const L_MISS = ['LAMP', 'LOUD', 'LEMON', 'LUNCH'].filter((w) => isWord(w));

test('a correct guess moves on and the same player goes again', () => {
  let d = duel();
  const r = play(d, 'a', guess('LIGHT'));
  assert.equal(r.outcome, 'correct');
  assert.equal(r.solved, 'LIGHT');
  assert.equal(r.turnOver, false);
  d = apply(d, r);
  assert.equal(d.a_pos, 2);
  assert.equal(d.mover, 'a', 'right word, go again');
  assert.equal(r.prefix, 'H', 'the next word shows its first letter only');
});

test('a wrong guess ends the turn; the turns alternate and the round only advances after the second mover', () => {
  let d = duel();
  const miss = play(d, 'a', guess(L_MISS[0]));
  assert.equal(miss.outcome, 'wrong');
  assert.equal(miss.turnOver, true);
  d = apply(d, miss);
  assert.equal(d.mover, 'b');
  assert.equal(d.round, 1, 'b still has round 1');
  assert.equal(d.a_pos, 1, 'nothing was solved');

  const missB = play(d, 'b', guess(L_MISS[1]));
  assert.equal(missB.outcome, 'wrong');
  d = apply(d, missB);
  assert.equal(d.mover, 'a');
  assert.equal(d.round, 2);
});

test('guesses that are not real attempts are answered and cost nothing', () => {
  const at = duel({ a_pos: 3 });                                         /* the word to find is HOLD */
  assert.equal(play(at, 'a', guess('QQQQ')).outcome, 'notword');
  assert.equal(play(at, 'a', guess(WRONG_LETTER)).outcome, 'letter');
  assert.equal(play(at, 'a', guess(REAL_WRONG), [REAL_WRONG]).outcome, 'repeat');
  for (const g of ['QQQQ', WRONG_LETTER]) {
    const r = play(at, 'a', guess(g));
    assert.equal(r.turnOver, false, g);
    assert.deepEqual(r.patch, {}, 'nothing changes');
  }
  /* a real wrong guess, by contrast, ends the turn and is remembered */
  const miss = play(at, 'a', guess(REAL_WRONG));
  assert.equal(miss.outcome, 'wrong');
  assert.equal(miss.remember, REAL_WRONG);
});

test('the right word in the wrong number is free when the link insists on the number', () => {
  const strict = duel({ links: LINKS.map((l, i) => (i === 0 ? { numberStrict: true } : l)) });
  const r = play(strict, 'a', guess('LIGHTS'));
  assert.equal(r.outcome, 'number');
  assert.equal(r.turnOver, false);
  /* ...and simply right when it does not */
  assert.equal(play(duel(), 'a', guess('LIGHTS')).outcome, 'correct');
});

test('a Lifeline reveals the next letter and ends the turn', () => {
  let d = duel();
  const r = play(d, 'a', HINT);
  assert.equal(r.outcome, 'hint');
  assert.equal(r.turnOver, true);
  assert.equal(r.prefix, 'LI', 'the first letter and one more');
  d = apply(d, r);
  assert.equal(d.a_hints, 1);
  assert.equal(d.mover, 'b');
  /* the next time it is a's turn, the extra letter is still showing */
  d = { ...d, mover: 'a' };
  assert.equal(viewFor(d, 'a').mine.prefix, 'LI');
});

test('buying the last letter solves the word, and at most three Lifelines are allowed', () => {
  const d = duel({ a_pos: 6, a_hints: 1 });                              /* WALK: W, then one letter bought */
  const r = play(d, 'a', HINT);                                          /* shows WAL... then WALK */
  assert.equal(apply(d, r).a_hints, 2);
  const again = play({ ...d, a_hints: 2 }, 'a', HINT);
  assert.equal(again.solved, 'WALK');
  assert.equal(apply({ ...d, a_hints: 2 }, again).a_pos, 7);
  assert.equal(play({ ...d, a_hints: 3 }, 'a', HINT).error, 'no_more_hints');
});

function finishing(side, over) {
  /* a player one word from the end, whose turn it is */
  return duel({ mover: side, [side + '_pos']: 7, ...over });
}

test('the first mover finishing gives the second mover one more turn: a miss loses, finishing ties', () => {
  let d = finishing('a', { round: 3 });
  const done = play(d, 'a', guess('OUT'));
  assert.equal(done.outcome, 'correct');
  assert.equal(done.over, null, 'not over: b has a turn left in this round');
  d = apply(d, done);
  assert.equal(d.mover, 'b');
  assert.equal(d.a_fin, 3);
  assert.equal(d.state, 'active');

  /* b misses: a wins */
  const lose = play(d, 'b', guess(L_MISS[0]));
  assert.equal(lose.over.result, 'a');
  assert.equal(apply(d, lose).state, 'done');

  /* b finishes in that turn: a draw */
  const tie = play({ ...d, b_pos: 7 }, 'b', guess('OUT'));
  assert.equal(tie.over.result, 'draw');
});

test('the second mover finishing first wins at once', () => {
  const d = finishing('b', { round: 2 });
  const r = play(d, 'b', guess('OUT'));
  assert.equal(r.over.result, 'b');
  assert.equal(apply(d, r).result, 'b');
});

test('a Lifeline that completes the chain finishes it, and the turn rules still apply', () => {
  /* a is on OUT (3 letters): two Lifelines buy it */
  let d = finishing('a', { a_hints: 1, round: 4 });
  const r = play(d, 'a', HINT);
  assert.equal(r.solved, 'OUT');
  d = apply(d, r);
  assert.equal(d.a_fin, 4);
  assert.equal(d.mover, 'b');
});

test('actions are refused out of turn, after the end, or once finished', () => {
  const d = duel();
  assert.equal(play(d, 'b', guess('LIGHT')).error, 'not_your_turn');
  assert.equal(play({ ...d, state: 'done' }, 'a', guess('LIGHT')).error, 'not_active');
  assert.equal(play({ ...d, state: 'invited' }, 'a', guess('LIGHT')).error, 'not_active');
  assert.equal(play({ ...d, a_pos: 8 }, 'a', guess('X')).error, 'already_finished');
  assert.equal(play(d, 'a', { type: 'cheat' }).error, 'bad_action');
});

test('a player is only ever shown the words they have solved', () => {
  const d = duel({ a_pos: 4, b_pos: 2, mover: 'a' });
  const v = viewFor(d, 'a', ['HAT']);
  assert.deepEqual(v.mine.solved, ['MOON', 'LIGHT', 'HOUSE', 'HOLD']);
  assert.equal(v.mine.prefix, 'O', 'the next word, OVER, shows only its first letter');
  assert.deepEqual(v.mine.tried, ['HAT']);
  assert.equal(v.yourTurn, true);
  assert.equal(v.theirs.solvedCount, 1, 'only how many, never which');
  const text = JSON.stringify(v);
  for (const secret of ['OVER', 'BOARD', 'WALK', 'OUT"']) assert.equal(text.includes(secret), false, secret);
  /* the other side sees their own solved words and not a's */
  const vb = viewFor(d, 'b');
  assert.deepEqual(vb.mine.solved, ['MOON', 'LIGHT']);
  assert.equal(JSON.stringify(vb).includes('HOUSE'), false);
  assert.equal(vb.yourTurn, false);
});

test('when the game is over both players see the whole chain and the result', () => {
  const d = duel({ state: 'done', result: 'a', a_pos: 8, b_pos: 5 });
  assert.equal(viewFor(d, 'a').result, 'win');
  assert.equal(viewFor(d, 'b').result, 'loss');
  assert.deepEqual(viewFor(d, 'b').chain, WORDS);
  assert.equal(viewFor({ ...d, result: 'draw' }, 'a').result, 'draw');
});

test('which side a player is on', () => {
  const d = duel();
  assert.equal(sideOf(d, 'ua'), 'a');
  assert.equal(sideOf(d, 'ub'), 'b');
  assert.equal(sideOf(d, 'uc'), null);
  assert.equal(sideOf({ ...d, b_id: null }, 'uc'), null);
});
