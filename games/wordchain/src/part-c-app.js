/* Word Chain — app logic
   Two architectural notes worth keeping in mind while reading:

   1. Every verdict that can be decided locally is decided locally and instantly. Only the
      STRONG / WEAK / NONE distinction — a question of taste, not of correctness — is put
      to the model, the clock is frozen while it thinks, and every non-correct reply is
      held to a floor delay so response TIME never leaks the verdict before the words do.

   2. The game carries its own keyboard. Nothing on the board is a focusable text field,
      so no device ever raises a soft keyboard, and the three zones — bar, board, keyboard
      — stay exactly where they are put. */

var DATA = window.__WC_DATA__, DICT = window.__WC_DICT__;
var SITE = window.__WC_SITE__ || '';   /* where this copy of the game lives */
var PAIRS = DATA.pairs;
/* The chains. The game does NOT carry the bank: every chain is the game's own
   intellectual property, so the page holds only a small practice SEED (the first of the
   original chains, long since played as dailies) and asks the server for everything
   else, one chain at a time -- the day's chain, and top-ups for practice (see "the
   chains" below). The seed is scrambled in the page (build.py scramble_seed) so it does
   not read as a word list in the source. A screen, not a lock: the game has to read it.
   The page's copy of the data is also dropped from window. */
var BANK_KEY = 'wordchain-bank-v1';          // must match build.py (it checks)
var SEED = DATA.seed || [];                  // [{ id, d: scrambled chain }]
try { delete window.__WC_DATA__; } catch (e) { window.__WC_DATA__ = undefined; }
function wcFnv(s) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function wcStream(seed) {                    // xorshift32; build.py _stream() is the same
  var x = seed >>> 0 || 1;
  return function () {
    x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0;
    return x & 255;
  };
}
function unscramble(id, text) {
  var raw = atob(text), next = wcStream(wcFnv(BANK_KEY + '|' + id)), out = '';
  for (var k = 0; k < raw.length; k++) out += String.fromCharCode(raw.charCodeAt(k) ^ next());
  var c = JSON.parse(out); c.id = id;
  return c;
}
/* PAIRS: for each head word, the words that can follow it, as one string
   "STRONG WORDS|WEAK WORDS" (pairs.json). Strong = a pair anyone would know
   (FIRE ALARM); weak = real but marginal (FIRE OPAL). Unpacked on first use. */
var PAIR_CACHE = {};
function pairsOf(head) {
  if (PAIR_CACHE[head]) return PAIR_CACHE[head];
  var raw = PAIRS[head];
  if (raw == null) return (PAIR_CACHE[head] = null);
  /* "~" marks a partial list (a head added by hand, never swept A-Z): a pair
     missing from it is unknown rather than wrong. */
  var partial = raw.charAt(0) === '~';
  if (partial) raw = raw.slice(1);
  var parts = raw.split('|'), o = { s: {}, w: {}, partial: partial };
  (parts[0] || '').split(' ').forEach(function (x) { if (x) o.s[x] = 1; });
  (parts[1] || '').split(' ').forEach(function (x) { if (x) o.w[x] = 1; });
  return (PAIR_CACHE[head] = o);
}
/* The forms of a guess worth looking up: as typed, and singular/plural
   (ALARMS -> ALARM, ANT -> ANTS, BERRIES -> BERRY). */
function guessForms(g) {
  var f = [g, g + 'S', g + 'ES'];
  if (/S$/.test(g)) f.push(g.slice(0, -1));
  if (/ES$/.test(g)) f.push(g.slice(0, -2));
  if (/IES$/.test(g)) f.push(g.slice(0, -3) + 'Y');
  return f;
}
var $ = function (id) { return document.getElementById(id); };

/* ------------------------------------------------------------------ storage */
function store(k, v) {
  try {
    if (v === undefined) { var r = localStorage.getItem('wordchain:' + k); return r ? JSON.parse(r) : null; }
    localStorage.setItem('wordchain:' + k, JSON.stringify(v));
  } catch (e) { return null; }
}
function drop(k) { try { localStorage.removeItem('wordchain:' + k); } catch (e) {} }

/* ------------------------------------------------------------------ pruning
   Audit S2. `wordchain:daily:<key>` is written once per completed daily and never
   removed. On playsapien.com that series shares ONE 5 MB origin quota with
   Sojourner's `sojourner:<day>` series, so somebody has to prune it.

   packages/sdk/src/storage.js already does this properly — pruneOldDays(), with a
   once-a-day marker so a full keyspace scan does not happen on every load. Word
   Chain does not load the SDK yet, so this is a deliberately small, self-contained
   stand-in that matches the SDK's `^wordchain:daily:(\d{4}-\d{2}-\d{2})$` rule
   and its 90-day window exactly. When the SDK lands, delete all of this and call
   pruneOldDays(store) instead.

   What it must NOT touch — and the reason for the anchored regex:
     wordchain:set  wordchain:history  wordchain:last  wordchain:practiceAt
     wordchain:game:daily  wordchain:game:practice
     wordchain:friends  wordchain:puzzles  wordchain:archive
   None of them end in a date, so none of them match. The round-trip check in
   dayMsUTC() is the second guard: it is what makes a well-formed-but-impossible
   key like `wordchain:daily:2025-02-30` fail to parse rather than read as an
   ancient date and get dropped.

   The age here is measured in UTC, matching packages/sdk/src/daykey.js, even
   though todayKey() below is still local (audit S1). At a 90-day threshold the
   few hours of disagreement cannot change an outcome, and doing it this way means
   the pruner needs no change when S1 is settled. */
var PRUNE_DAYS = 90;
var DAY_MS = 86400000;
var DAILY_KEY_RE = /^wordchain:daily:(\d{4})-(\d{2})-(\d{2})$/;

/* midnight UTC for y/m/d, or null if that is not a real calendar date */
function dayMsUTC(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  var ms = Date.UTC(y, m - 1, d);
  if (!isFinite(ms)) return null;
  var t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) return null;
  return ms;
}

/* exported onto the closure only so the logic can be reasoned about in one place;
   `todayMs` is midnight UTC of the reference day. */
function isExpiredDailyKey(key, todayMs) {
  if (typeof key !== 'string') return false;
  var m = DAILY_KEY_RE.exec(key);
  if (!m) return false;
  var ms = dayMsUTC(+m[1], +m[2], +m[3]);
  if (ms === null) return false;
  return Math.round((todayMs - ms) / DAY_MS) > PRUNE_DAYS;
}

function pruneOldDailies() {
  try {
    var ls = window.localStorage;
    if (!ls || typeof ls.key !== 'function') return [];
    var now = new Date();
    var todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    /* collect first, delete second: removeItem() reindexes the store mid-loop */
    var doomed = [], i, k;
    for (i = 0; i < ls.length; i++) {
      k = ls.key(i);
      if (isExpiredDailyKey(k, todayMs)) doomed.push(k);
    }
    for (i = 0; i < doomed.length; i++) {
      try { ls.removeItem(doomed[i]); } catch (e) {}
    }
    return doomed;
  } catch (e) { return []; }
}
pruneOldDailies();

/* ------------------------------------------------------------------ settings */
/* The theme is NOT a Word Chain setting any more. It lives at localStorage
   `ps:theme`, is shared with the shell and Sojourner, and is owned end to end by
   PSTheme (packages/tokens/theme.js, inlined in <head> so it runs before paint).
   `theme` is dropped from any stored object left over from the old scheme —
   PSTheme has already migrated the value by the time this runs. `gentle` and
   `motion` are still ours. */
