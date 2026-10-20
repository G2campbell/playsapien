/* Word Chain's rules that the server needs to check -- the one copy.

   Option D (docs/notes/offline-and-score-integrity.md), stage 2. Word Chain has
   no points: the result is a running clock, plus a penalty for every Lifeline
   (hint) taken. So what the game sends is not a score but a record of how the
   chain was solved, and the server checks three things from it:

     - every word was either typed correctly or revealed in full by Lifelines,
       judged by the very same rule the game uses (guessCorrect below);
     - the Lifelines taken, from which the penalty is worked out here, not
       believed;
     - which chain it was, from the day, by the same calendar the game reads.

   The time is the game's own clock -- the playing time, which stops while the
   player is paused or away (a phone call must never cost anyone time). It travels
   in the record as baseMs and the server adds the Lifeline penalty it worked out
   itself. The server's own stamps only keep that honest: see lib/wordchain.js.

   Like packages/scoring/sojourner.cjs this is ES5 with no DOM, clock or network,
   inlined into games/wordchain/src/part-c-app.js between marker comments
   (packages/tokens/sync-inline.mjs keeps it identical) and imported by the
   Worker (backend/src/lib/wordchain.js). It is moved, not rewritten, from
   part-c-app.js: the inflection helpers, the correctness test from classify(),
   the calendar and the Lifeline costs. */
var PSWordChain = (function () {
  "use strict";

  /* ------------------------------------------------------------ inflection */
  function plural(w) {
    if (/(S|X|Z|CH|SH)$/.test(w)) return w + 'ES';
    if (/[^AEIOU]Y$/.test(w)) return w.slice(0, -1) + 'IES';
    return w + 'S';
  }
  function singular(w) {
    if (/IES$/.test(w) && w.length > 4) return w.slice(0, -3) + 'Y';
    if (/(SS|XE|ZE|CHE|SHE)S$/.test(w)) return w.slice(0, -2);
    if (/S$/.test(w) && !/SS$/.test(w)) return w.slice(0, -1);
    return null;
  }
  function numberForms(w) {
    var s = new Set([w]); s.add(plural(w));
    var sg = singular(w); if (sg) { s.add(sg); s.add(plural(sg)); }
    return s;
  }
  function sameLemma(a, b) {
    if (a === b) return true;
    var fa = numberForms(a), fb = numberForms(b), hit = false;
    fa.forEach(function (x) { if (fb.has(x)) hit = true; });
    return hit;
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 9;
    var m = a.length, n = b.length, prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur.slice();
    }
    return prev[n];
  }

  /* Is this guess the answer? Exact; or the same word in another number, unless
     this link is number-strict ("right word, wrong number"); or one letter out
     and not itself a word (a typo is forgiven, a different word is not).
     `isWord` is the game's dictionary. */
  function guessCorrect(guess, answer, link, isWord) {
    if (guess === answer) return true;
    if (sameLemma(guess, answer)) return !(link && link.numberStrict);
    return lev(guess, answer) === 1 && !isWord(guess);
  }

  /* --------------------------------------------------------------- lifelines */
  /* The first Lifeline on a word costs 15 seconds, the second 25, the third 40.
     Each reveals one more letter; a word can be bought in full only if it is
     short enough for three. */
  var HINT_COST = [15, 25, 40];
  var MAX_HINTS = 3;
  function hintsCost(h) {
    var s = 0;
    for (var k = 0; k < h; k++) s += HINT_COST[Math.min(k, 2)];
    return s;
  }

  /* ---------------------------------------------------------------- calendar */
  /* One chain a day for everyone. The bank is the original hand-made chains
     (cal.legacy of them) followed by the new ones in calendar order. Days before
     cal.start keep the old rotation; from cal.start each day takes the next new
     chain. `d` is the UTC day number (days since 1970-01-01). */
  function idxForDay(cal, bankLength, d) {
    var L = cal.legacy, n = bankLength - L;
    if (!cal.start || n <= 0 || d < cal.start) return ((d % L) + L) % L;
    return L + (d - cal.start) % n;
  }
  function dayNumber(dayKey) {
    var p = dayKey.split('-');
    return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function dayKeyOf(dayNum) {
    return new Date(dayNum * 86400000).toISOString().slice(0, 10);
  }

  /* The record of a daily, replayed.

       moves = { v:1,
                 finals:[null, 'ARM', 'CHAIR', ...],   // the guess that was accepted, per word
                 hints: [0, 0, 1, ...],                // Lifelines taken, per word
                 baseMs: 94210 }                       // the game's playing time, penalty NOT included

     Index 0 is the word the game gives; every other word was either typed (a
     final guess) or bought in full (no final guess, and exactly as many
     Lifelines as it takes to show every letter).

     `data` is the game's gamedata.json ({chains, calendar}). Returns
     { ok:true, chain, words, hints, penaltyMs, baseMs } or { ok:false, error }. */
  function verify(data, moves, dayKey, isWord) {
    function fail(code) { return { ok: false, error: code }; }
    if (!moves || typeof moves !== 'object' || moves.v !== 1) return fail('bad_moves');
    var bank = data.chains, idx = idxForDay(data.calendar, bank.length, dayNumber(dayKey));
    var chain = bank[idx], words = chain.words, links = chain.links, n = words.length;
    if (!Array.isArray(moves.finals) || moves.finals.length !== n) return fail('bad_moves');
    if (!Array.isArray(moves.hints) || moves.hints.length !== n) return fail('bad_moves');

    var totalHints = 0, penalty = 0;
    for (var i = 1; i < n; i++) {
      var h = moves.hints[i], g = moves.finals[i], len = words[i].length;
      if (typeof h !== 'number' || h !== Math.floor(h) || h < 0 || h > MAX_HINTS) return fail('bad_moves');
      if (g === null) {
        /* Bought in full: the last Lifeline is the one that completes it. */
        if (h !== len - 1) return fail('not_solved');
      } else {
        if (typeof g !== 'string' || !/^[A-Z]{1,40}$/.test(g)) return fail('bad_moves');
        /* A word already shown in full needs no guess, and the game moves on. */
        if (h > len - 2) return fail('bad_moves');
        if (!guessCorrect(g, words[i], links[i - 1], isWord)) return fail('not_solved');
      }
      totalHints += h; penalty += hintsCost(h);
    }
    if (moves.finals[0] !== null || moves.hints[0] !== 0) return fail('bad_moves');
    var base = moves.baseMs;
    if (typeof base !== 'number' || base !== Math.floor(base) || base < 0 || base > 6 * 3600000) return fail('bad_moves');
    return { ok: true, chain: idx, words: words, hints: totalHints, penaltyMs: penalty * 1000, baseMs: base };
  }

  return {
    plural: plural, singular: singular, numberForms: numberForms, sameLemma: sameLemma, lev: lev,
    guessCorrect: guessCorrect, HINT_COST: HINT_COST, MAX_HINTS: MAX_HINTS, hintsCost: hintsCost,
    idxForDay: idxForDay, dayNumber: dayNumber, dayKeyOf: dayKeyOf, verify: verify
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PSWordChain;
