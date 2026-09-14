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
var LEX = DATA.lex, BANK = DATA.chains;
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
var SET = Object.assign({ theme: 'light', gentle: false, motion: false }, store('set') || {});
function saveSet() { store('set', SET); }
function applyTheme() {
  if (SET.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', SET.theme);
}
applyTheme();

/* ------------------------------------------------------------------ inflection */
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

/* ------------------------------------------------------------------ replies */
var REPLY = {
  correct: ['Yes.', "That's it.", 'Exactly.', 'Nailed it.', 'Clean.', 'Sharp.', 'There it is.'],
  strong: ['Good guess, but not the one I’m thinking of.', 'That works — it’s just not my word.',
    'Real pair. Wrong chain.', 'I’ll allow it as English. Not as the answer.', 'Nice one. Still no.'],
  weak: ['No… and I’m not so sure about that one either.', 'Hmm. That’s a stretch even before it’s wrong.',
    'Technically? Maybe. Correctly? No.', 'I’ve heard worse. Not many.',
    'That’s doing a lot of work for a word that isn’t right.'],
  none: ['Really, since when is {PREV} {GUESS} a thing?! NO.', '{PREV} {GUESS}. Say it out loud. Now don’t.',
    'Bold. Wrong, but bold.', 'That’s just two words standing near each other.',
    'No. Not even close enough to argue about.'],
  notword: ['Not a word. Try again.'],
  letter: ['Starts with {LETTER}.'],
  number: ['Right word. Wrong number.', 'That’s the word — check the ending.'],
  repeat: ['You’ve guessed that already.', 'Already tried that one.', 'That one’s been and gone.']
};
var LOCKOUT = { correct: 0, repeat: 900, strong: 900, notword: 1100, letter: 1100, number: 1100, weak: 1700, none: 2400 };
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

/* One chain a day for everyone, drawn from the whole bank regardless of its graded
   level. Practice walks the rest of the bank and never serves the day's chain, so
   warming up cannot spoil the challenge. */
function dailyIdx() { return dayIndex() % BANK.length; }
function dailyChain() { return BANK[dailyIdx()]; }
function practiceChain() {
  var at = store('practiceAt') || 0, d = dailyIdx(), i = at % BANK.length, guard = 0;
  while (i === d && guard++ < BANK.length) i = (i + 1) % BANK.length;
  store('practiceAt', i + 1);
  return BANK[i];
}

/* ------------------------------------------------------------------ persistence */
var S = null, tick = null, sampler = null, samplerTried = false;
var HELD = { daily: null, practice: null };
var pauseAt = 0, typed = '';

function baseMs() { return Date.now() - S.t0 - S.frozenMs; }
function save() {
  if (!S || S.done) return;
  store('game:' + S.mode, {
    mode: S.mode, words: S.words, links: S.links, i: S.i, revealed: S.revealed,
    hintsThisWord: S.hintsThisWord, hintCount: S.hintCount, penaltyMs: S.penaltyMs,
    baseMs: baseMs(), tried: S.tried, wrongThisWord: S.wrongThisWord,
    perWord: S.perWord, day: todayKey()
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
    perWord: g.perWord || [],
    tried: g.tried || [], wrongThisWord: g.wrongThisWord || 0,
    locked: false, done: false, pausedAt: 0
  };
}
function recordResult(r) {
  var h = store('history') || [];
  h.unshift(r); if (h.length > 60) h.length = 60;
  store('history', h);
}
function dailyDone() { return store('daily:' + todayKey()); }

/* ------------------------------------------------------------------ starting */
function startGame(mode) {
  if (HELD[mode]) {
    S = HELD[mode]; HELD[mode] = null;
    if (S.pausedAt) S.frozenMs += Date.now() - S.pausedAt;
    S.pausedAt = 0;
  } else {
    var c = mode === 'daily' ? dailyChain() : practiceChain();
    S = {
      mode: mode, words: c.words, links: c.links, i: 1,
      revealed: c.words.map(function (w, k) { return k === 0 ? w.length : 1; }),
      hintsThisWord: 0, hintCount: 0, penaltyMs: 0, frozenMs: 0, perWord: [],
      wrongThisWord: 0, tried: [], t0: Date.now(), locked: false, done: false
    };
  }
  typed = '';
  $('mode').textContent = mode === 'daily' ? 'Daily' : 'Practice';
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

var HINT_COST = [15, 25, 40];
function nextCost() { return HINT_COST[Math.min(S.hintsThisWord, 2)]; }
function updateHintBtn() {
  $('hintBtn').disabled = S.done || S.hintsThisWord >= 3 || S.locked;
  $('hintCost').textContent = '+' + nextCost() + 's';
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
  var list = LEX[prev];
  if (list && list.indexOf(guess) >= 0) return 'strong';
  if (!list || !list.length) return 'weak';
  return 'none';
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
  var answer = S.words[S.i], prev = S.words[S.i - 1], link = S.links[S.i - 1];
  if (!guess) return Promise.resolve({ b: null });
  if (guess === answer) return Promise.resolve({ b: 'correct' });
  if (sameLemma(guess, answer)) return Promise.resolve({ b: link.numberStrict ? 'number' : 'correct' });
  if (lev(guess, answer) === 1 && !DICT.has(guess)) return Promise.resolve({ b: 'correct' });
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

      if (b === 'correct') {
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
            typed = ''; renderTyped(); el.classList.remove('fading'); unlock();
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
  var r = { day: todayKey(), mode: S.mode, total: total, hints: S.hintCount,
            words: S.words, perWord: S.perWord };
  drop('game:' + S.mode);
  /* the full record, not just the time: the home screen shares this hours later, by
     which point `last` may be a practice run */
  if (S.mode === 'daily') store('daily:' + todayKey(), {
    mode: 'daily', day: todayKey(), total: total, hints: S.hintCount,
    words: S.words, perWord: S.perWord
  });
  recordResult({ day: r.day, mode: r.mode, total: total, hints: S.hintCount, chain: S.words.join(' · ') });
  store('last', r);

  $('resLine').innerHTML = S.mode === 'daily'
    ? 'You finished today’s chain in <b>' + fmt(total) + '</b>.'
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
  if (S && !S.done) { S.pausedAt = pauseAt || Date.now(); HELD[S.mode] = S; save(); }
  pauseAt = 0;
  if (tick) { clearInterval(tick); tick = null; }
  S = null;
  $('app').hidden = true; $('home').hidden = false;
  $('results').classList.remove('on'); closeSheets(); paintHome();
}

/* ------------------------------------------------------------------ sheets */
var SHEETS = ['aboutSheet', 'friendsSheet', 'settingsSheet', 'profileSheet', 'mineSheet', 'shareSheet'];
function openSheet(id) {
  SHEETS.forEach(function (s) { $(s).classList.remove('up'); });
  $(id).classList.add('up'); $('scrim').classList.add('on');
}
function closeSheets() {
  SHEETS.forEach(function (s) { $(s).classList.remove('up'); });
  $('scrim').classList.remove('on');
}

/* ------------------------------------------------------------------ home */
function paintHome() {
  var done = dailyDone();
  var d = $('dailyBtn'), p = $('practiceBtn');
  if (done) {
    /* the challenge is spent, so the button stops being a way in and becomes the thing
       you actually want next - the score itself moves down to the footer line */
    d.disabled = false;
    d.textContent = 'Share your score';
    d.dataset.act = 'share';
    prepCard(done);                       /* ready before the tap, not after it */
  } else {
    d.disabled = false;
    d.dataset.act = 'play';
    d.textContent = HELD.daily ? 'Resume daily challenge' : 'Play daily challenge';
  }
  p.textContent = HELD.practice ? 'Resume practice' : 'Practice';
  var dt = new Date();
  $('homeDate').textContent = dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  var sol = $('homeSolution');
  if (done && done.words) {
    sol.hidden = false;
    sol.className = 'solutionline';
    sol.innerHTML = chainHTML(done.words, done.perWord);
  } else { sol.hidden = true; }
  $('homeNote').textContent = done
    ? "Today's chain \u00b7 " + fmt(done.total) +
      (done.hints ? ' \u00b7 ' + done.hints + ' lifeline' + (done.hints > 1 ? 's' : '') : ' \u00b7 no lifelines')
    : 'Chains by G2';
}
function paintSettings() {
  [].forEach.call($('themeSeg').children, function (b) {
    b.setAttribute('aria-pressed', b.dataset.theme === SET.theme ? 'true' : 'false');
  });
  $('gentleTog').setAttribute('aria-checked', SET.gentle ? 'true' : 'false');
  $('motionTog').setAttribute('aria-checked', SET.motion ? 'true' : 'false');
}
function paintProfile() {
  var h = store('history') || [], box = $('profileBody');
  if (!h.length) return;
  var bd = null, bp = null, streak = 0;
  h.forEach(function (r) {
    if (r.mode === 'daily') { if (bd === null || r.total < bd) bd = r.total; }
    else if (bp === null || r.total < bp) bp = r.total;
  });
  var days = {}; h.forEach(function (r) { if (r.mode === 'daily') days[r.day] = 1; });
  var probe = new Date();
  for (;;) {
    var k = probe.getFullYear() + '-' + String(probe.getMonth() + 1).padStart(2, '0') + '-' + String(probe.getDate()).padStart(2, '0');
    if (days[k]) { streak++; probe.setDate(probe.getDate() - 1); }
    else if (streak === 0 && k === todayKey()) { probe.setDate(probe.getDate() - 1); }
    else break;
  }
  var out = ['<div class="setlabel">Your times</div><div class="bests">',
    '<div class="best"><span class="bl">Daily best</span><span class="bt">' + (bd !== null ? fmt(bd) : '—') + '</span></div>',
    '<div class="best"><span class="bl">Practice best</span><span class="bt">' + (bp !== null ? fmt(bp) : '—') + '</span></div>',
    '<div class="best"><span class="bl">Streak</span><span class="bt">' + streak + '</span></div>',
    '</div><div class="setlabel" style="margin-top:22px">Finished</div><div class="hist">'];
  h.slice(0, 12).forEach(function (r) {
    var parts = r.chain.split(' · ');
    out.push('<div class="hrow"><span class="hl">' + r.mode + '</span><span class="hc">' +
      parts[0] + ' … ' + parts[parts.length - 1] + '</span><span class="ht">' +
      fmt(r.total) + (r.hints ? ' · ' + r.hints + 'L' : '') + '</span></div>');
  });
  out.push('</div>');
  box.innerHTML = out.join('');
}
function toast(t) {
  var el = $('toast'); el.textContent = t; el.classList.add('on');
  setTimeout(function () { el.classList.remove('on'); }, 2600);
}

/* ------------------------------------------------------------------ the share card */
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function buildCard(r) {
  var cv = $('cardcv'), x = cv.getContext('2d');
  var W = cv.width, H = cv.height;
  x.fillStyle = '#D4B072'; x.fillRect(0, 0, W, H);
  x.textAlign = 'center'; x.fillStyle = '#1F1A14';

  /* the mark, drawn from the same path as the app icon */
  x.save(); x.translate(W / 2 - 46, 120); x.scale(3.85, 3.85);
  x.strokeStyle = '#1F1A14'; x.lineWidth = 1.9; x.lineCap = 'round'; x.lineJoin = 'round';
  var p1 = new Path2D('M10.4 13.6a4.6 4.6 0 0 0 6.94.5l2.76-2.76a4.6 4.6 0 0 0-6.5-6.5l-1.58 1.57');
  var p2 = new Path2D('M13.6 10.4a4.6 4.6 0 0 0-6.94-.5L3.9 12.66a4.6 4.6 0 0 0 6.5 6.5l1.57-1.57');
  x.stroke(p1); x.stroke(p2); x.restore();

  x.font = '900 86px Fraunces, Georgia, serif';
  x.fillText('Word Chain', W / 2, 302);

  x.font = '400 36px Fraunces, Georgia, serif';
  var dt = new Date();
  x.fillText(r.mode === 'daily'
    ? dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : 'Practice chain', W / 2, 360);

  /* A daily card must not spoil the chain for anyone who has not played it. It shows
     the SHAPE of the run instead: one link per word, ringed where a lifeline was spent.
     A practice card can show the words, since nobody else is racing on it. */
  var y;
  if (r.mode === 'daily') {
    y = 520;
    var n = r.words.length, gap = 96, x0 = W / 2 - ((n - 1) * gap) / 2;
    for (var i = 0; i < n; i++) {
      var cx = x0 + i * gap, used = (r.perWord || [])[i];
      x.beginPath(); x.arc(cx, y, used ? 21 : 17, 0, Math.PI * 2);
      if (used) { x.strokeStyle = 'rgba(31,26,20,.55)'; x.lineWidth = 5; x.stroke(); }
      else { x.fillStyle = '#1F1A14'; x.fill(); }
    }
    x.fillStyle = '#1F1A14';
    x.font = '400 30px Fraunces, Georgia, serif';
    x.fillText('eight words linked', W / 2, y + 88);
    y += 150;
  } else {
    x.font = '600 46px Fraunces, Georgia, serif';
    y = 470;
    for (var j = 0; j < r.words.length; j += 2) {
      var pair = r.words[j] + (r.words[j + 1] ? '  \u00b7  ' + r.words[j + 1] : '');
      x.fillText(pair, W / 2, y); y += 74;
    }
  }

  y += 34;
  x.strokeStyle = 'rgba(31,26,20,.28)'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(W / 2 - 200, y); x.lineTo(W / 2 + 200, y); x.stroke();

  x.font = '900 126px Fraunces, Georgia, serif';
  x.fillText(fmt(r.total), W / 2, y + 136);

  x.font = '400 34px Fraunces, Georgia, serif';
  x.fillStyle = 'rgba(31,26,20,.74)';
  x.fillText(r.hints ? r.hints + ' lifeline' + (r.hints > 1 ? 's' : '') + ' used' : 'no lifelines',
    W / 2, y + 192);

  x.font = '400 28px Fraunces, Georgia, serif';
  x.fillStyle = 'rgba(31,26,20,.55)';
  if (SITE) x.fillText(SITE.replace(/^https?:\/\//, '').replace(/\/$/, ''), W / 2, H - 64);

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
    navigator.clipboard.writeText(txt).then(function () { toast('Copied'); }, function () { toast(txt); });
  } else toast(txt);
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
$('dailyBtn').addEventListener('click', function () {
  if (this.dataset.act === 'share') doShare(dailyDone());
  else startGame('daily');
});
$('practiceBtn').addEventListener('click', function () { startGame('practice'); });
$('aboutBtn').addEventListener('click', function () { openSheet('aboutSheet'); });
$('friendsBtn').addEventListener('click', function () { openSheet('friendsSheet'); });
$('settingsBtn').addEventListener('click', function () { paintSettings(); openSheet('settingsSheet'); });
$('profileBtn').addEventListener('click', function () { paintProfile(); openSheet('profileSheet'); });
$('scrim').addEventListener('click', closeSheets);
document.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeSheets(); });
$('themeSeg').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  SET.theme = b.dataset.theme; saveSet(); applyTheme(); paintSettings();
});
$('gentleTog').addEventListener('click', function () { SET.gentle = !SET.gentle; saveSet(); paintSettings(); });
$('motionTog').addEventListener('click', function () { SET.motion = !SET.motion; saveSet(); paintSettings(); });
$('againBtn').addEventListener('click', goHome);
$('shareBtn').addEventListener('click', function () { doShare(); });

/* a real keyboard, where there is one */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    if ($('confirm').hidden === false) { closeConfirm(); return; }
    if ($('pause').hidden === false) { resumePlay(); return; }
    closeSheets(); return;
  }
  var composing = (typeof C !== 'undefined') && C && !$('compose').hidden;
  if ($('pause').hidden === false || $('confirm').hidden === false) return;
  if (document.querySelector('.sheet.up')) return;
  if (!composing && (!S || S.done || S.locked)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); hit('ENTER'); press('ENTER'); return; }
  if (e.key === 'Backspace') { e.preventDefault(); hit('DEL'); press('DEL'); return; }
  if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); var k = e.key.toUpperCase(); hit(k); press(k); }
});

HELD.daily = loadHeld('daily');
HELD.practice = loadHeld('practice');
paintHome(); paintSettings(); paintProfile();
document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });
window.addEventListener('pagehide', save);

var awayAt = 0;
window.addEventListener('blur', function () { if (S && !S.done && !pauseAt && !awayAt) awayAt = Date.now(); });
window.addEventListener('focus', function () {
  if (S && !S.done && awayAt) { S.frozenMs += Date.now() - awayAt; awayAt = 0; paintClock(); }
});