var SET = Object.assign({ gentle: false, motion: false }, store('set') || {});
delete SET.theme;
function saveSet() { store('set', SET); }

/* ------------------------------------------------------------------ rules
   Inflection, "is this guess the answer", the Lifeline costs and the calendar live in
   packages/scoring/wordchain.cjs, inlined here, because the server runs the very same
   code to check a finished daily (option D). */
/* ===== BEGIN packages/scoring/wordchain.cjs (inlined verbatim — do not edit here) ===== */
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

     `data` is the game's gamedata.json ({chains, calendar}). `chainOverride`, when the
     server has one, is the chain that day actually played ({id, words, links}) -- a
     player's chain the admin scheduled -- and is used instead of the calendar's.
     Returns { ok:true, chain, words, hints, penaltyMs, baseMs } or { ok:false, error }. */
  function verify(data, moves, dayKey, isWord, chainOverride) {
    function fail(code) { return { ok: false, error: code }; }
    if (!moves || typeof moves !== 'object' || moves.v !== 1) return fail('bad_moves');
    var chain, idx;
    if (chainOverride) { chain = chainOverride; idx = chainOverride.id; }
    else {
      var bank = data.chains;
      idx = idxForDay(data.calendar, bank.length, dayNumber(dayKey));
      chain = bank[idx];
    }
    var words = chain.words, links = chain.links, n = words.length;
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
/* ===== END packages/scoring/wordchain.cjs ===== */
var sameLemma = PSWordChain.sameLemma, lev = PSWordChain.lev;

/* ------------------------------------------------------------------ replies */
var REPLY = {
  correct: ['Yes.', "That's it.", 'Exactly.', 'Nailed it.', 'Clean.', 'Sharp.', 'There it is.'],
  strong: ['Good guess, but not the one I’m thinking of.', 'That works — it’s just not my word.',
    'Real pair. Wrong chain.', 'I’ll allow it as English. Not as the answer.', 'Nice one. Still no.'],
  weak: ['No… and I’m not so sure about that one either.', 'Hmm. That’s a stretch even before it’s wrong.',
    'Technically? Maybe. Correctly? No.', 'I’ve heard worse. Not many.',
    'That’s doing a lot of work for a word that isn’t right.'],
  none: ['{PREV} {GUESS}? That’s not one I know.', 'Bold. Wrong, but bold.',
    'Not a pair I’ve heard of — and not my word.', 'Hmm, {PREV} {GUESS}? No.',
    'No. Try another.'],
  unsure: ['Not the one I’m thinking of.', 'Not my word.', 'Not it. Try again.'],
  notword: ['Not a word. Try again.'],
  letter: ['Starts with {LETTER}.'],
  number: ['Right word. Wrong number.', 'That’s the word — check the ending.'],
  repeat: ['You’ve guessed that already.', 'Already tried that one.', 'That one’s been and gone.']
};
var LOCKOUT = { correct: 0, repeat: 900, strong: 900, notword: 1100, letter: 1100, number: 1100, weak: 1700, none: 2000, unsure: 1200 };
var FLOOR = 450;
var lastReply = {};
function pick(bucket, vars) {
  var list = REPLY[bucket] || REPLY.weak;
  if (list.length > 1) {
    var n = 0; do { n = Math.floor(Math.random() * list.length); } while (list[n] === lastReply[bucket] && list.length > 2);
    lastReply[bucket] = list[n];
  }
  var s = lastReply[bucket] || list[0];
  Object.keys(vars || {}).forEach(function (k) { s = s.split('{' + k + '}').join(vars[k]); });
  return s;
}

/* ------------------------------------------------------------------ chains */
/* KNOWN OPEN ITEM — audit S1. This is LOCAL time; Sojourner's dayKey() is UTC, and
   the settled answer (packages/sdk/src/daykey.js, BACKEND-SPEC.md) is UTC everywhere.
   Deliberately NOT changed in this pass: switching it moves the chain served at the
   day boundary, so it needs a migration decision for the existing
   `wordchain:daily:*` keys first. Do not "fix" this in passing. */
function todayKey() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayIndex() { return Math.floor(Date.now() / 86400000); }

function keyAgo(n) {
  var d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
/* A past day counts as done if it was played on the day or played later. */
function pastDone(key) { return store('daily:' + key) || store('past:' + key); }
function longDay(key) {
  var p = key.split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}
/* ------------------------------------------------------------------ the chains
   One chain a day for everyone, and it comes from the SERVER (GET /api/wordchain/chain/
   :day), not from the page: the server decides what today's chain is (lib/wcpools.js),
   serves no future day, and keeps the whole bank to itself. Once fetched, a day's chain is
   kept on the device, so a game in progress, or a day already opened, plays offline. The
   one thing that needs a connection is the FIRST open of a new day. */
function utcKey(n) { return PSWordChain.dayKeyOf(dayIndex() - (n || 0)); }
var CHAIN_KEEP_DAYS = 45;
function pruneChains() {
  try {
    var ls = window.localStorage, cutoff = utcKey(CHAIN_KEEP_DAYS), doomed = [], i, k, m;
    for (i = 0; i < ls.length; i++) {
      k = ls.key(i); m = /^wordchain:chain:(\d{4}-\d{2}-\d{2})$/.exec(k || '');
      if (m && m[1] < cutoff) doomed.push(k);
    }
    for (i = 0; i < doomed.length; i++) { try { ls.removeItem(doomed[i]); } catch (e) {} }
  } catch (e) {}
}
/* Resolves to the chain for a UTC day -- from the device if it has it, else the server --
   or to null when there is none to be had (offline, or the server said no). */
function chainFor(dayKey) {
  var c = store('chain:' + dayKey);
  if (c && c.words) return Promise.resolve(c);
  return loadPS().then(function (PS) {
    return PS ? PS.get('/wordchain/chain/' + dayKey) : null;
  }).then(function (r) {
    if (!r || !r.ok || !r.data || !r.data.chain || !r.data.chain.words) return null;
    store('chain:' + dayKey, r.data.chain); pruneChains();
    return r.data.chain;
  });
}

/* ------------------------------------------------------------------ practice
   Practice chains live on the device: the SEED in the page, plus whatever the server has
   handed over since (GET /api/wordchain/practice). The server decides what practice may
   draw from -- three pools, so the daily challenge stays fresh (lib/wcpools.js). The
   device only keeps its own small set playable offline, and tops it up when it has run
   through most of it. Finishing a practice chain is reported, which is how the admin sees
   how fast people get through them. */
var PRACTICE_LOW = 8, PRACTICE_KEEP = 60, TOPUP_N = 15, topping = false;
function practiceState() { var p = store('pool') || {}; return { have: p.have || [], seen: p.seen || [] }; }
function practiceIds(p) {
  var ids = SEED.map(function (x) { return x.id; });
  p.have.forEach(function (c) { if (ids.indexOf(c.id) < 0) ids.push(c.id); });
  return ids;
}
function practiceById(id, p) {
  for (var i = 0; i < p.have.length; i++) if (p.have[i].id === id) return p.have[i];
  for (var j = 0; j < SEED.length; j++) if (SEED[j].id === id) return unscramble(id, SEED[j].d);
  return null;
}
function practiceUnseen(p) { return practiceIds(p).filter(function (id) { return p.seen.indexOf(id) < 0; }); }
function practiceChain() {
  var p = practiceState(), ids = practiceIds(p), unseen = practiceUnseen(p);
  if (!unseen.length) {                      // seen them all: go round again, but not straight back to the last one
    var last = p.seen[p.seen.length - 1];
    p.seen = [];
    unseen = ids.filter(function (id) { return id !== last; });
    if (!unseen.length) unseen = ids;
  }
  var id = unseen[Math.floor(Math.random() * unseen.length)];
  p.seen.push(id);
  store('pool', p);
  if (unseen.length - 1 < PRACTICE_LOW) topUpPractice();
  return practiceById(id, p);
}
function topUpPractice() {
  if (topping) return;
  topping = true;
  loadPS().then(function (PS) {
    if (!PS) return null;
    var p = practiceState();
    return PS.get('/wordchain/practice?n=' + TOPUP_N + '&seen=' + practiceIds(p).join(','));
  }).then(function (r) {
    if (!r || !r.ok || !r.data || !r.data.chains) return;
    var p = practiceState(), ids = practiceIds(p);
    r.data.chains.forEach(function (c) {
      if (c && c.words && ids.indexOf(c.id) < 0) { p.have.push({ id: c.id, words: c.words, links: c.links }); ids.push(c.id); }
    });
    /* Keep the set a sensible size: when it is over, let the oldest ones already seen go. */
    while (p.have.length > PRACTICE_KEEP) {
      var drop = -1;
      for (var i = 0; i < p.have.length; i++) if (p.seen.indexOf(p.have[i].id) >= 0) { drop = i; break; }
      if (drop < 0) break;
      p.have.splice(drop, 1);
    }
    store('pool', p);
  }).then(function () { topping = false; }, function () { topping = false; });
}
function reportPractice(id) {
  loadPS().then(function (PS) { if (PS) PS.report('/wordchain/practice/played', { id: id }); });
}

/* ------------------------------------------------------------------ persistence */
var S = null, tick = null, sampler = null, samplerTried = false;
var HELD = { daily: null, practice: null, past: null, timed: null };
var pauseAt = 0, typed = '';

function baseMs() { return Date.now() - S.t0 - S.frozenMs; }
function save() {
  if (!S || S.done || S.mode === 'duel') return;       // a 1v1 is held by the server, not here
  store('game:' + S.mode, {
    mode: S.mode, words: S.words, links: S.links, i: S.i, revealed: S.revealed,
    hintsThisWord: S.hintsThisWord, hintCount: S.hintCount, penaltyMs: S.penaltyMs,
    baseMs: baseMs(), tried: S.tried, wrongThisWord: S.wrongThisWord,
    perWord: S.perWord, wordMs: S.wordMs, day: S.mode === 'past' ? S.day : todayKey(),
    finals: S.finals, run: S.run, utcDay: S.utcDay, chainId: S.chainId,
    chalId: S.chalId, oppName: S.oppName                  /* a timed challenge (timed.js) */
  });
}
function loadHeld(mode) {
  var g = store('game:' + mode);
  if (!g || !g.words || g.i >= g.words.length) return null;
  /* an unfinished daily from a previous day is stale - the chain has rolled over */
  if (mode === 'daily' && g.day !== todayKey()) { drop('game:daily'); return null; }
  return {
    mode: mode, words: g.words, links: g.links, i: g.i, revealed: g.revealed,
    hintsThisWord: g.hintsThisWord || 0, hintCount: g.hintCount || 0,
    penaltyMs: g.penaltyMs || 0, frozenMs: 0, t0: Date.now() - (g.baseMs || 0),
    perWord: g.perWord || [], wordMs: g.wordMs || [], wordT0: Date.now(),
    tried: g.tried || [], wrongThisWord: g.wrongThisWord || 0,
    locked: false, done: false, pausedAt: 0, day: g.day,
    finals: g.finals || [], run: g.run || null, utcDay: g.utcDay || null,
    chainId: g.chainId === undefined ? null : g.chainId,
    chalId: g.chalId === undefined ? null : g.chalId, oppName: g.oppName || null
  };
}
/* One circle per word, sized by that word's share of the total time, so the row
   reads as where the time went. Any Lifeline opens the ring and paints it accent —
   the same colour a bought letter wears on the board; more Lifelines thicken it.
   Ported from the deployed standalone game, which was ahead of both this repo and
   the local Word Chain folder. */
function dotsSVG(words, perWord, wordMs) {
  var n = words.length, ms = wordMs || [], tot = 0, i;
  for (i = 0; i < n; i++) tot += (ms[i] || 0);
  var gap = 34, pad = 20, w = (n - 1) * gap + pad * 2, h = 44, out = '';
  for (i = 0; i < n; i++) {
    var cx = pad + i * gap, used = (perWord || [])[i] || 0;
    var share = tot > 0 ? (ms[i] || 0) / tot : 1 / (n - 1);
    var r = 3.5 + Math.min(1, share * (n - 1)) * 6.5;
    if (used > 0) {
      out += '<circle cx="' + cx + '" cy="' + (h / 2) + '" r="' + r.toFixed(1) + '" fill="none" ' +
        'stroke="var(--accent)" stroke-width="' + (2 + (used - 1) * 1.8) + '"/>';
    } else {
      out += '<circle cx="' + cx + '" cy="' + (h / 2) + '" r="' + r.toFixed(1) + '" fill="currentColor"/>';
    }
  }
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + out + '</svg>';
}

function recordResult(r) {
  var h = store('history') || [];
  h.unshift(r); if (h.length > 60) h.length = 60;
  store('history', h);
}
function dailyDone() { return store('daily:' + todayKey()); }

/* ------------------------------------------------------------------ the platform
   A daily is ranked on TIME: this game's own clock, which stops while the player is
   paused or away, so a phone call never costs anyone time. When a fresh daily begins
   the game asks the server for a start stamp (a signed token); when the daily ends it
   sends how the chain was solved and the playing time, and the server adds the Lifeline
   penalty itself. The stamp only keeps the clock honest (a run cannot claim more
   playing time than the server saw pass).
   Nothing here may ever hold up play: /sdk.js is loaded only when there is something
   to ask or send, a failure is silent, and a daily played with no stamp (offline, or
   the server down) simply is not ranked -- it still counts for the player's own
   record. Past days and practice never come here. */
var psReady = null;
function loadPS() {
  if (!psReady) {
    psReady = import('/sdk.js').then(function (m) {
      var PS = m['default'];
      try { PS.init(); } catch (e) {}
      return PS;
    })['catch'](function () { return null; });
  }
  return psReady;
}
function beginRun(g) {
  if (!g.utcDay) return;
  loadPS().then(function (PS) {
    if (!PS || g.run) return null;
    return PS.startRun('wordchain', g.utcDay);
  }).then(function (r) {
    if (r && r.token && !g.run && g.utcDay === r.day) { g.run = r.token; if (S === g) save(); }
  });
}
/* How the chain was solved: per word, the guess that was accepted (null when the word
   was bought in full with Lifelines) and how many Lifelines went on it, plus the playing
   time on this game's clock (which stops while the player is paused or away), penalty
   not included -- the server works the penalty out itself. */
function movesOf(g, baseMs) {
  var finals = [], hints = [];
  for (var k = 0; k < g.words.length; k++) {
    finals.push(k === 0 ? null : (g.finals[k] || null));
    hints.push(k === 0 ? 0 : (g.perWord[k] || 0));
  }
  return { v: 1, finals: finals, hints: hints, baseMs: Math.max(0, Math.round(baseMs)) };
}
function markSent(dayKey) {
  var d = store('daily:' + dayKey);
  if (d) { d.sent = true; store('daily:' + dayKey, d); }
}
function sendDaily(dayKey, send, total) {
  return loadPS().then(function (PS) {
    if (!PS) return false;
    PS.saveResult({ game: 'wordchain', day: send.utcDay, mode: 'daily', score: send.links,
      maxScore: 7, durationMs: total, moves: send.moves, run: send.run });
    markSent(dayKey);
    return true;
  });
}
/* Today's and yesterday's finished dailies that never reached the platform client. */
function resendUnsent() {
  [todayKey(), keyAgo(1)].forEach(function (k) {
    var d = store('daily:' + k);
    if (d && d.send && !d.sent) sendDaily(k, d.send, d.total);
  });
}

/* ------------------------------------------------------------------ starting */
var starting = false;
function startGame(mode, past) {
  if (starting) return;
  /* One past day can be held at a time; starting a different one drops it. */
  if (mode === 'past' && HELD.past && HELD.past.day !== past.key) { HELD.past = null; drop('game:past'); }
  /* One timed challenge can be in progress on a device; finishing it comes first. */
  if (mode === 'timed' && HELD.timed && HELD.timed.chalId !== past.id) {
    PSUI.toast('Finish your other timed challenge first.');
    return;
  }
  if (HELD[mode]) {
    S = HELD[mode]; HELD[mode] = null;
    if (S.pausedAt) S.frozenMs += Date.now() - S.pausedAt;
    S.pausedAt = 0;
    show(mode);
    return;
  }
  if (mode === 'practice') { launch(mode, past, practiceChain()); return; }
  if (mode === 'timed') {
    starting = true;
    duApi('POST', '/timed/' + past.id + '/start').then(function (r) {
      starting = false;
      if (!r.ok) { PSUI.toast(duMsg(r.error)); return; }
      launch('timed', past, r.data.chain);
    });
    return;
  }
  starting = true;
  chainFor(utcKey(mode === 'past' ? past.n : 0)).then(function (c) {
    starting = false;
    if (!c) {
      PSUI.toast('Connect once to get ' + (mode === 'daily' ? 'today\u2019s' : 'that day\u2019s') +
        ' puzzle. Practice works offline.');
      return;
    }
    launch(mode, past, c);
  });
}
function launch(mode, past, c) {
  S = {
    mode: mode, words: c.words, links: c.links, i: 1,
    day: mode === 'past' ? past.key : todayKey(),
    revealed: c.words.map(function (w, k) { return k === 0 ? w.length : 1; }),
    hintsThisWord: 0, hintCount: 0, penaltyMs: 0, frozenMs: 0, perWord: [], wordMs: [],
    wrongThisWord: 0, tried: [], t0: Date.now(), wordT0: Date.now(),
    locked: false, done: false, finals: [], run: null, chainId: c.id,
    utcDay: PSWordChain.dayKeyOf(dayIndex())      // the day the chain was drawn for
  };
  if (mode === 'daily') beginRun(S);
  if (mode === 'timed') { S.chalId = past.id; S.oppName = past.opp || 'your friend'; }
  show(mode);
}
function show(mode) {
  typed = '';
  $('mode').textContent = mode === 'daily' ? 'Daily' : mode === 'past' ? 'Daily \u00b7 ' + longDay(S.day)
    : mode === 'timed' ? 'Timed \u00b7 vs ' + S.oppName : 'Practice';
  /* A 1v1 has no clock: just who gets to the end first. */
  $('clock').style.display = mode === 'duel' ? 'none' : '';
  if (mode === 'duel') duelLabel();
  $('home').hidden = true; $('app').hidden = false; $('compose').hidden = true;
  mountKeyboard($('app'));
  setInput(true); renderChain(); updateHintBtn(); renderBank(); setMsg('', null);
  if (tick) clearInterval(tick);
  tick = setInterval(paintClock, 200); paintClock();
  ensureSampler(); save();
}

function elapsedMs() { return Date.now() - S.t0 - S.frozenMs + S.penaltyMs; }
function fmt(ms) {
  var t = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}
function paintClock() { if (S) $('clock').textContent = fmt(elapsedMs()); }

/* ------------------------------------------------------------------ rendering */
function prefix() { return S.words[S.i].slice(0, S.revealed[S.i]); }

function renderTyped() {
  var el = $('typed'); el.innerHTML = '';
  for (var i = 0; i < typed.length; i++) {
    var ch = document.createElement('span'); ch.className = 'ch'; ch.textContent = typed[i];
    el.appendChild(ch);
  }
}
function setInput(on) {
  $('kb').classList.toggle('off', !on);
  $('caret').classList.toggle('off', !on);
  $('go').disabled = !on;
}

function renderChain() {
  var el = $('chain'), edit = $('editwrap'), msg = $('msg'), play = $('play');
  play.appendChild(edit); play.appendChild(msg);       /* park before the wipe */
  el.innerHTML = '';
  S.words.forEach(function (w, k) {
    var row = document.createElement('div');
    row.className = 'row ' + (k === 0 ? 'given' : k < S.i ? 'solved' : k === S.i ? 'current' : 'pending');
    var num = document.createElement('span'); num.className = 'num'; num.textContent = (k + 1);
    var wd = document.createElement('span'); wd.className = 'word';
    var show = k < S.i ? w.length : S.revealed[k];
    for (var j = 0; j < show; j++) {
      var ch = document.createElement('span');
      ch.className = 'ch' + (j > 0 && j <= (S.perWord[k] || 0) ? ' hinted' : '');
      ch.textContent = w[j]; wd.appendChild(ch);
    }
    row.appendChild(num); row.appendChild(wd);
    if (k === 0) {
      var g = document.createElement('span'); g.className = 'givenlab'; g.textContent = 'given'; row.appendChild(g);
    } else if (k < S.i) {
      var t = document.createElement('span'); t.className = 'tickmark';
      t.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
      row.appendChild(t);
    }
    el.appendChild(row);
    if (k === S.i && !S.done) { edit.hidden = false; row.appendChild(edit); el.appendChild(msg); }
  });
  if (S.done) { edit.hidden = true; el.appendChild(msg); }
  renderTyped();
  var cur = el.children[Math.min(S.i, el.children.length - 1)];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', behavior: SET.motion ? 'auto' : 'smooth' });
}

function setMsg(text, cls) {
  var m = $('msg'); m.hidden = false;
  if (!text) { m.className = ''; m.innerHTML = '&nbsp;'; return; }
  m.textContent = text; m.className = cls || '';
}
function setThinking() {
  var m = $('msg'); m.hidden = false; m.className = '';
  m.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
}

var HINT_COST = PSWordChain.HINT_COST;
function nextCost() { return HINT_COST[Math.min(S.hintsThisWord, 2)]; }
function updateHintBtn() {
  $('hintBtn').disabled = S.done || S.hintsThisWord >= 3 || S.locked;
  $('hintCost').textContent = S.mode === 'duel' ? 'ends turn' : '+' + nextCost() + 's';
}
function renderBank() {
  var w = $('bankwrap');
  if (!S.hintCount) { w.hidden = true; return; }
  w.hidden = false;
  var svg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M7 4l-2.75 2"/><path d="M17 4l2.75 2"/><path d="M10 13h4"/></svg>';
  $('bankicons').innerHTML = new Array(Math.min(S.hintCount, 5) + 1).join(svg);
  $('banktext').textContent = '+' + Math.round(S.penaltyMs / 1000) + 's';
}
function flash(text) {
  var f = $('flash'); f.textContent = text; f.classList.remove('go');
  void f.offsetWidth; f.classList.add('go');
}

/* ------------------------------------------------------------------ hints */
function takeHint() {
  if (!S || S.locked || S.done || S.hintsThisWord >= 3) return;
  if (S.mode === 'duel') { duelHint(); return; }
  var w = S.words[S.i], cost = nextCost();
  S.penaltyMs += cost * 1000; S.hintsThisWord++; S.hintCount++;
  S.perWord[S.i] = (S.perWord[S.i] || 0) + 1;
  S.revealed[S.i] = Math.min(S.revealed[S.i] + 1, w.length);
  typed = '';
  flash('+' + cost + 's'); renderBank(); paintClock(); save();
  if (S.revealed[S.i] >= w.length) { advance(); }
  else { renderChain(); updateHintBtn(); }
}

/* ------------------------------------------------------------------ the model */
function ensureSampler() {
  if (samplerTried) return; samplerTried = true;
  var judge = $('judgeState');
  var off = 'Offline — near misses are judged against a built-in list of compounds.';
  if (typeof window.claude === 'undefined' || !window.claude.use) { judge.textContent = off; return; }
  window.claude.use('sample').then(function (s) {
    sampler = s;
    judge.textContent = s ? 'Claude judges near misses as you play. The clock pauses while it thinks.' : off;
  }).catch(function () { judge.textContent = off; });
}
function localVerdict(prev, guess) {
  var p = pairsOf(prev);
  /* A head we know nothing about: say nothing about the pair rather than
     tell the player their (possibly perfectly good) pair is not a thing. */
  if (!p) return 'unsure';
  var f = guessForms(guess), i;
  for (i = 0; i < f.length; i++) if (p.s[f[i]]) return 'strong';
  for (i = 0; i < f.length; i++) if (p.w[f[i]]) return 'weak';
  return p.partial ? 'unsure' : 'none';
}
function askModel(prev, guess) {
  if (!sampler) return Promise.resolve(null);
  var p = 'You are judging a word-chain game. Question: is "' + prev + ' ' + guess +
    '" a recognisable English compound word or set phrase?\n' +
    'Answer with JSON only: {"verdict":"strong"} if it is well established (e.g. FIRE ENGINE, ' +
    'GAME ON, BOOK SHELF); {"verdict":"weak"} if it is attested but marginal, regional, technical ' +
    'or forced (e.g. WAY LAY, HOLE SAW); {"verdict":"none"} if the two words simply do not go ' +
    'together (e.g. FIRE SPOON). Judge the pair only.';
  return sampler.json(p, { modelTier: 'quick', cache: true }).then(function (r) {
    var v = r && r.verdict;
    return (v === 'strong' || v === 'weak' || v === 'none') ? v : null;
  }).catch(function () { return null; });
}

/* ------------------------------------------------------------------ adjudication */
function classify(guess) {
  if (S.mode === 'duel') return duelClassify(guess);
  var answer = S.words[S.i], prev = S.words[S.i - 1], link = S.links[S.i - 1];
  if (!guess) return Promise.resolve({ b: null });
  if (PSWordChain.guessCorrect(guess, answer, link, function (w) { return DICT.has(w); })) {
    return Promise.resolve({ b: 'correct' });
  }
  /* the right word in the wrong number, on a link that insists on the number */
  if (sameLemma(guess, answer)) return Promise.resolve({ b: 'number' });
  if (S.tried.indexOf(guess) >= 0) return Promise.resolve({ b: 'repeat' });
  /* a non-word is a non-word first: telling someone their invented string starts with
     the wrong letter is true but useless */
  if (!DICT.has(guess)) return Promise.resolve({ b: 'notword' });
  if (guess[0] !== answer[0]) return Promise.resolve({ b: 'letter' });
  var local = localVerdict(prev, guess);
  if (local === 'strong') return Promise.resolve({ b: 'strong' });
  return askModel(prev, guess).then(function (v) { return { b: v || local }; });
}

function fullGuess() {
  var pre = prefix(), g = pre + typed;
  /* typing the whole word out of habit doubles the prefix; undo that only when the
     doubled form is nonsense and the plain one is not */
  if (typed.indexOf(pre) === 0 && !DICT.has(g) && (typed === S.words[S.i] || DICT.has(typed))) g = typed;
  return g;
}

function submit() {
  if (!S || S.locked || S.done || !typed) return;
  var guess = fullGuess(), prev = S.words[S.i - 1], answer = S.words[S.i];
  S.locked = true; setInput(false); updateHintBtn();
  var t = Date.now(), freezeFrom = Date.now(), thinkTimer = setTimeout(setThinking, 600);

  classify(guess).catch(function () { return { b: 'weak' }; }).then(function (res) {
    try {
      clearTimeout(thinkTimer);
      var b = res.b;
      if (!b) { unlock(); return; }

      if (b === 'correct' && S.mode === 'duel') {
        typed = ''; setMsg(pick('correct'), 'good');
        duelApply(res.server.game, 'correct');
        return;
      }
      if (b === 'correct') {
        S.finals[S.i] = guess;                 // what the server replays
        typed = ''; setMsg(pick('correct'), 'good'); advance();
        setTimeout(function () { if (S && !S.done) setMsg('', null); }, 750);
        unlock(); return;
      }

      /* wrong: the player pays for the read, never for the round trip */
      S.frozenMs += Date.now() - freezeFrom;
      S.wrongThisWord++;
      if (b !== 'repeat' && S.tried.indexOf(guess) < 0) S.tried.push(guess);

      var eff = b;
      if (b === 'none' && (SET.gentle || S.wrongThisWord > 3)) eff = 'weak';
      var text = pick(eff, { PREV: prev, GUESS: guess, LETTER: answer[0] });

      setTimeout(function () {
        setMsg(text, null);
        $('typed').classList.add('dim');
        save();
        /* the guess lingers, greyed, then fades and the caret comes back */
        setTimeout(function () {
          var el = $('typed');
          el.classList.remove('dim'); el.classList.add('fading');
          setTimeout(function () {
            typed = ''; renderTyped(); el.classList.remove('fading');
            if (S && S.mode === 'duel' && res.server && res.server.turnOver) duelApply(res.server.game, 'wrong');
            else unlock();
          }, SET.motion ? 0 : 240);
        }, LOCKOUT[eff] || 1200);
      }, Math.max(0, FLOOR - (Date.now() - t)));
    } catch (err) { setMsg('', null); unlock(); }
  });
}

function unlock() {
  if (!S || S.done) return;
  S.locked = false; setInput(true); updateHintBtn();
}

function advance() {
  /* How long this word took. It is what sizes the circles on the home screen and
     the share card: the run shows where the player got stuck, not just the total. */
  S.wordMs[S.i] = Math.max(0, Date.now() - (S.wordT0 || S.t0));
  S.wordT0 = Date.now();
  S.revealed[S.i] = S.words[S.i].length;
  S.i++; S.hintsThisWord = 0; S.wrongThisWord = 0; S.tried = []; typed = '';
  if (S.i >= S.words.length) { finish(); return; }
  save(); renderChain(); updateHintBtn(); setInput(true); S.locked = false;
}

function finish() {
  S.done = true; S.locked = true;
  if (tick) { clearInterval(tick); tick = null; }
  renderChain(); paintClock(); setInput(false); $('hintBtn').disabled = true;
  setMsg('', null);
  var total = elapsedMs(), base = total - S.penaltyMs;
  if (S.mode === 'timed') { timedFinish(total, base); return; }       /* sent to the server, not kept here */
  var r = { day: S.mode === 'past' ? S.day : todayKey(), mode: S.mode, total: total, hints: S.hintCount,
            words: S.words, perWord: S.perWord, wordMs: S.wordMs };
  drop('game:' + S.mode);
  /* the full record, not just the time: the home screen shares this hours later, by
     which point `last` may be a practice run */
  if (S.mode === 'daily') {
    var sendable = S.utcDay ? {
      utcDay: S.utcDay, run: S.run, links: S.words.length - 1,
      moves: movesOf(S, base)
    } : null;
    store('daily:' + todayKey(), {
      mode: 'daily', day: todayKey(), total: total, hints: S.hintCount,
      words: S.words, perWord: S.perWord, wordMs: S.wordMs, send: sendable
    });
    if (sendable) sendDaily(todayKey(), sendable, total);
  }
  /* A past day is kept under its own key: it shows as played in the day row,
     and it is never mistaken for a daily -- not for the streak, not for the
     best daily time, and not for that day's ranking once results are sent. */
  if (S.mode === 'past') store('past:' + S.day, {
    mode: 'past', day: S.day, total: total, hints: S.hintCount, late: true,
    words: S.words, perWord: S.perWord, wordMs: S.wordMs
  });
  recordResult({ day: r.day, mode: r.mode, total: total, hints: S.hintCount, chain: S.words.join(' · ') });
  if (S.mode === 'practice' && S.chainId != null) reportPractice(S.chainId);
  store('last', r);

  $('resLine').innerHTML = S.mode === 'daily'
    ? 'You finished today’s chain in <b>' + fmt(total) + '</b>.'
    : S.mode === 'past'
    ? 'You finished the ' + longDay(S.day) + ' chain in <b>' + fmt(total) + '</b>.'
    : 'Practice chain, <b>' + fmt(total) + '</b>.';
  $('resBreak').textContent = S.hintCount
    ? 'base ' + fmt(base) + '  ·  ' + S.hintCount + ' lifeline' + (S.hintCount > 1 ? 's' : '') + ' +' + Math.round(S.penaltyMs / 1000) + 's'
    : 'no lifelines';
  $('resChain').innerHTML = chainHTML(S.words, S.perWord);

  /* Only the daily is shareable. A practice time is a private rehearsal - there is no
     shared chain behind it for anyone to compare against. Back to start becomes primary. */
  var isDaily = S.mode === 'daily';
  $('shareBtn').hidden = !isDaily;
  $('againBtn').className = isDaily ? 'btn ghost' : 'btn';
  prepCard(r);
  setTimeout(function () { $('results').classList.add('on'); }, 420);
}

/* A finished chain, with the letters that were bought still marked. Shared by the
   results card and the home screen so the two can never disagree. */
function chainHTML(words, perWord) {
  perWord = perWord || [];
  return words.map(function (w, k) {
    var out = '';
    for (var j = 0; j < w.length; j++) {
      out += '<span class="ch' + (j > 0 && j <= (perWord[k] || 0) ? ' hinted' : '') + '">' + w[j] + '</span>';
    }
    return '<span class="solword">' + out + '</span>';
  }).join('');
}

/* ------------------------------------------------------------------ the keyboard */
var KB = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
function mountKeyboard(parent) { parent.appendChild($('kb')); }

function buildKeyboard() {
  var kb = $('kb'); kb.innerHTML = '';
  KB.forEach(function (rowStr, ri) {
    var row = document.createElement('div'); row.className = 'kbrow';
    if (ri === 2) {
      var ent = document.createElement('button');
      ent.className = 'key wide'; ent.dataset.k = 'ENTER'; ent.textContent = 'ENTER';
      ent.setAttribute('aria-label', 'Submit'); row.appendChild(ent);
    }
    rowStr.split('').forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'key'; b.dataset.k = c; b.textContent = c; row.appendChild(b);
    });
    if (ri === 2) {
      var del = document.createElement('button');
      del.className = 'key wide'; del.dataset.k = 'DEL';
      del.setAttribute('aria-label', 'Delete');
      del.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6H9l-5 6 5 6h11a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/><path d="M16 9.5l-5 5"/><path d="M11 9.5l5 5"/></svg>';
      row.appendChild(del);
    }
    kb.appendChild(row);
  });
}
function press(k) {
  if (typeof C !== 'undefined' && C && !$('compose').hidden) { cPress(k); return; }
  if (!S || S.locked || S.done) return;
  if (k === 'ENTER') { submit(); return; }
  if (k === 'DEL') { if (typed) { typed = typed.slice(0, -1); renderTyped(); } return; }
  if (typed.length >= 14) return;
  typed += k; renderTyped();
}
function hit(k) {
  var el = $('kb').querySelector('[data-k="' + k + '"]');
  if (!el) return;
  el.classList.add('hit'); setTimeout(function () { el.classList.remove('hit'); }, 90);
}

