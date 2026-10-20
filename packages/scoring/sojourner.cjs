/* Sojourner's scoring engine -- the one copy of the rules.

   Option D (docs/notes/offline-and-score-integrity.md): the game records what
   the player DID (which region they chose for each place), and the server works
   out the score itself by running this same code over those moves. A number the
   browser claims is never trusted.

   So this file is two things at once:
     - inlined into games/sojourner/src/partD.js between marker comments, where
       the game uses it for its own picks and scores (packages/tokens/
       sync-inline.mjs keeps the copies identical); and
     - imported by the Worker (backend/src/lib/sojourner.js), which feeds it the
       same data the game loads: baked/assets/meta.json plus pool.json.

   ES5 only, no DOM, no clock, no network: it has to run inline in a browser
   page and in a Worker and give the same answer in both. Nothing in here may
   change a pick or a score without the game and the server changing together,
   which is the point of there being one file.

   Everything below is moved, not rewritten, from partD.js: the daily
   selection, the country rounds, the sprint bag and the scoring curve. */
var PSSojourner = (function () {
  "use strict";

  var D2R = Math.PI / 180, R_EARTH = 6371.0088;

  /* Phase 1 is worth 750: 100 + 125 + 150 + 175 + 200. Phase 2, the sprint, asks
     one place from home, two from round two and three from each of the rest. */
  var MULT = [1, 1.25, 1.5, 1.75, 2];
  var PHASE1_MAX = 750;
  var SPRINT_COUNT = [1, 2, 3, 3, 3];
  var SPRINT_PTS   = [15, 19, 24, 29, 36];
  var SPRINT_SWEEP = 25;                  // for finding every one of the twelve
  var SPRINT_SECONDS = 60;                // and the seconds left, for finishing
  var HOME_KM = 150, DECAY = 1600, HOME_DISCOUNT = 0.7;
  var DECK_GUARD = 5, HOME_WATER_KM = 900;

  var SPRINT_MAX = SPRINT_SWEEP + SPRINT_SECONDS;
  for (var si = 0; si < SPRINT_COUNT.length; si++) SPRINT_MAX += SPRINT_COUNT[si] * SPRINT_PTS[si];
  var MAX_TOTAL = PHASE1_MAX + SPRINT_MAX;

  /* The flags the sprint shows: the hundred a general audience recognises,
     dealt into rounds two to five as thirty, thirty, twenty, twenty. */
  var FLAG_TIERS = [
    ['United States of America','United Kingdom','Canada','France','Germany','Italy','Spain','Japan',
     'China','India','Brazil','Mexico','Australia','Russia','South Korea','Netherlands','Switzerland',
     'Sweden','Norway','Denmark','Ireland','Greece','Portugal','Turkey','South Africa','Argentina',
     'Israel','Egypt','Jamaica','New Zealand'],
    ['Poland','Belgium','Austria','Finland','Iceland','Czech Republic','Hungary','Ukraine','Romania',
     'Croatia','Republic of Serbia','Vietnam','Thailand','Indonesia','Philippines','Malaysia',
     'Singapore','Pakistan','Bangladesh','Saudi Arabia','United Arab Emirates','Iran','Iraq','Nigeria',
     'Kenya','Ethiopia','Ghana','Morocco','Chile','Colombia'],
    ['Peru','Venezuela','Cuba','Costa Rica','Panama','Dominican Republic','Bolivia','Ecuador','Uruguay',
     'Paraguay','Guatemala','Nepal','Sri Lanka','Myanmar','Cambodia','North Korea','Taiwan','Kazakhstan',
     'Afghanistan','Syria'],
    ['Lebanon','Jordan','Kuwait','Qatar','Oman','Yemen','Libya','Algeria','Tunisia','Sudan',
     'United Republic of Tanzania','Uganda','Zimbabwe','Zambia','Senegal','Ivory Coast','Cameroon',
     'Angola','Mozambique','Madagascar']
  ];

  /* ---------------------------------------------------------- the maths */
  function gcKm(lon1, lat1, lon2, lat2) {
    var p1 = lat1 * D2R, p2 = lat2 * D2R, dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Distance alone decides the score, except that a guess inside the right
  // country gets its distance discounted.
  function rawScore(km) {
    if (km <= HOME_KM) return 100;
    return Math.max(0, Math.round(100 * Math.exp(-(km - HOME_KM) / DECAY)));
  }
  function scoreFor(km, exact, sameCountry) {
    if (exact) return 100;
    var d = sameCountry && km > HOME_KM ? HOME_KM + (km - HOME_KM) * HOME_DISCOUNT : km;
    return rawScore(d);
  }

  function fnv(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffled(list, seedStr) {
    var a = list.slice(), rng = mulberry32(fnv(seedStr));
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Each round deals from a shuffled deck of its whole pool and reshuffles only
  // when the deck runs out. At a deck boundary the first few cards are swapped
  // clear of the previous deck's last few.
  function deckFor(list, r, cycle) {
    var d = shuffled(list, 'sojourner|r' + r + '|deck' + cycle), n = d.length;
    if (cycle <= 0 || n <= 2 * DECK_GUARD) return d;
    var tail = shuffled(list, 'sojourner|r' + r + '|deck' + (cycle - 1)).slice(n - DECK_GUARD);
    var j = DECK_GUARD;
    for (var i = 0; i < DECK_GUARD; i++) {
      if (tail.indexOf(d[i]) < 0) continue;
      while (j < n && tail.indexOf(d[j]) >= 0) j++;
      if (j >= n) break;
      var t = d[i]; d[i] = d[j]; d[j] = t; j++;
    }
    return d;
  }

  /* ---------------------------------------------- the engine, for one map
     GD is what the game loads: meta.json (admins, flagA, gL, gA, gX, gY) with
     pool.json as GD.pool. opts.tidy turns a country's name into the one the
     game shows; scoring never reads a name, so the server passes nothing. */
  function make(GD, opts) {
    var tidy = (opts && opts.tidy) || function (a) { return a; };
    var POOL = GD.pool;
    var byAdmin = {}, byRound = [[], [], [], [], []], countryEntry = {};
    var i;

    for (i = 1; i < GD.gA.length; i++) {
      var a0 = GD.gA[i];
      (byAdmin[a0] || (byAdmin[a0] = [])).push(i);
    }
    for (i = 0; i < POOL.length; i++) {
      var p = POOL[i];
      byRound[p.r - 1].push(i);
      if (!p.w && p.n === p.c) countryEntry[p.a] = p;
    }

    function asEntry(v) { return typeof v === 'number' ? POOL[v] : v; }

    function synthCountry(a, r, cc) {
      var ids = byAdmin[a] || [], sx = 0, sy = 0, k;
      for (k = 0; k < ids.length; k++) { sx += GD.gX[ids[k]]; sy += GD.gY[ids[k]]; }
      var nm = tidy(GD.admins[a] || '');
      return { r: r, n: nm, c: nm, a: a, t: ids, fl: cc,
               x: Math.round(sx / Math.max(1, ids.length)), y: Math.round(sy / Math.max(1, ids.length)),
               f: '', s: '', u: '' };
    }

    // The focus country is asked region by region, everywhere else as a whole
    // country. Built once per focus country and cached.
    var roundsCache = {};
    function countryRounds(focus) {
      if (roundsCache[focus]) return roundsCache[focus];
      var rounds = [[], [], [], [], []], tier = {}, seen = {}, home = [];
      POOL.forEach(function (p) {
        if (!p.w && GD.admins[p.a] === focus) home.push([p.x / 100, p.y / 100]);
      });
      // Round one is home ground, so a sea only belongs there if it is on the
      // focus country's doorstep.
      function nearHome(p) {
        for (var k = 0; k < home.length; k++)
          if (gcKm(p.x / 100, p.y / 100, home[k][0], home[k][1]) <= HOME_WATER_KM) return true;
        return false;
      }
      POOL.forEach(function (p, i) {
        if (p.w) { rounds[(p.r === 1 && !nearHome(p)) ? 1 : p.r - 1].push(i); return; }
        var adm = GD.admins[p.a];
        // every region of the focus country, whatever tier it sits in elsewhere
        if (adm === focus) { rounds[0].push(i); return; }
        if (tier[p.a] === undefined || p.r < tier[p.a]) tier[p.a] = p.r;
      });
      POOL.forEach(function (p) {
        if (p.w) return;
        var adm = GD.admins[p.a];
        if (adm === focus || adm === 'Water' || seen[p.a]) return;
        seen[p.a] = 1;
        var e = countryEntry[p.a] || synthCountry(p.a, tier[p.a] || 5, GD.flagA[p.a] || '');
        rounds[(tier[p.a] || 5) - 1].push(e);
      });
      roundsCache[focus] = rounds;
      return rounds;
    }

    var flagDeckCache = null;
    function flagDeck() {
      if (flagDeckCache) return flagDeckCache;
      var deck = [[], [], [], [], []];                    // round 1 never asks a flag
      FLAG_TIERS.forEach(function (names, t) {
        names.forEach(function (nm) {
          var a = GD.admins.indexOf(nm);
          if (a < 0) return;
          var cc = GD.flagA[a];
          if (!cc) return;
          var e = countryEntry[a] || synthCountry(a, t + 2, cc);
          if (!e.t || !e.t.length) return;
          deck[t + 1].push(e);
        });
      });
      flagDeckCache = deck;
      return deck;
    }

    function dayIndexOf(dayKey) {
      var p = dayKey.split('-');
      return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
    }
    function dailyPicks(dayKey, focus) {
      var dayIndex = dayIndexOf(dayKey), picks = [];
      for (var r = 0; r < 5; r++) {
        var list = countryRounds(focus)[r], n = list.length;
        if (!n) { picks.push(byRound[r][0]); continue; }
        var cycle = Math.floor(dayIndex / n), pos = ((dayIndex % n) + n) % n;
        picks.push(deckFor(list, r, cycle)[pos]);
      }
      return picks;
    }
    function practicePicks(focus, seed) {
      var picks = [];
      for (var r = 0; r < 5; r++) {
        var list = countryRounds(focus)[r];
        if (!list.length) list = byRound[r];
        picks.push(shuffled(list, seed + '|' + r)[0]);
      }
      return picks;
    }

    // Three places a round (one in round one), from that round's pool and, from
    // round two on, its flags as well. Which of the two you get is the draw.
    function sprintBag(seed, focus) {
      var rounds = countryRounds(focus), flags = flagDeck(), bag = [];
      for (var r = 0; r < 5; r++) {
        var cand = (rounds[r] || []).map(function (v) { return { e: asEntry(v), r: r, flag: false }; });
        (flags[r] || []).forEach(function (e) { cand.push({ e: e, r: r, flag: true }); });
        bag = bag.concat(shuffled(cand, seed + '|' + r).slice(0, SPRINT_COUNT[r]));
      }
      return bag;
    }

    // One Phase 1 guess: `pickId` is the region the player chose.
    function scoreGuess(entry, round, pickId) {
      var e = asEntry(entry);
      var exact = e.t.indexOf(pickId) >= 0;
      var same = !e.w && GD.gA[pickId] === e.a;           // 'same country' is meaningless at sea
      var gx = GD.gX[pickId] / 100, gy = GD.gY[pickId] / 100;
      var km = exact ? 0 : gcKm(gx, gy, e.x / 100, e.y / 100);
      var base = scoreFor(km, exact, same);
      var plain = scoreFor(km, exact, false);
      return { exact: exact, same: same, km: km, base: base, bonus: base - plain,
               pts: Math.round(base * MULT[round]), gx: gx, gy: gy };
    }

    function validRegion(id) {
      return typeof id === 'number' && id === Math.floor(id) && id >= 1 && id < GD.gA.length;
    }

    /* A daily game's moves, replayed.

         moves = { v:1, focus:'United States of America',
                   rounds:[regionId x 5],
                   sprint:{ answers:[regionId ...], secs:<whole seconds left> } }

       Returns { ok:true, total, max, rounds, sprint } or { ok:false, error }.
       The one number it cannot check is `secs`: it is clamped to the minute and
       counted only when every place was answered, and that is the whole of what
       a dishonest clock can add. */
    function verify(moves, dayKey) {
      function fail(code) { return { ok: false, error: code }; }
      if (!moves || typeof moves !== 'object' || moves.v !== 1) return fail('bad_moves');
      var focus = moves.focus;
      if (typeof focus !== 'string' || GD.admins.indexOf(focus) < 0) return fail('bad_focus');
      var rounds = moves.rounds, k;
      if (!Array.isArray(rounds) || rounds.length !== 5) return fail('bad_moves');
      for (k = 0; k < 5; k++) if (!validRegion(rounds[k])) return fail('bad_moves');

      var picks = dailyPicks(dayKey, focus), p1 = 0, out = [];
      for (k = 0; k < 5; k++) {
        var g = scoreGuess(picks[k], k, rounds[k]);
        p1 += g.pts;
        out.push({ pick: rounds[k], pts: g.pts, base: g.base, km: Math.round(g.km), exact: g.exact });
      }

      var sp = moves.sprint;
      if (!sp || typeof sp !== 'object' || !Array.isArray(sp.answers)) return fail('bad_moves');
      var bag = sprintBag('sprint|' + dayKey, focus);
      if (sp.answers.length > bag.length) return fail('bad_moves');
      var right = 0, score = 0;
      for (k = 0; k < sp.answers.length; k++) {
        if (!validRegion(sp.answers[k])) return fail('bad_moves');
        if (bag[k].e.t.indexOf(sp.answers[k]) >= 0) { right++; score += SPRINT_PTS[bag[k].r]; }
      }
      var completed = sp.answers.length === bag.length;
      var secs = Math.floor(Number(sp.secs));
      var bonus = completed && isFinite(secs) ? Math.max(0, Math.min(SPRINT_SECONDS, secs)) : 0;
      var sweep = right === bag.length ? SPRINT_SWEEP : 0;
      var sprintScore = score + bonus + sweep;
      return {
        ok: true,
        total: p1 + sprintScore,
        max: MAX_TOTAL,
        rounds: out,
        sprint: { score: sprintScore, right: right, of: bag.length, bonus: bonus, sweep: sweep }
      };
    }

    /* A short fingerprint of the map this engine was built from. The game sends
       its own with each result; if the server's differs, the two were built from
       different maps and a replay would be meaningless -- so the server asks the
       game to try again later instead of judging it.
       It reads ONLY what scoring reads: where each place is, what it is made of
       and which country it belongs to. The game hangs other things on its pool
       entries as it runs (the reveal stories, for one), and those must never
       change the answer. */
    var keyCache = null;
    function keyHash() {
      if (keyCache) return keyCache;
      var parts = [], n = POOL.length;
      for (var k = 0; k < n; k++) {
        var p = POOL[k];
        parts.push(p.r + ',' + p.a + ',' + (p.w ? 1 : 0) + ',' + p.n + ',' + p.c + ',' + p.x + ',' + p.y + ',' + p.t.join('.'));
      }
      keyCache = fnv(parts.join('|') + '#' + GD.admins.join(',') + '#' + GD.gA.join(',') + '#' +
                     GD.gX.join(',') + '#' + GD.gY.join(',')).toString(36);
      return keyCache;
    }

    return {
      asEntry: asEntry, countryRounds: countryRounds, flagDeck: flagDeck,
      dailyPicks: dailyPicks, practicePicks: practicePicks, sprintBag: sprintBag,
      scoreGuess: scoreGuess, verify: verify, keyHash: keyHash,
      byRound: byRound, byAdmin: byAdmin, countryEntry: countryEntry, synthCountry: synthCountry
    };
  }

  return {
    make: make, gcKm: gcKm, rawScore: rawScore, scoreFor: scoreFor,
    fnv: fnv, mulberry32: mulberry32, shuffled: shuffled,
    MULT: MULT, PHASE1_MAX: PHASE1_MAX, MAX_TOTAL: MAX_TOTAL,
    SPRINT_COUNT: SPRINT_COUNT, SPRINT_PTS: SPRINT_PTS, SPRINT_SWEEP: SPRINT_SWEEP,
    SPRINT_SECONDS: SPRINT_SECONDS
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PSSojourner;
