/* The 1v1 rules for Word Chain, with no database in them.

   Two players race to solve the SAME chain, each at their own pace. There is no
   clock and no score: the only question is who gets to the end first.

   A TURN is a run of correct guesses. It ends at the first wrong guess, when the
   player spends a Lifeline, or when they finish the chain. Players alternate: in each
   ROUND the first mover (side 'a') takes a turn, then the second ('b') does.

   EQUAL TURNS. If the first mover finishes in round r, the second mover still gets
   round r's turn, and can finish too (a draw). If the second mover finishes first, they
   win at once -- the first mover has had as many turns as they have. If the second mover's
   turn ends without finishing after the first mover has finished, the first mover wins.

   FREE GUESSES. Only a real, wrong guess ends a turn. Something that is not an attempt
   -- not a word, the wrong first letter, a guess already made on this word, or the right
   word in the wrong number -- is answered and costs nothing.

   LIFELINES. A Lifeline reveals the next letter of the current word AND ends the turn
   (there is no clock to charge, so the price is the move). A word whose last letter is
   revealed this way is solved, and can finish the chain.

   The answers stay on the server. A player is only ever shown the words they have
   already solved (lib viewFor), which is the whole point of the server judging guesses.

   Everything here works on a plain "duel" object -- the row's fields plus the chain --
   and returns what to change, so the rules can be tested without a database. */

import Engine from '../../../packages/scoring/wordchain.cjs';
import { isWord } from './dictionary.js';

export const MAX_HINTS = Engine.MAX_HINTS;

const other = (side) => (side === 'a' ? 'b' : 'a');

/* Which side a player is on, or null. */
export function sideOf(d, userId) {
  if (d.a_id === userId) return 'a';
  if (d.b_id && d.b_id === userId) return 'b';
  return null;
}

/* One action by one side. `tried` is the wrong guesses already made on the word the side
   is on. Returns { error } or
     { outcome, turnOver, solved, prefix, patch, over }
   where `patch` holds the duel fields to change, `solved` is the word just solved (or null)
   and `over` is { result: 'a'|'b'|'draw' } when this action ended the game. */
export function play(d, side, action, tried = []) {
  if (d.state !== 'active') return { error: 'not_active' };
  if (d.mover !== side) return { error: 'not_your_turn' };

  const words = d.words, links = d.links, n = words.length;
  const pos = d[side + '_pos'];
  if (pos >= n) return { error: 'already_finished' };
  const hints = d[side + '_hints'];
  const answer = words[pos];

  let outcome, solvedNow = false, turnOver = false;
  let patch = {};

  if (action.type === 'hint') {
    if (hints >= MAX_HINTS) return { error: 'no_more_hints' };
    outcome = 'hint';
    const shown = 1 + hints + 1;                       // letters showing after this Lifeline
    if (shown >= answer.length) solvedNow = true;      // the word is bought in full
    else patch[side + '_hints'] = hints + 1;
    turnOver = true;                                   // a Lifeline always costs the turn
  } else if (action.type === 'guess') {
    const guess = action.guess;
    if (Engine.guessCorrect(guess, answer, links[pos - 1], isWord)) { outcome = 'correct'; solvedNow = true; }
    else if (Engine.sameLemma(guess, answer)) outcome = 'number';          // free
    else if (tried.indexOf(guess) >= 0) outcome = 'repeat';                // free
    else if (!isWord(guess)) outcome = 'notword';                          // free
    else if (guess[0] !== answer[0]) outcome = 'letter';                   // free
    else { outcome = 'wrong'; turnOver = true; }                           // a real miss
  } else {
    return { error: 'bad_action' };
  }

  let finishedNow = false;
  if (solvedNow) {
    patch[side + '_pos'] = pos + 1;
    patch[side + '_hints'] = 0;
    finishedNow = pos + 1 >= n;
  }

  /* Where the game goes next. */
  let over = null;
  const round = d.round;
  const aFin = side === 'a' && finishedNow ? round : d.a_fin;
  const bFin = side === 'b' && finishedNow ? round : d.b_fin;
  if (finishedNow) patch[side + '_fin'] = round;

  if (finishedNow) {
    if (side === 'b') {
      /* The second mover finished: first mover has had as many turns, so it ends here. */
      over = { result: aFin != null ? 'draw' : 'b' };
    } else {
      /* The first mover finished: the second mover gets this round's turn to answer. */
      patch.mover = 'b';
    }
    turnOver = true;
  } else if (turnOver) {
    if (side === 'a') patch.mover = 'b';
    else if (aFin != null) over = { result: 'a' };      // B's answering turn ended without finishing
    else { patch.mover = 'a'; patch.round = round + 1; }
  }

  if (over) { patch.state = 'done'; patch.result = over.result; }

  const newPos = patch[side + '_pos'] != null ? patch[side + '_pos'] : pos;
  const newHints = patch[side + '_hints'] != null ? patch[side + '_hints'] : hints;
  const prefix = newPos < n ? words[newPos].slice(0, 1 + newHints) : null;
  return {
    outcome, turnOver, solved: solvedNow ? answer : null, prefix, patch, over,
    /* a wrong guess is remembered, so the same guess is not counted twice */
    remember: outcome === 'wrong' ? action.guess : null,
  };
}

/* What one player may see of a duel. Never a word they have not solved. After the game
   the whole chain is shown to both. */
export function viewFor(d, side, tried = []) {
  const n = d.words.length;
  const mine = d[side + '_pos'], theirs = d[other(side) + '_pos'];
  const done = d.state === 'done';
  const v = {
    id: d.id,
    state: d.state,
    side,
    n,
    round: d.round,
    yourTurn: d.state === 'active' && d.mover === side,
    given: d.words[0],
    mine: {
      pos: mine,
      solved: d.words.slice(0, Math.min(mine, n)),
      prefix: mine < n ? d.words[mine].slice(0, 1 + d[side + '_hints']) : null,
      tried: mine < n ? tried : [],
      finished: mine >= n,
    },
    theirs: { pos: theirs, solvedCount: Math.min(theirs, n) - 1, finished: theirs >= n },
    /* the last turn of the other player's that ended in a miss or a Lifeline, for the list */
    finishedRoundYou: d[side + '_fin'],
    finishedRoundThem: d[other(side) + '_fin'],
  };
  if (done) {
    v.result = d.result === 'draw' ? 'draw' : d.result === side ? 'win' : 'loss';
    v.chain = d.words;
  }
  return v;
}