/* ------------------------------------------------------------------ pause */
function askPause() {
  if (!S || S.done || $('pause').hidden === false) return;
  pauseAt = Date.now();
  $('app').classList.add('paused'); $('pause').hidden = false;
  setTimeout(function () { $('pauseNo').focus(); }, 40);
}
function resumePlay() {
  if (!S || !pauseAt) return;
  S.frozenMs += Date.now() - pauseAt; pauseAt = 0;
  $('pause').hidden = true; $('app').classList.remove('paused'); paintClock();
}
function goHome() {
  $('pause').hidden = true; $('app').classList.remove('paused');
  if (S && !S.done && S.mode !== 'duel') { S.pausedAt = pauseAt || Date.now(); HELD[S.mode] = S; save(); }
  pauseAt = 0;
  if (tick) { clearInterval(tick); tick = null; }
  S = null;
  $('app').hidden = true; $('home').hidden = false;
  var rh = document.querySelector('#results h2'); if (rh) rh.textContent = 'Chained.';   // a 1v1 card renames it
  $('results').classList.remove('on'); PSUI.close(); paintHome();
}

/* ------------------------------------------------------------------ sheets */
/* packages/ui/ui.js owns sheets and the toast now: one open at a time, Escape and
   a scrim click to close, [data-sheet-close] wired by delegation, and the focus
   trap this game did not have — a keyboard user could tab straight past the scrim
   into the home screen behind it. The local openSheet/closeSheets/toast that used
   to live here are gone; call PSUI.open / PSUI.close / PSUI.toast. The open class
   is `.sheet.on`, not `.sheet.up`. */
PSUI.init({
  sheets: ['aboutSheet', 'settingsSheet', 'mineSheet', 'shareSheet', 'duelWho', 'duelWhat', 'duelMineSheet', 'duelSaved'],
  scrim: 'scrim',
  toast: 'toast'
});

/* ------------------------------------------------------------------ home */
/* A past day already played: its result, on the same card a finish shows.
   Read-only -- a day is played once, past or present. */
function showPast(rec, key) {
  $('resLine').innerHTML = 'You finished the ' + longDay(key) + ' chain in <b>' + fmt(rec.total) + '</b>.';
  $('resBreak').textContent = rec.hints
    ? rec.hints + ' lifeline' + (rec.hints > 1 ? 's' : '') + ' used' : 'no lifelines';
  $('resChain').innerHTML = chainHTML(rec.words || [], rec.perWord);
  $('shareBtn').hidden = true;
  $('againBtn').className = 'btn';
  $('results').classList.add('on');
}

function paintHome() {
  var done = dailyDone(), p = $('practiceBtn');
  /* TODAY, then the days before it. Once today is played its button becomes
     the thing you want next -- sharing the score -- and the score itself sits
     large in the footer. */
  var days = [{ key: todayKey(), today: true, done: !!done,
                sub: done ? 'Share score' : (HELD.daily ? 'Resume' : 'Play') }];
  for (var i = 1; i <= PSUI.pastDays(); i++) {
    var k = keyAgo(i);
    days.push({ key: k, done: !!pastDone(k),
                sub: HELD.past && HELD.past.day === k ? 'Resume' : undefined });
  }
  $('dayRow').innerHTML = PSUI.dayButtons(days);
  PSUI.wireDayRow($('dayRow'));
  if (done) prepCard(done);               /* ready before the tap, not after it */
  p.textContent = HELD.practice ? 'Resume practice' : 'Practice';
  var dt = new Date();
  $('homeDate').textContent = dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  /* The finished score is the point of the screen, so it is set large and centred
     with the chain and the dots under it — not squeezed into the footer line, which
     is what this used to do. */
  var res = $('homeResult');
  if (done && done.words) {
    res.hidden = false;
    $('homeTime').textContent = fmt(done.total);
    $('homeLifelines').textContent = done.hints
      ? done.hints + ' lifeline' + (done.hints > 1 ? 's' : '') + ' used' : 'no lifelines';
    $('homeSolution').className = 'solutionline';
    $('homeSolution').innerHTML = chainHTML(done.words, done.perWord);
    $('homeDots').innerHTML = dotsSVG(done.words, done.perWord, done.wordMs);
  } else { res.hidden = true; }
  $('homeNote').textContent = done ? "Today's chain" : 'Chains by G2';
}
function paintSettings() {
  /* #themeSeg is painted by PSTheme.bindControl — see the wiring below. */
  /* aria-pressed, not aria-checked: ui.css's .toggle keys its knob off the
     pressed state, and a toggle button is the pattern the shared control uses. */
  $('gentleTog').setAttribute('aria-pressed', SET.gentle ? 'true' : 'false');
  $('motionTog').setAttribute('aria-pressed', SET.motion ? 'true' : 'false');
}
/* The Profile card is packages/ui's now -- the same card as the front
   door's, in this game's colours -- so the old per-game one (times, bests,
   streak) is gone from here. The history it read is still kept on this
   device, untouched; Analytics is where those numbers come back. */
/* ------------------------------------------------------------------ the share card */
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* The card is FIXED in the light rose, in both themes, and does not subscribe to
   PSTheme.onChange. It is an image people post publicly: it lands in someone
   else's timeline, next to someone else's theme, so "follows the player's
   theme" only decides which of two looks a stranger sees at random. Fixed also
   keeps it identical to og.png, icon-512.png and the favicon, so every public
   impression of Word Chain is the same colour. These literals are the light
   .wc-game values — --clay #EFCBDA and --fg #33262C — and must be updated by
   hand if those change; canvas cannot read a custom property. */
var CARD_BG = '#EFCBDA';        /* light --clay                                */
var CARD_INK = '#33262C';       /* light --fg  — 9.78:1 on CARD_BG             */
var CARD_INK_74 = 'rgba(51,38,44,.74)';
var CARD_INK_55 = 'rgba(51,38,44,.55)';
var CARD_INK_28 = 'rgba(51,38,44,.28)';
/* The Lifeline ring on the share card. Canvas cannot read a CSS variable, so
   this mirrors --accent for the Word Chain palette. */
var CARD_ACCENT = '#9E3B62';
/* .80, matching src-v16. The card already had a .74 ink for a different line;
   reusing it here would have quietly lightened the lifeline caption. */
var CARD_INK_80 = 'rgba(51,38,44,.80)';

function buildCard(r) {
  var cv = $('cardcv'), x = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  x.fillStyle = CARD_BG; x.fillRect(0, 0, W, H);
  x.textAlign = 'center'; x.fillStyle = CARD_INK;

  x.save(); x.translate(W / 2 - 30, 64); x.scale(2.5, 2.5);
  x.strokeStyle = CARD_INK; x.lineWidth = 1.9; x.lineCap = 'round'; x.lineJoin = 'round';
  x.stroke(new Path2D('M10.4 13.6a4.6 4.6 0 0 0 6.94.5l2.76-2.76a4.6 4.6 0 0 0-6.5-6.5l-1.58 1.57'));
  x.stroke(new Path2D('M13.6 10.4a4.6 4.6 0 0 0-6.94-.5L3.9 12.66a4.6 4.6 0 0 0 6.5 6.5l1.57-1.57'));
  x.restore();

  x.font = '900 72px Fraunces, Georgia, serif';
  x.fillText('Word Chain', W / 2, 216);
  x.font = '400 30px Fraunces, Georgia, serif';
  var dt = new Date();
  x.fillText(r.mode === 'daily'
    ? dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : 'Practice chain', W / 2, 262);

  var y;
  if (r.mode === 'daily') {
    /* One link per word. Its SIZE is the share of the total time that word took, so
       the run tells you where the player got stuck. Any Lifeline opens the ring and
       paints it accent, the same colour a bought letter wears on the board; more
       Lifelines only thicken it. */
    y = 358;
    var n = r.words.length, gap = 96, x0 = W / 2 - ((n - 1) * gap) / 2;
    var ms = r.wordMs || [], tot = 0, i;
    for (i = 0; i < n; i++) tot += (ms[i] || 0);
    for (i = 0; i < n; i++) {
      var cx = x0 + i * gap, used = (r.perWord || [])[i] || 0;
      var share = tot > 0 ? (ms[i] || 0) / tot : 1 / (n - 1);
      var rad = 9 + Math.min(1, share * (n - 1)) * 17;      /* 9px to 26px, average ~17 */
      x.beginPath(); x.arc(cx, y, rad, 0, Math.PI * 2);
      if (used > 0) {
        x.strokeStyle = CARD_ACCENT;
        x.lineWidth = 4.5 + (used - 1) * 4;
        x.stroke();
      } else { x.fillStyle = CARD_INK; x.fill(); }
    }
    y += 92;
  } else {
    x.font = '600 40px Fraunces, Georgia, serif';
    y = 340;
    for (var j = 0; j < r.words.length; j += 2) {
      x.fillText(r.words[j] + (r.words[j + 1] ? '  \u00b7  ' + r.words[j + 1] : ''), W / 2, y);
      y += 58;
    }
    y += 16;
  }

  x.fillStyle = CARD_INK;
  x.strokeStyle = CARD_INK_28; x.lineWidth = 2;
  x.beginPath(); x.moveTo(W / 2 - 180, y); x.lineTo(W / 2 + 180, y); x.stroke();

  x.font = '900 104px Fraunces, Georgia, serif';
  x.fillText(fmt(r.total), W / 2, y + 112);

  x.font = '600 40px Fraunces, Georgia, serif';
  x.fillStyle = CARD_INK_80;
  x.fillText(r.hints ? r.hints + ' lifeline' + (r.hints > 1 ? 's' : '') + ' used' : 'no lifelines',
    W / 2, y + 166);

  x.font = '400 26px Fraunces, Georgia, serif';
  x.fillStyle = CARD_INK_55;
  if (SITE) x.fillText(SITE.replace(/^https?:\/\//, '').replace(/\/$/, ''), W / 2, H - 34);

  return new Promise(function (res) { cv.toBlob(res, 'image/png'); });
}

function shareText(r) {
  return 'Word Chain — ' + (r.mode === 'daily' ? "today's chain" : 'practice') +
    ' in ' + fmt(r.total) + (r.hints ? ' (' + r.hints + ' lifeline' + (r.hints > 1 ? 's' : '') + ')' : ', no lifelines');
}

/* Some share targets drop `url` when files are attached, so the link goes into the text
   as well. Belt and braces beats a share nobody can act on. */
function sharePayload(r) {
  var t = shareText(r);
  return { text: SITE ? t + '\n' + SITE : t, url: SITE || undefined };
}

/* The share sheet may only be opened from a live user gesture, and that permission is
   spent the moment we await anything. Waiting on fonts and on canvas encoding was enough
   to lose it, which is why sharing silently degraded to a clipboard copy. So the card is
   drawn AHEAD of the tap - as soon as a result exists - and the tap itself does nothing
   but call navigator.share synchronously with the file already in hand. */
var cardFile = null, cardFor = null;
function cardKey(r) { return r.mode + '|' + (r.day || '') + '|' + r.total + '|' + r.hints; }

function prepCard(r) {
  if (!r || !r.words) return;
  if (cardFor === cardKey(r) && cardFile) return;
  var ready = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  ready.then(function () { return buildCard(r); }).then(function (blob) {
    if (!blob) return;
    try { cardFile = new File([blob], 'word-chain.png', { type: 'image/png' }); }
    catch (e) { cardFile = null; return; }          /* no File constructor: text only */
    cardFor = cardKey(r);
  }).catch(function () { cardFile = null; cardFor = null; });
}

function copyFallback(txt) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(function () { PSUI.toast('Copied'); }, function () { PSUI.toast(txt); });
  } else PSUI.toast(txt);
}

function doShare(res) {
  var r = res || store('last'); if (!r) return;
  var pay = sharePayload(r), txt = pay.text;
  var after = function (e) {
    if (e && (e.name === 'AbortError' || e.name === 'CanceledError')) return;   /* sheet dismissed */
    copyFallback(txt);
  };

  /* everything from here to navigator.share is synchronous, on purpose */
  var f = (cardFor === cardKey(r)) ? cardFile : null;
  if (f && navigator.canShare && navigator.canShare({ files: [f] })) {
    var d = { files: [f], text: txt };
    /* some targets refuse text+url alongside a file; keep the file, drop the url */
    if (pay.url && navigator.canShare({ files: [f], text: txt, url: pay.url })) d.url = pay.url;
    try { var pr = navigator.share(d); if (pr && pr.catch) pr.catch(after); return; }
    catch (e) { /* fall through to text */ }
  }
  if (navigator.share) {
    try {
      var t = pay.url ? { text: shareText(r), url: pay.url } : { text: txt };
      var p2 = navigator.share(t); if (p2 && p2.catch) p2.catch(after); return;
    } catch (e) { /* fall through */ }
  }
  copyFallback(txt);
  /* the card was not ready in time; have it ready for the next tap */
  prepCard(r);
}

/* ------------------------------------------------------------------ wiring */
buildKeyboard();
$('kb').addEventListener('click', function (e) {
  var b = e.target.closest('.key'); if (!b) return;
  press(b.dataset.k);
});
$('go').addEventListener('click', submit);
$('hintBtn').addEventListener('click', takeHint);
$('homeBtn').addEventListener('click', function () { if (S && S.done) goHome(); else askPause(); });
$('pauseNo').addEventListener('click', resumePlay);
$('pauseYes').addEventListener('click', goHome);
/* Earlier days carry data-gate="sapien": the shared bar layer answers anyone
   else before this handler ever runs. */
$('dayRow').addEventListener('click', function (e) {
  var b = e.target.closest('button[data-day]'); if (!b) return;
  var key = b.getAttribute('data-day');
  if (key === todayKey()) {
    var done = dailyDone();
    if (done) doShare(done); else startGame('daily');
    return;
  }
  var rec = pastDone(key);
  if (rec) { showPast(rec, key); return; }
  for (var n = 1; n <= PSUI.pastDays(); n++) {
    if (keyAgo(n) === key) { startGame('past', { key: key, n: n }); return; }
  }
});
$('practiceBtn').addEventListener('click', function () { startGame('practice'); });
$('timedBtn').addEventListener('click', function () { PSUI.open('timedSheet'); });
$('duelBtn').addEventListener('click', function () { PSUI.open('duelSheet'); });

/* The badge on 1v1: how many games are waiting on THIS player's move. Fed by
   the server when the feature is wired; the number is hidden rather than shown
   as 0, because a badge reading zero is a notification that there is nothing to
   notify you about. */
function paintTurnBadge(n) {
  var b = $('duelBadge');
  if (!b) return;
  b.textContent = n > 9 ? '9+' : String(n);
  b.hidden = !n;
  b.setAttribute('aria-label', n === 1 ? '1 game awaiting your move'
                                       : n + ' games awaiting your move');
  b.setAttribute('aria-hidden', n ? 'false' : 'true');
}
window.PSWC_setTurns = paintTurnBadge;      /* until the server feeds it */
$('aboutBtn').addEventListener('click', function () { PSUI.open('aboutSheet'); });
$('settingsBtn').addEventListener('click', function () { paintSettings(); PSUI.open('settingsSheet'); });
/* Profile: wired by packages/ui, the same card on every surface. */
/* The scrim click and every [data-sheet-close] button are PSUI.init's, by delegation. */
PSTheme.bindControl($('themeSeg'));
$('gentleTog').addEventListener('click', function () { SET.gentle = !SET.gentle; saveSet(); paintSettings(); });
$('motionTog').addEventListener('click', function () { SET.motion = !SET.motion; saveSet(); paintSettings(); });
$('againBtn').addEventListener('click', goHome);
$('shareBtn').addEventListener('click', function () { doShare(); });

/* Layer guard, in the CAPTURE phase so it runs before ui.js's document listener.
   PSUI's focus trap assumes the open sheet is the topmost layer. Word Chain stacks
   two dialogs above one — #confirm (z-46; "Delete this chain?" is asked from inside
   My chains) and #pause (z-45) — and while either is up, Escape must close IT and
   not the sheet underneath, and Tab must not be dragged back into that sheet.
   ui.js has no notion of a layer above a sheet; see the report. */
document.addEventListener('keydown', function (e) {
  var up = $('confirm').hidden === false ? 'confirm'
         : ($('pause').hidden === false ? 'pause' : null);
  if (!up) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (up === 'confirm') closeConfirm(); else resumePlay();
  } else if (e.key === 'Tab') {
    e.stopPropagation();
  }
}, true);

/* a real keyboard, where there is one */
document.addEventListener('keydown', function (e) {
  /* Escape belongs to whichever layer is up: the guard above answers it for
     #confirm and #pause, and PSUI answers it for an open sheet. */
  if (e.key === 'Escape') return;
  var composing = (typeof C !== 'undefined') && C && !$('compose').hidden;
  if ($('pause').hidden === false || $('confirm').hidden === false) return;
  if (document.querySelector('.sheet.on')) return;
  if (!composing && (!S || S.done || S.locked)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); hit('ENTER'); press('ENTER'); return; }
  if (e.key === 'Backspace') { e.preventDefault(); hit('DEL'); press('DEL'); return; }
  if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); var k = e.key.toUpperCase(); hit(k); press(k); }
});

setTimeout(resendUnsent, 4000);
setTimeout(resendTimed, 5000);
setTimeout(function () {
  if (!HELD.daily && !dailyDone()) chainFor(utcKey(0));                 // today's chain, ready before the tap
  if (practiceUnseen(practiceState()).length < PRACTICE_LOW + 4) topUpPractice();
}, 2500);
HELD.daily = loadHeld('daily');
HELD.practice = loadHeld('practice');
HELD.past = loadHeld('past');
HELD.timed = loadHeld('timed');
paintHome(); paintSettings();
document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });
window.addEventListener('pagehide', save);

var awayAt = 0;
window.addEventListener('blur', function () { if (S && !S.done && !pauseAt && !awayAt) awayAt = Date.now(); });
window.addEventListener('focus', function () {
  if (S && !S.done && awayAt) { S.frozenMs += Date.now() - awayAt; awayAt = 0; paintClock(); }
});
