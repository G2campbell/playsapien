(function(){
"use strict";
var M = window.__M__, GD = null, POOL = null;
var $ = function(id){ return document.getElementById(id); };
/* Where this copy of the game lives. build.py injects window.SOJOURNER_SITE;
   the literal below is the artifact fallback and is rewritten in place by the
   same build. Audit S4: the domain painted on the share card used to be a
   SECOND literal, so fixing the build config alone left the old domain on every
   card. Deriving the label from GAME_URL -- which is what Word Chain does at
   part-c-app.js:14,651 -- means the two can never disagree again. */
var GAME_URL = (typeof window !== "undefined" && window.SOJOURNER_SITE) ||
               "https://claude.ai/code/artifact/PLACEHOLDER";
var SITE_LABEL = GAME_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
/* Phase 1 is worth 750: 100 + 125 + 150 + 175 + 200. Phase 2 pays a tenth of
   each round's value, rounded up -- 10, 13, 15, 18, 20 -- three places a round,
   so a clean sprint is 228 before the clock bonus. */
var MULT = [1, 1.25, 1.5, 1.75, 2];
var PHASE1_MAX = 750;
/* The sprint asks one place from home, two from round two and three from each of
   the rest -- twelve in a minute, which is about as many as anyone gets through.
   The ladder steepens towards the end so that ten right lands just under 250. */
var SPRINT_COUNT = [1, 2, 3, 3, 3];
var SPRINT_PTS   = [15, 19, 24, 29, 36];
var SPRINT_SWEEP = 25;                 // for finding every one of the twelve
function sprintPts(r){ return SPRINT_PTS[r]; }
var HOLD_BASE = 620, MOVE_TOL = 11, PREVIEW_MS = 130, ARC_LEN = 364.42;

/* ---------------- round shapes ---------------- */
var SHAPE = [
  '<circle cx="9" cy="9" r="7.2"/>',
  '<rect x="2.4" y="2.4" width="13.2" height="13.2" rx="2.2"/>',
  '<path d="M9 1.1 L16.9 9 L9 16.9 L1.1 9 Z"/>',
  '<path d="M9 1 L15.93 5 L15.93 13 L9 17 L2.07 13 L2.07 5 Z"/>',
  '<path d="M9 0.4 L11.12 6.09 L17.18 6.34 L12.42 10.11 L14.05 15.96 L9 12.6 '+
    'L3.95 15.96 L5.58 10.11 L0.82 6.34 L6.88 6.09 Z"/>',
  // the sprint: an old alarm clock. The dial is knocked out of the body with
  // evenodd, which is what makes it read as a clock rather than a blob.
  '<path d="M8.1 0.5 h1.8 v2.1 h-1.8 Z '+
    'M2.1 4.0 a2.3 2.3 0 1 0 4.6 0 a2.3 2.3 0 1 0 -4.6 0 Z '+
    'M11.3 4.0 a2.3 2.3 0 1 0 4.6 0 a2.3 2.3 0 1 0 -4.6 0 Z '+
    'M4.3 15.4 L3.0 17.7 L5.5 17.7 L6.3 16.2 Z '+
    'M13.7 15.4 L15.0 17.7 L12.5 17.7 L11.7 16.2 Z '+
    'M3.0 10.2 a6.0 6.0 0 1 0 12.0 0 a6.0 6.0 0 1 0 -12.0 0 Z '+
    'M5.6 10.2 a3.4 3.4 0 1 0 6.8 0 a3.4 3.4 0 1 0 -6.8 0 Z"/>'
];
var SHAPE_NAME = ['circle','square','diamond','hexagon','star','clock'];
var SHAPE_CHAR = ['\u25CF','\u25A0','\u25C6','\u2B22','\u2605','\u23F0'];
var SPRINT_SHAPE = 5;
// the sprint's colour comes from how much of it was found
function sprintBase(q){ return (q && q.bag.length) ? Math.round(q.right / q.bag.length * 100) : 0; }
// found them all and the clock is the story; short of that, the count is
function sprintNote(q){
  if(!q) return '';
  var missed = Math.max(0, q.done - q.right);
  return '+' + q.right + '  \u00b7  ' + missed + '-';
}
var TIER = [
  {min:90, col:'#4FB07A'}, {min:70, col:'#D8B33F'},
  {min:40, col:'#DE8A45'}, {min:1,  col:'#C75B4E'}
];
function tierColor(base){
  for(var i=0;i<TIER.length;i++) if(base >= TIER[i].min) return TIER[i].col;
  return '#33434C';
}
function shapeSvg(i, mode, base){
  // mode: 'done' | 'now' | 'todo'
  var fill = mode === 'done' ? tierColor(base) : 'none';
  var stroke = mode === 'done' ? 'none' : (mode === 'now' ? 'var(--amber)' : 'var(--line2)');
  return '<svg class="rs rs-'+mode+'" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">' +
         '<g fill="'+fill+'" fill-rule="evenodd" stroke="'+stroke+'" stroke-width="1.6" stroke-linejoin="round">' +
         SHAPE[i] + '</g></svg>';
}
function shapeRow(results, currentRound, sprint){
  var out = '';
  for(var i=0;i<5;i++){
    var mode = results[i] ? 'done' : (i === currentRound ? 'now' : 'todo');
    out += shapeSvg(i, mode, results[i] ? results[i].base : 0);
  }
  if(sprint !== undefined)
    out += shapeSvg(SPRINT_SHAPE, sprint ? 'done' : (currentRound === SPRINT_SHAPE ? 'now' : 'todo'),
                    sprintBase(sprint));
  return out;
}

/* ---------------- daily selection ---------------- */
function fnv(s){ var h=2166136261>>>0; for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0;
  var t=Math.imul(a^a>>>15, 1|a); t=t+Math.imul(t^t>>>7, 61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296; }; }
var byAdmin = {}, byPlace = {};
/* The wrong guess is shown in the same orange whether it is one region or a whole
   country. A country needs the mask rather than uSel (which holds a single id), and
   the mask is also where a quiz keeps its earned colours -- so remember what was
   under the wash and put it back. */
var CHOOSE_SLOT = 5;
var wrongPaint = null, choosePaint = null;
/* While the ring fills, the place under your thumb is simply darkened. It used to
   glow the same orange as a wrong answer, which made choosing and being wrong
   look identical -- and in the Countries game it lit one region of a country
   whose borders are dissolved, which is not a thing you are allowed to pick. */
function paintChoosing(ids){
  clearChoosing();
  var prev = new Array(ids.length), i;
  for(i=0;i<ids.length;i++) prev[i] = M.maskData[ids[i]*4 + 3];
  choosePaint = { ids:ids, prev:prev };
  M.paintQuiz(ids, CHOOSE_SLOT);
  M.uniforms.uShowMask.value = 1;
}
function clearChoosing(){
  if(!choosePaint) return;
  for(var i=0;i<choosePaint.ids.length;i++)
    M.maskData[choosePaint.ids[i]*4 + 3] = choosePaint.prev[i];
  M.maskTex.needsUpdate = true;
  choosePaint = null;
}
function paintWrong(ids){
  clearWrong();
  var prev = new Array(ids.length), i;
  for(i=0;i<ids.length;i++) prev[i] = M.maskData[ids[i]*4 + 3];
  wrongPaint = { ids:ids, prev:prev };
  M.paintQuiz(ids, 4);
}
function clearWrong(){
  if(!wrongPaint) return;
  for(var i=0;i<wrongPaint.ids.length;i++)
    M.maskData[wrongPaint.ids[i]*4 + 3] = wrongPaint.prev[i];
  M.maskTex.needsUpdate = true;
  wrongPaint = null;
}
function setMasks(e){
  wrongPaint = null; choosePaint = null;   // fill(0) takes the washes with it
  M.maskData.fill(0);
  var isRegion = !e.w && e.n !== e.c;
  var home = isRegion ? (byAdmin[e.a] || []) : [], i;
  for(i=0;i<home.length;i++) M.maskData[home[i]*4 + 1] = 255;   // whole country, faint
  for(i=0;i<e.t.length;i++)  M.maskData[e.t[i]*4]     = 255;    // the answer itself
  M.maskTex.needsUpdate = true;
  M.uniforms.uShowMask.value = 1;
}
var byRound = [[],[],[],[],[]];
var learnIndex = {}, countryEntry = {};
function buildExtras(){
  var i, p;
  for(i=0;i<POOL.length;i++){
    p = POOL[i];
    if(!p.w && p.n === p.c) countryEntry[p.a] = p;
  }
  // learn mode: every selectable region points at the best entry that describes it
  for(i=0;i<POOL.length;i++){
    p = POOL[i];
    if(p.t.length === 1) learnIndex[p.t[0]] = i;
  }
  for(i=0;i<POOL.length;i++){
    p = POOL[i];
    if(p.t.length > 1) for(var k=0;k<p.t.length;k++)
      if(learnIndex[p.t[k]] === undefined) learnIndex[p.t[k]] = i;
  }
}
function synthCountry(a, r, cc){
  var ids = byAdmin[a] || [], sx = 0, sy = 0, k;
  for(k=0;k<ids.length;k++){ sx += GD.gX[ids[k]]; sy += GD.gY[ids[k]]; }
  var nm = tidy(GD.admins[a] || '');
  return { r:r, n:nm, c:nm, a:a, t:ids, fl:cc,
           x: Math.round(sx/Math.max(1,ids.length)), y: Math.round(sy/Math.max(1,ids.length)),
           f:'', s:'', u:'' };
}
function indexData(){
  GD = M.GD; POOL = GD.pool;
  for(var i=1;i<GD.gA.length;i++){
    var a = GD.gA[i];
    (byAdmin[a] || (byAdmin[a] = [])).push(i);
  }
  POOL.forEach(function(p,i){ byRound[p.r-1].push(i); byPlace[p.n + '|' + p.c] = p; });
  buildExtras();
}
// Countries+focus: the focus country is asked region by region, everywhere else
// as a whole country. Built once per focus country and cached.
var countryRounds = null, countryRoundsFor = null;
var HOME_WATER_KM = 900;
function buildCountryRounds(){
  if(countryRoundsFor === SET.focus && countryRounds) return countryRounds;
  var rounds = [[],[],[],[],[]], tier = {}, seen = {}, home = [];
  POOL.forEach(function(p){
    if(!p.w && GD.admins[p.a] === SET.focus) home.push([p.x/100, p.y/100]);
  });
  // Round one is home ground, so a sea only belongs there if it is on the focus
  // country's doorstep -- the Great Lakes and the Gulf of Mexico for the US, not
  // the Atlantic.
  function nearHome(p){
    for(var k=0;k<home.length;k++)
      if(M.gcKm(p.x/100, p.y/100, home[k][0], home[k][1]) <= HOME_WATER_KM) return true;
    return false;
  }
  POOL.forEach(function(p, i){
    if(p.w){ rounds[(p.r === 1 && !nearHome(p)) ? 1 : p.r-1].push(i); return; }
    var adm = GD.admins[p.a];
    // every region of the focus country, whatever tier it sits in elsewhere
    if(adm === SET.focus){ rounds[0].push(i); return; }
    if(tier[p.a] === undefined || p.r < tier[p.a]) tier[p.a] = p.r;
  });
  POOL.forEach(function(p){
    if(p.w) return;
    var adm = GD.admins[p.a];
    if(adm === SET.focus || adm === 'Water' || seen[p.a]) return;
    seen[p.a] = 1;
    var e = countryEntry[p.a] || synthCountry(p.a, tier[p.a] || 5, GD.flagA[p.a] || '');
    rounds[(tier[p.a] || 5) - 1].push(e);
  });
  countryRounds = rounds; countryRoundsFor = SET.focus;
  return rounds;
}
function deckFor2(r){ return buildCountryRounds()[r]; }

/* ---------------- flags, for the sprint ----------------
   The old Flags mode asked for any country in the game, which turned out to be a
   memory test rather than a geography one. These hundred are the ones a general
   audience actually recognises, ranked roughly by how often they are seen --
   economies, sporting nations, holiday destinations, distinctive designs -- and
   dealt into rounds two through five as thirty, thirty, twenty, twenty. */
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
var flagDeck = null;
function buildFlagDeck(){
  if(flagDeck) return flagDeck;
  flagDeck = [[],[],[],[],[]];                       // round 1 never asks a flag
  FLAG_TIERS.forEach(function(names, t){
    names.forEach(function(nm){
      var a = GD.admins.indexOf(nm);
      if(a < 0) return;
      var cc = GD.flagA[a];
      if(!cc) return;
      var e = countryEntry[a] || synthCountry(a, t+2, cc);
      if(!e.t || !e.t.length) return;
      flagDeck[t+1].push(e);
    });
  });
  return flagDeck;
}
function asEntry(v){ return typeof v === 'number' ? POOL[v] : v; }

/* ---------------- choosing which story to tell ----------------
   A place can hold several stories. The daily round picks one from the date, so
   everyone playing today reads the same thing. Practice and Learn pick one you
   have not seen yet, so a run of practice rounds does not spend the story you
   would have got in the daily. */
var SEEN_KEY = 'sojourner:seen';
function seenMap(){
  try{ return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); }catch(e){ return {}; }
}
function markSeen(place, i){
  try{
    var m = seenMap(), a = m[place] || [];
    if(a.indexOf(i) < 0) a.push(i);
    m[place] = a; localStorage.setItem(SEEN_KEY, JSON.stringify(m));
  }catch(e){}
}
var storyPick = {};          // one choice per place per run, so the reveal and the
function resetStoryPicks(){ storyPick = {}; }   // walkthrough always agree
function regionStories(e){
  // a whole-country question has no story of its own, so it borrows one from a region
  var out = [];
  POOL.forEach(function(p){
    if(p.w || p.a !== e.a) return;
    (p.fs || []).forEach(function(t){ if(t && t[0]) out.push(t); });
  });
  return out;
}
function storyFor(e, deterministic){
  var fs = e.fs || [];
  if(!fs.length && e.n === e.c && e.a !== undefined) fs = regionStories(e);
  if(!fs.length) return null;
  var key = (e.n || '') + '|' + (e.c || ''), i;
  if(storyPick[key] !== undefined){
    var c = fs[storyPick[key]] || [];
    return { f:c[0]||'', s:c[1]||'', u:c[2]||'', j:c[3]||null, i:storyPick[key], n:fs.length };
  }
  if(fs.length === 1){ i = 0; }
  else if(deterministic){
    i = fnv(S.dayKey + '|' + key) % fs.length;      // same story for everyone today
  }else{
    var seen = seenMap()[key] || [];
    var fresh = [];
    for(var k=0;k<fs.length;k++) if(seen.indexOf(k) < 0) fresh.push(k);
    var from = fresh.length ? fresh : fs.map(function(_,k){ return k; });
    i = from[Math.floor(Math.random()*from.length)];
  }
  storyPick[key] = i;
  markSeen(key, i);   // a story read in the daily is one practice will avoid
  var t = fs[i] || [];
  return { f: t[0] || '', s: t[1] || '', u: t[2] || '', j: t[3] || null, i: i, n: fs.length };
}

/* the stories are a separate download; they are only needed after the fifth round.
   This never rejects: callers read factsLoaded / factsFailed instead. A failed
   attempt drops its promise, so the next call tries the network again rather than
   handing back the same failure for the rest of the session. */
var factsLoaded = false, factsPromise = null, factsFailed = false;
function ensureFacts(){
  if(factsLoaded) return Promise.resolve();
  if(factsPromise) return factsPromise;
  if(M.INLINE){ factsLoaded = true; return Promise.resolve(); }
  // assetUrl, not a bare path: /assets/* is cached for a week, and an older
  // facts.json is keyed to an older pool, so it would hang the wrong stories on
  // the wrong places -- or, being shorter, on none at all
  factsPromise = fetch(M.assetUrl('facts.json'))
    .then(function(r){
      if(!r.ok) throw new Error('facts.json ' + r.status);
      return r.json();
    })
    .then(function(list){
      if(!list || !list.length) throw new Error('facts.json empty');
      if(list.length !== POOL.length) throw new Error(
        'facts.json is for a different map (' + list.length + ' vs ' + POOL.length + ')');
      list.forEach(function(fs,i){ POOL[i].fs = fs || []; });
      factsLoaded = true; factsFailed = false; factsPromise = null;
    }, function(err){
      factsPromise = null; factsFailed = true;
      if(window.console && console.warn) console.warn('Sojourner: stories did not load', err);
    });
  return factsPromise;
}
// Silence about a missing story should mean 'not written yet', never 'the download broke'.
function noStoryText(){
  return factsFailed
    ? 'The stories could not be loaded just now \u2014 check your connection, then try again.'
    : 'A story for this place is still being researched.';
}

/* leaderboards later: set window.SOJOURNER_API to a URL and finished games post to it.
   Nothing is sent while it is unset. */
function submitScore(){
  var api = window.SOJOURNER_API;
  if(!api || S.practice) return;
  try{
    fetch(api.replace(/\/$/,'') + '/score', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        day: S.dayKey, total: S.total,
        rounds: S.results.map(function(r){ return {place:r.e.n, country:r.e.c, base:r.base, pts:r.pts, km:Math.round(r.km)}; })
      })
    })['catch'](function(){});
  }catch(e){}
}
function shuffled(list, seedStr){
  var a = list.slice(), rng = mulberry32(fnv(seedStr));
  for(var i=a.length-1;i>0;i--){
    var j = Math.floor(rng()*(i+1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
// Each round deals from a shuffled deck of its whole pool and reshuffles only when the
// deck runs out, so nothing can come round again until everything else has been used.
// At a deck boundary the first few cards are swapped clear of the previous deck's last
// few, which keeps the closest possible repeat about a week apart.
var DECK_GUARD = 5;
function deckFor(list, r, cycle){
  var d = shuffled(list, 'sojourner|r' + r + '|deck' + cycle), n = d.length;
  if(cycle <= 0 || n <= 2*DECK_GUARD) return d;
  var tail = shuffled(list, 'sojourner|r' + r + '|deck' + (cycle-1)).slice(n - DECK_GUARD);
  var j = DECK_GUARD;
  for(var i=0;i<DECK_GUARD;i++){
    if(tail.indexOf(d[i]) < 0) continue;
    while(j < n && tail.indexOf(d[j]) >= 0) j++;
    if(j >= n) break;
    var t = d[i]; d[i] = d[j]; d[j] = t; j++;
  }
  return d;
}
function dailyPicks(dayKey){
  var p = dayKey.split('-');
  var dayIndex = Math.floor(Date.UTC(+p[0], +p[1]-1, +p[2]) / 86400000);
  var picks = [];
  for(var r=0;r<5;r++){
    var list = deckFor2(r), n = list.length;
    if(!n){ picks.push(byRound[r][0]); continue; }
    var cycle = Math.floor(dayIndex / n), pos = ((dayIndex % n) + n) % n;
    picks.push(deckFor(list, r, cycle)[pos]);
  }
  return picks;
}
function practicePicks(){
  var picks = [], seed = 'practice|' + Math.random() + '|' + Date.now();
  for(var r=0;r<5;r++){
    var list = deckFor2(r);
    if(!list.length) list = byRound[r];
    picks.push(shuffled(list, seed + '|' + r)[0]);
  }
  return picks;
}
function utcDayKey(){
  var d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}
function prettyDate(key){
  var p = key.split('-'), mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return parseInt(p[2],10) + ' ' + mo[parseInt(p[1],10)-1] + ' ' + p[0];
}

/* ---------------- scoring ---------------- */
// Distance alone decides the score, except that a guess inside the right country
// gets its distance discounted — worth roughly a tenth of the round, and always
// beatable by a guess that is meaningfully closer.
var HOME_KM = 150, DECAY = 1600, HOME_DISCOUNT = 0.7;
function rawScore(km){
  if(km <= HOME_KM) return 100;
  return Math.max(0, Math.round(100 * Math.exp(-(km-HOME_KM)/DECAY)));
}
function scoreFor(km, exact, sameCountry){
  if(exact) return 100;
  var d = sameCountry && km > HOME_KM ? HOME_KM + (km-HOME_KM)*HOME_DISCOUNT : km;
  return rawScore(d);
}
function fmtKm(km){
  var v = SET.units === 'mi' ? km*0.621371 : km;
  var u = SET.units === 'mi' ? ' mi' : ' km';
  if(v < 10) return v.toFixed(1) + u;
  return Math.round(v).toLocaleString('en-US') + u;
}

/* ---------------- settings ---------------- */
/* Two levels, chosen on the landing page rather than buried in settings.
   The stored values stay 'beginner' and 'expert' so an old save still reads. */
var SET = { mode:'beginner', units:'mi', timing:1.0, sound:true, style:'default',
            focus:'United States of America' };
var LEVELS = [['beginner','Wanderer'], ['expert','Globetrotter']];
function levelLabel(){ return SET.mode === 'expert' ? 'Globetrotter' : 'Wanderer'; }
function loadSettings(){
  try{
    var s = JSON.parse(localStorage.getItem('sojourner:settings') || '{}');
    // the middle level is gone; anyone sitting on it lands on Wanderer
    if(s.mode) SET.mode = (s.mode === 'expert') ? 'expert' : 'beginner';
    if(s.style) SET.style = s.style;
    if(s.focus) SET.focus = s.focus;
    if(s.units) SET.units = s.units;
    if(s.timing) SET.timing = Math.max(0.8, Math.min(1.3, s.timing));
    if(s.sound !== undefined) SET.sound = !!s.sound;
  }catch(e){}
}
function saveSettings(){
  try{ localStorage.setItem('sojourner:settings', JSON.stringify(SET)); }catch(e){}
}

function focusLabel(){ return tidy(SET.focus); }
function focusShort(){
  var t = tidy(SET.focus);
  return { 'United States':'US', 'Central African Republic':'CAR',
           'DR Congo':'DR Congo', 'South Sudan':'S. Sudan' }[t] || t;
}
var STYLES = [['default','Default'],['nasa1','NASA 1'],['nasa2','NASA 2'],
              ['mgreen','Muted green'],['mblue','Muted blue'],['natural','Natural Earth']];
var STYLE_NOTE = {
  'default':'Shaded relief in an atlas palette — elevation read as colour.',
  'nasa1':'NASA Blue Marble, May. True-colour satellite imagery with topography and sea floor.',
  'nasa2':'NASA Blue Marble, August. Less snow in the north, a greener Sahel.',
  'mgreen':'A quiet cartographic fill: sage water, pale land, relief kept faint.',
  'mblue':'Near-white land on soft blue water. The calmest of the six.',
  'natural':'Natural Earth II — hand-tuned land cover with shaded relief.'
};
function focusIndex(){
  if(!GD) return null;
  var i = GD.admins.indexOf(SET.focus);
  return i < 0 ? null : i;
}
function applySettings(){
  M.setFocusAdmin(focusIndex());          // the focus country always keeps its regions
  M.setBorderMode(SET.mode);
  M.setStyle(SET.style);
  syncSettingsUI();
}
function syncSettingsUI(){
  var KEYOF = {segUnits:'units', segStyle:'style'};
  ['segUnits','segStyle'].forEach(function(id){
    var key = KEYOF[id];
    Array.prototype.forEach.call($(id).querySelectorAll('button'), function(b){
      b.setAttribute('aria-pressed', b.getAttribute('data-v') === SET[key] ? 'true' : 'false');
    });
  });
  $('styleHint').textContent = STYLE_NOTE[SET.style] || '';
  $('rngTiming').value = Math.round(SET.timing*100);
  $('tglSound').setAttribute('aria-checked', SET.sound ? 'true' : 'false');
}
function holdMs(){ return Math.round(HOLD_BASE / SET.timing); }

/* ---------------- sound ----------------
   One clip: a rising tone that settles, then a chime 1.6 seconds in. The ring
   fills in a fraction of that, so the clip is played fast enough that the chime
   lands exactly as the ring closes. Pitch rides along with the speed, which is
   what makes it read as winding up rather than as a sample played oddly. */
var PING_AT = 1.6;
var sfx = null, sfxReady = false;
function initSound(){
  var src = M.INLINE ? window.__SELECT_SND__ : M.assetUrl('select.mp3');
  if(!src) return;
  try{
    sfx = new Audio(src);
    sfx.preload = 'auto';
    sfx.addEventListener('canplaythrough', function(){ sfxReady = true; }, {once:true});
    sfx.load();
  }catch(e){ sfx = null; }
}
function soundStart(){
  if(!SET.sound || !sfx) return;
  try{
    var rate = (PING_AT * 1000) / holdMs();
    sfx.playbackRate = Math.max(0.25, Math.min(4, rate));
    // let the pitch rise with the speed; the browsers default to correcting it
    if('preservesPitch' in sfx) sfx.preservesPitch = false;
    if('mozPreservesPitch' in sfx) sfx.mozPreservesPitch = false;
    if('webkitPreservesPitch' in sfx) sfx.webkitPreservesPitch = false;
    sfx.currentTime = 0;
    var pr = sfx.play();
    if(pr && pr['catch']) pr['catch'](function(){});
  }catch(e){}
}
function soundStop(){
  if(!sfx) return;
  try{ sfx.pause(); sfx.currentTime = 0; }catch(e){}
}

/* ---------------- the clock ----------------
   Two minutes. The daily run scores a percentage equal to the seconds left, so
   finishing with 110 seconds to spare is worth 110% of the raw score. The two
   quizzes simply stop when the time does. */
var clock = { on:false, endAt:0, left:0, raf:0 };
function fmtClock(sec){
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec/60) + ':' + ('0' + (sec % 60)).slice(-2);
}
function paintClock(){
  var el = $('clock');
  el.textContent = fmtClock(clock.left);
  el.classList.toggle('warn', clock.left <= 30 && clock.left > 10);
  el.classList.toggle('out', clock.left <= 10);
}
function startClock(){
  clock.on = true; clock.endAt = performance.now() + SPRINT_SECONDS*1000;
  clock.left = SPRINT_SECONDS;
  $('clock').hidden = false; paintClock();
  if(clock.raf) cancelAnimationFrame(clock.raf);
  (function tick(){
    if(!clock.on) return;
    clock.left = (clock.endAt - performance.now())/1000;
    paintClock();
    if(clock.left <= 0){ clock.left = 0; clock.on = false; timeUp(); return; }
    clock.raf = requestAnimationFrame(tick);
  })();
}
function stopClock(){
  clock.on = false;
  if(clock.raf){ cancelAnimationFrame(clock.raf); clock.raf = 0; }
  $('clock').hidden = true;
}
function secondsLeft(){ return Math.max(0, Math.floor(clock.left)); }
function showTimesUp(then){
  var el = $('timeup');
  el.hidden = false;
  // let it land before the layout changes underneath it
  requestAnimationFrame(function(){ el.classList.add('on'); });
  setTimeout(function(){
    el.classList.remove('on');
    setTimeout(function(){ el.hidden = true; }, 260);
    then();
  }, 1100);
}
function timeUp(){
  paintClock();
  if(S.sprint){ stopClock(); showTimesUp(function(){ finishSprint(false); }); return; }
  else if(S.mode === 'play' || S.mode === 'reveal') finish();
}

/* ---------------- state ---------------- */
var S = { mode:'idle', practice:false, dayKey:utcDayKey(), picks:[], round:0,
          results:[], total:0, story:0, quiz:null, timed:false };

/* ---------------- names ---------------- */
var TIDY={'United States of America':'United States','United Republic of Tanzania':'Tanzania',
 'S. Sudan':'South Sudan','Czech Republic':'Czechia','Macedonia':'North Macedonia','Swaziland':'Eswatini',
 'Cape Verde':'Cabo Verde','East Timor':'Timor-Leste','Republic of Serbia':'Serbia','The Bahamas':'Bahamas',
 'Guinea Bissau':'Guinea-Bissau','Ivory Coast':'Côte d’Ivoire','Democratic Republic of the Congo':'DR Congo',
 'Federated States of Micronesia':'Micronesia'};
function tidy(a){ return TIDY[a] || a; }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function sojournLine(legs, st){
  var bits = [];
  if(legs && legs.length){
    var came = [], went = [], back = [];
    legs.forEach(function(L){
      (L.mode === 'both' ? back : L.mode === 'after' ? went : came).push(esc(L.e.n));
    });
    var parts = [];
    if(came.length) parts.push('came from ' + listWords(came));
    if(back.length) parts.push('back and forth with ' + listWords(back));
    if(went.length) parts.push('went on to ' + listWords(went));
    bits.push('<span class="soj"><b>The sojourn</b> &mdash; ' + parts.join('; ') + '</span>');
  }
  if(st && st.n > 1) bits.push('Story ' + (st.i+1) + ' of ' + st.n + ' here');
  return bits.join(' &nbsp;&middot;&nbsp; ');
}
function listWords(a){
  if(a.length <= 1) return a[0] || '';
  if(a.length === 2) return a[0] + ' and ' + a[1];
  return a.slice(0,-1).join(', ') + ' and ' + a[a.length-1];
}
function fullName(e){ return e.n === e.c ? e.n : (e.n + ', ' + e.c); }
function flagUrl(cc){
  return M.INLINE ? ((window.__FLAGS__ || {})[cc] || '') : M.assetUrl('flags/' + cc + '.svg');
}
function fullNameHtml(e){
  if(e.n === e.c) return esc(e.n);
  return esc(e.n) + '<span class="comma">,</span> ' + esc(e.c);
}
function isWaterId(id){ return GD.admins[GD.gA[id]] === 'Water'; }
// The answer's kind is never a mystery, so a pick of the wrong kind is just a
// slip. Reject it before the ring fills rather than spending the guess on it.
function wrongKind(id){
  var e = null;
  if(S.sprint) e = S.sprint.bag[S.sprint.at].e;
  else if(S.mode === 'play') e = asEntry(S.picks[S.round]);
  if(!e) return null;
  var wantWater = !!e.w, gotWater = isWaterId(id);
  if(wantWater === gotWater) return null;
  return wantWater ? 'That one is on land \u2014 this answer is a body of water'
                   : 'That one is water \u2014 this answer is on land';
}
/* In the Countries game every place outside the focus country is asked as a whole
   country and its internal lines are dissolved, so a press inside it is a press on
   the country. Show it that way too: outline and name the country, not the region
   the pixel happens to belong to. Same for the Global Countries quiz. */
function wholeCountryMode(){
  return true;   // every game is the Countries game now
}
function asWholeCountry(id){
  if(!wholeCountryMode()) return false;
  var raw = GD.admins[GD.gA[id]] || '';
  if(raw === 'Water') return false;
  return raw !== SET.focus;                    // the focus country keeps its regions
}
function pickIds(id){
  return asWholeCountry(id) ? (byAdmin[GD.gA[id]] || [id]) : [id];
}
function pickName(id){
  return asWholeCountry(id) ? tidy(GD.admins[GD.gA[id]] || '') : regionName(id);
}
/* Some places are smaller than a fingertip however far you zoom in -- the
   District of Columbia is about 26 km across, Monaco 13 -- so demanding an exact
   hit tests aim rather than geography. When one of those is the answer, a press
   that lands close enough to it counts as a press on it. The assist only ever
   applies to the place being asked, and only while it is genuinely small, so it
   can never make an ordinary question easier or hand you a place you did not aim
   at. */
var TOUCH_PX = 44, ASSIST_MAX_KM = 60;
function askedEntry(){
  if(S.sprint) return S.sprint.bag[S.sprint.at].e;
  if(S.mode === 'play') return asEntry(S.picks[S.round]);
  return null;
}
function assistKm(e){
  var half = (TOUCH_PX/2) * M.degPerPx() * 111.32;   // half a fingertip, in km
  if((e.rad || 0) * 6371 >= half) return 0;          // already a fingertip wide on screen
  return Math.min(ASSIST_MAX_KM, half);
}
function assistPick(p, x, y){
  if(S.mode === 'learn') return p;
  var e = askedEntry();
  if(!e || !e.t || !e.t.length) return p;
  if(p && e.t.indexOf(p.id) >= 0) return p;             // already on it
  var tol = assistKm(e);
  if(tol <= 0) return p;
  var at = p || M.lonLatAt(x, y);
  if(!at) return p;
  if(M.gcKm(at.lon, at.lat, e.x/100, e.y/100) > tol) return p;
  return { id: e.t[0], lon: at.lon, lat: at.lat };
}
function regionName(id){
  var raw = GD.admins[GD.gA[id]] || '';
  if(raw === 'Water') return GD.gL[id] || 'Open water';
  var nm = GD.gL[id] || '', adm = tidy(raw);
  return (nm && nm !== GD.admins[GD.gA[id]]) ? (nm + ', ' + adm) : adm;
}

/* ---------------- UI helpers ---------------- */
function show(el,on){ el.classList.toggle('on', !!on); }
function refreshQuit(){
  var on = (S.mode === 'play' || S.mode === 'reveal' || S.mode === 'learn' || S.mode === 'bridge');
  var b = $('quitBtn');
  b.hidden = !on;
  b.innerHTML = (S.mode === 'learn') ? '&times;&nbsp; Back to menu' : '&times;&nbsp; Quit round';
}
function askLeave(on){
  $('askWrap').hidden = !on;
  if(on){
    var mid = S.round > 0 || S.results.length > 0 || (S.sprint && S.sprint.done > 0);
    $('askTitle').textContent = S.sprint ? 'Leave the sprint?'
                              : S.practice ? 'Leave this practice run?'
                                           : 'Leave today\u2019s round?';
    $('askBody').textContent = !mid
      ? 'Nothing has been scored yet, so nothing will be lost.'
      : S.sprint ? 'The clock is running. Leaving now discards the whole run, both phases.'
      : S.practice ? 'You are part way through a practice run. Leaving now discards it.'
      : 'You are part way through today\u2019s five. Leaving now discards the rounds you have played so far, and you can start again from the beginning.';
    $('askNo').focus();
  }
}
function setHint(t){ var h=$('hint'); h.textContent=t; h.style.opacity = t ? '1' : '0'; }
function toast(msg){ var t=$('toast'); t.textContent=msg; t.classList.add('on');
  setTimeout(function(){ t.classList.remove('on'); }, 1800); }
function closeSheets(){ $('revealSheet').classList.remove('up'); $('storySheet').classList.remove('up');
  $('reviewSheet').classList.remove('up'); $('bridgeSheet').classList.remove('up'); }

/* ---------------- the two quizzes ----------------
   One place at a time from a shuffled bag, three tries each, and every answered
   place keeps its colour so the map fills in as you go. */
/* ---------------- Phase 2: the sprint ----------------
   One minute, fifteen places: three drawn from each of the five round pools, so
   the sprint walks the same ladder the daily just climbed. A place is worth a
   tenth of what it was worth in Phase 1, rounded up. Answer all fifteen before
   the minute is out and the seconds you did not spend are added to the score. */
var SPRINT_SECONDS = 60;
var GREAT_LAKES = ['Lake Superior','Lake Michigan','Lake Huron','Lake Erie','Lake Ontario'];

function sprintBag(seed){
  var rounds = buildCountryRounds(), flags = buildFlagDeck(), bag = [];
  for(var r=0;r<5;r++){
    // A round's three questions are drawn from one pool: its places, and from
    // round two on its flags as well. Which of the two you get is the draw.
    var cand = (rounds[r] || []).map(function(v){ return { e: asEntry(v), r: r, flag: false }; });
    (flags[r] || []).forEach(function(e){ cand.push({ e: e, r: r, flag: true }); });
    bag = bag.concat(shuffled(cand, seed + '|' + r).slice(0, SPRINT_COUNT[r]));
  }
  return bag;
}
function startSprint(){
  var seed = 'sprint|' + (S.practice ? Math.random() + '|' + Date.now() : S.dayKey);
  S.phase = 2;
  S.sprint = { bag: sprintBag(seed), at:0, score:0, done:0, right:0, log:[], bonus:0, sweep:0 };
  S.mode = 'play'; refreshQuit();
  closeSheets(); closePanels();
  show($('introView'), false); show($('resultsView'), false);
  $('topbar').style.display = 'flex';
  $('clock').hidden = false;
  M.idle(false); M.setShift(0); M.clearMarks(); M.clearQuiz(); M.setPulse(false);
  M.uniforms.uShowMask.value = 1;
  M.target.dist = 3.1;
  startClock();
  nextSprintPlace();
}
function nextSprintPlace(){
  var q = S.sprint; if(!q) return;
  if(q.at >= q.bag.length){ finishSprint(true); return; }
  clearWrong();
  M.uniforms.uSel.value = 0;
  var item = q.bag[q.at], e = item.e;
  $('shapes').innerHTML = shapeRow(S.results, SPRINT_SHAPE, null);
  $('roundLabel').innerHTML = 'Sprint &middot; ' + (q.at + 1) + ' of ' + q.bag.length +
    (S.practice ? ' &middot; practice' : '');
  $('multLabel').textContent = sprintPts(item.r) + ' points';
  $('tallyOf').textContent = ' pts';
  $('tally').textContent = q.score;
  if(item.flag){
    $('promptFind').textContent = 'Find this country';
    $('promptName').innerHTML = '<img class="flagimg" src="' + flagUrl(e.fl) + '" alt="">';
  } else {
    $('promptFind').textContent = 'Find';
    $('promptName').innerHTML = fullNameHtml(e);
  }
  $('promptBox').style.display = 'flex';
  setHint('Press & hold on the place');
}
function sprintGuess(pick){
  var q = S.sprint; if(!q) return;
  var item = q.bag[q.at], e = item.e;
  var right = e.t.indexOf(pick.id) >= 0;
  var pts = right ? sprintPts(item.r) : 0;
  q.score += pts; q.done++; if(right) q.right++;
  q.log.push({ e:e, r:item.r, flag:item.flag, right:right, pts:pts });
  clearWrong();
  M.paintQuiz(e.t, right ? 1 : 4);          // blue for found, orange for missed
  M.uniforms.uSel.value = 0;
  $('tally').textContent = q.score;
  setHint(right ? '+' + pts : 'That was it');
  q.at++;
  if(clock.on) setTimeout(function(){ if(S.sprint && clock.on) nextSprintPlace(); }, 620);
  else finishSprint(false);
}
function finishSprint(completed){
  var q = S.sprint; if(!q) return;
  q.bonus = completed ? secondsLeft() : 0;          // the clock, for getting through
  q.sweep = (q.right === q.bag.length) ? SPRINT_SWEEP : 0;   // and for missing none
  q.score += q.bonus + q.sweep;
  stopClock();
  S.total = S.phase1Total + q.score;
  S.mode = 'done'; refreshQuit();
  M.setPulse(false); M.uniforms.uSel.value = 0;
  $('topbar').style.display = 'none'; $('promptBox').style.display = 'none';
  setHint(''); M.idle(true); M.setShift(0); M.target.dist = 3.4;
  if(!S.practice){ saveDay(); submitScore(); }
  renderResults();
  show($('resultsView'), true);
}
/* Between the phases: a beat to explain what is about to happen, because the
   rules change and a clock is about to start. */
function openBridge(){
  S.mode = 'bridge'; refreshQuit();
  closeSheets();
  $('topbar').style.display = 'none';
  $('promptBox').style.display = 'none';
  setHint('');
  M.idle(true); M.setShift(0); M.target.dist = 3.4;
  $('brP1').textContent = S.phase1Total;
  $('bridgeSheet').classList.add('up');
}

/* ---------------- round flow ---------------- */
function startGame(practice){
  S.sprint = null; S.phase = 1;
  S.practice = practice;
  S.picks = practice ? practicePicks() : dailyPicks(S.dayKey);
  S.round = 0; S.results = []; S.total = 0; S.phase1Total = 0;
  resetStoryPicks(); ensureFacts();   // the reveal wants to know if a story has a journey
  stopClock();
  show($('introView'), false); show($('resultsView'), false);
  $('topbar').style.display='flex';
  M.idle(false); M.setShift(0);
  beginRound();
}
function beginRound(){
  var e = asEntry(S.picks[S.round]);
  S.mode = 'play';
  refreshQuit();
  clearWrong();
  M.clearMarks(); M.setPulse(false); closeSheets();
  $('tallyOf').textContent = '/' + PHASE1_MAX;
  $('clock').hidden = true;
  $('shapes').innerHTML = shapeRow(S.results, S.round, null);
  $('tally').textContent = S.total;
  $('roundLabel').innerHTML = 'Round ' + (S.round+1) + ' of 5 &middot; the ' + SHAPE_NAME[S.round] +
    (S.practice ? ' &middot; practice' : '');
  $('multLabel').textContent = '×' + MULT[S.round] + ' — up to ' + (100*MULT[S.round]) + ' points';
  // Phase 1 always asks by name; flags belong to the sprint now
  $('promptFind').textContent = 'Find';
  $('promptName').innerHTML = fullNameHtml(e);
  $('promptBox').style.display='flex';
  setHint('Press & hold to lock in');
  M.target.dist = Math.min(M.MAX_D, Math.max(2.9, M.target.dist));
}
function commitGuess(pick){
  if(S.mode !== 'play') return;
  var e = asEntry(S.picks[S.round]);
  var exact = e.t.indexOf(pick.id) >= 0;
  var same = !e.w && GD.gA[pick.id] === e.a;   // 'same country' is meaningless at sea
  var gx = GD.gX[pick.id]/100, gy = GD.gY[pick.id]/100;
  var km = exact ? 0 : M.gcKm(gx, gy, e.x/100, e.y/100);
  var base = scoreFor(km, exact, same);
  var plain = scoreFor(km, exact, false);
  var pts = Math.round(base * MULT[S.round]);
  var r = { e:e, base:base, bonus:base-plain, pts:pts, km:km, exact:exact,
            same:same, guessId:pick.id, gx:gx, gy:gy };
  S.results.push(r);
  S.total += pts;
  S.mode = 'reveal';
  refreshQuit();
  showReveal(e, r);
}
function showReveal(e, r){
  var tx = e.x/100, ty = e.y/100;
  setMasks(e);
  M.uniforms.uSel.value = r.exact ? 0 : r.guessId;
  M.clearOutlines();
  if(!e.w && e.n !== e.c) M.outline('country', byAdmin[e.a] || []);
  var rad = M.outline('answer', e.t, tx, ty) || e.rad || 0.06;
  if(!r.exact){
    var gids = pickIds(r.guessId);
    M.outline('guess', gids);
    // one region pulses through uSel; a whole country is painted instead
    if(gids.length > 1){ M.uniforms.uSel.value = 0; paintWrong(gids); }
    M.drawArc(r.gx, r.gy, tx, ty);
  }

  var mid = r.exact ? [tx,ty] : midpoint(r.gx, r.gy, tx, ty);
  var sep = r.exact ? 0 : angleBetween(r.gx, r.gy, tx, ty);
  var half = Math.max(sep/2 + 0.06, (rad||0.06) * 1.5, 0.055);
  M.target.lon = M.aimLon(mid[0]); M.target.lat = Math.max(-84, Math.min(84, mid[1]));
  M.target.dist = M.distForAngle(half);

  $('rvShapes').innerHTML = shapeRow(S.results, -1, null);
  $('rvTally').textContent = S.total;
  $('promptBox').style.display='none';
  setHint('');
  $('rvName').innerHTML = fullNameHtml(e);
  $('rvRound').innerHTML = 'Round ' + (S.round+1) + ' &middot; ×' + MULT[S.round];
  $('rvPts').textContent = r.pts;
  $('rvCalc').textContent = r.base + ' × ' + MULT[S.round];
  $('rvLegend').innerHTML = r.exact
    ? '<div><i style="background:#0137FF"></i>You found it</div>'
    : '<div><i style="background:#0137FF"></i>Answer</div>' +
      '<div><i style="background:#FF6600"></i>' + esc(pickName(r.guessId)) + '</div>';
  $('rvDist').textContent = r.exact ? '' : fmtKm(r.km) + ' away';
  $('rvBonus').style.display = (!r.exact && r.bonus > 0) ? 'inline-flex' : 'none';
  $('rvBonus').textContent = '+' + r.bonus + ' right country';
  var rm = $('rvMore'); rm.hidden = true;
  (function(round){
    ensureFacts().then(function(){
      if(S.round !== round || S.mode !== 'reveal') return;   // moved on already
      if(journeyLegs(storyFor(e, !S.practice)).length){
        rm.innerHTML = '<b>There is a journey here.</b> See where else this story went in ' +
                       'Visit &amp; Learn, after round five.';
        rm.hidden = false;
      }
    });
  })(S.round);
  $('nextBtn').textContent = (S.round === 4) ? 'Next Phase' : 'Next round';
  M.setPulse(true);
  M.setShift(0.115);
  setTimeout(function(){ $('revealSheet').classList.add('up'); }, 260);
}
function nextRound(){
  closeSheets(); M.setShift(0);
  if(S.round === 4){ endPhase1(); return; }
  S.round++;
  setTimeout(beginRound, 260);
}
function endPhase1(){
  S.phase1Total = S.total;
  setTimeout(openBridge, 260);
}

/* ---------------- the shareable card ----------------
   Emoji has coloured circles and squares but no coloured diamond, hexagon or
   star, so a text row can carry the shape or the colour, never both. Drawing the
   row ourselves gets both: a small PNG that travels with the text. */
var shareCard = null, cardUrl = null, cardData = null;
function shapePath(i){
  var m = SHAPE[i].match(/d="([^"]+)"/);
  return m ? new Path2D(m[1]) : null;
}
function drawShape(ctx, i, x, y, size, col){
  ctx.save();
  ctx.translate(x, y); ctx.scale(size/18, size/18);
  ctx.fillStyle = col;
  if(i === 0){ ctx.beginPath(); ctx.arc(9, 9, 7.2, 0, Math.PI*2); ctx.fill(); }
  else if(i === 1){
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(2.4, 2.4, 13.2, 13.2, 2.2);
    else ctx.rect(2.4, 2.4, 13.2, 13.2);
    ctx.fill();
  } else { var p = shapePath(i); if(p) ctx.fill(p, 'evenodd'); }
  ctx.restore();
}
function buildShareCard(){
  shareCard = null; cardData = null;
  if(!S.results.length) return;
  try{
    var R = 2, W = 660, H = 372;
    var cv = document.createElement('canvas');
    cv.width = W*R; cv.height = H*R;
    var ctx = cv.getContext('2d');
    if(!ctx) return;
    ctx.scale(R, R);
    ctx.fillStyle = '#0C0B0A'; ctx.fillRect(0, 0, W, H);

    var mono = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
    var disp = 'Fraunces, Georgia, "Times New Roman", serif';
    var q = S.sprint, total = S.total;

    // top row: the game on the left, the mode on the right, both larger
    ctx.fillStyle = '#E0A44A'; ctx.font = '600 22px ' + mono;
    ctx.fillText('SOJOURNER  \u00b7  ' +
      (S.practice ? 'PRACTICE' : prettyDate(S.dayKey).toUpperCase()), 40, 62);
    var mode = levelLabel().toUpperCase();
    ctx.fillStyle = '#A99D8F'; ctx.font = '600 18px ' + mono;
    ctx.fillText(mode, W - 40 - ctx.measureText(mode).width, 62);

    ctx.fillStyle = '#F0E8DA'; ctx.font = '600 82px ' + disp;
    ctx.fillText(String(total), 40, 152);

    var cell = 76, gap = 14, x0 = 40, y0 = 196;
    S.results.forEach(function(r, i){
      var cx = x0 + i*(cell+gap);
      drawShape(ctx, i, cx, y0, 56, tierColor(r.base));
      ctx.fillStyle = '#C3B9AD'; ctx.font = '500 21px ' + mono;
      var t = String(r.pts), w = ctx.measureText(t).width;
      ctx.fillText(t, cx + 28 - w/2, y0 + 90);
    });
    if(q){
      var qx = x0 + 5*(cell+gap);
      drawShape(ctx, SPRINT_SHAPE, qx, y0, 56, tierColor(sprintBase(q)));
      ctx.fillStyle = '#C3B9AD'; ctx.font = '500 21px ' + mono;
      var qt = String(q.score), qw = ctx.measureText(qt).width;
      ctx.fillText(qt, qx + 28 - qw/2, y0 + 90);
      // under it: how many were found, or -- if all of them were -- the time left
      var sub = sprintNote(q);
      ctx.fillStyle = '#8A8073'; ctx.font = '500 15px ' + mono;
      ctx.fillText(sub, qx + 28 - ctx.measureText(sub).width/2, y0 + 112);
    }

    ctx.fillStyle = '#59B9A4'; ctx.font = '500 20px ' + mono;
    ctx.fillText(SITE_LABEL, 40, H - 30);

    // a data URL of the same picture, so the clipboard can also carry a rich
    // flavour: the card wrapped in an <a>, which pastes as a clickable image
    try{ cardData = cv.toDataURL('image/png'); }catch(e){ cardData = null; }

    cv.toBlob(function(b){
      shareCard = b;
      if(!b) return;
      // built for the clipboard only; the score page already shows the score
    }, 'image/png');
  }catch(e){ shareCard = null; }
}

/* ---------------- results ---------------- */
function sq(base){
  if(base >= 90) return '\u{1F7E9}';
  if(base >= 70) return '\u{1F7E8}';
  if(base >= 40) return '\u{1F7E7}';
  if(base > 0)   return '\u{1F7E5}';
  return '⬛';
}
// Leaving Phase 1 without playing the sprint -- only reachable by the clock
// never starting, which cannot happen now, but kept so the state machine closes.
function finish(){
  S.mode = 'done'; refreshQuit();
  $('topbar').style.display='none'; $('promptBox').style.display='none';
  setHint(''); M.clearMarks(); M.setPulse(false); M.idle(true); M.setShift(0);
  M.target.dist = 3.5;
  if(!S.practice){ saveDay(); submitScore(); }
  renderResults();
  show($('resultsView'), true);
}
// A practice run is a side trip; make the way back to today's game explicit.
function backToDaily(){
  closePanels(); closeSheets();
  if(!loadDay()){ startGame(false); return; }
  S.mode = 'done'; S.practice = false; refreshQuit();
  M.clearMarks(); M.setPulse(false); M.idle(true); M.setShift(0);
  M.target.dist = 3.5;
  $('topbar').style.display = 'none';
  $('promptBox').style.display = 'none';
  setHint('');
  show($('introView'), false);
  renderResults();
  show($('resultsView'), true);
}
/* A timed run leaves its answers painted on the globe. Review puts the globe back
   in front of you with a list of everything it asked, so the two can be read
   together. */
function renderReview(){
  var q = S.sprint; if(!q) return;
  $('rvwTitle').textContent = 'Sprint \u00b7 review';
  $('rvwCount').textContent = sprintNote(q);
  if(!q.log.length){
    $('rvwList').innerHTML = '<p class="note">The clock ran out before a place was settled.</p>';
    return;
  }
  $('rvwList').innerHTML = q.log.map(function(row, i){
    return '<button type="button" class="rvw" data-i="' + i + '">' +
           '<i style="background:' + (row.right ? '#0137FF' : '#FF6600') + '"></i>' +
           '<span class="nm">' + fullNameHtml(row.e) +
           (row.flag ? ' <span class="tr">flag</span>' : '') + '</span>' +
           '<span class="tr">' + (row.right ? '+' + row.pts : 'missed') + '</span></button>';
  }).join('');
}
function openReview(){
  if(!S.sprint) return;
  S.mode = 'review'; refreshQuit();
  show($('resultsView'), false);
  $('topbar').style.display = 'none'; $('promptBox').style.display = 'none';
  M.idle(false); M.setShift(0.20); setHint('');
  M.clearOutlines(); M.uniforms.uSel.value = 0;
  M.target.dist = 3.2;
  renderReview();
  $('rvwBody').scrollTop = 0;
  $('reviewSheet').classList.add('up');
}
function closeReview(){
  $('reviewSheet').classList.remove('up');
  M.clearOutlines(); M.setShift(0); M.idle(true); M.target.dist = 3.4;
  S.mode = 'done'; refreshQuit();
  setTimeout(function(){ show($('resultsView'), true); }, 200);
}
function reviewGoTo(i){
  var q = S.sprint; if(!q || !q.log[i]) return;
  var row = q.log[i], e = row.e, lon = e.x/100, lat = e.y/100;
  M.clearOutlines();
  // blue rings a place you found, orange one you missed -- the fill already says
  // which, and a blue ring round an orange country said both at once
  var rad = M.outline(row.right ? 'answer' : 'guess', e.t, lon, lat) || e.rad || 0.06;
  M.target.lon = M.aimLon(lon); M.target.lat = Math.max(-84, Math.min(84, lat));
  M.target.dist = M.distForAngle(Math.max(rad * 1.9, 0.10));
  Array.prototype.forEach.call($('rvwList').querySelectorAll('.rvw'), function(b){
    b.classList.toggle('on', +b.getAttribute('data-i') === i);
  });
}
function renderResults(){
  buildShareCard();
  var q = S.sprint;
  $('factsBtn').style.display = '';
  $('resScoreDen').textContent = ' points';
  $('resDate').textContent = S.practice ? 'Practice round' : ('Daily · ' + prettyDate(S.dayKey));
  $('resScore').textContent = S.total;
  $('resShapes').innerHTML = shapeRow(S.results, -1, q || null);
  var sum = $('quizSum');
  if(q){
    sum.innerHTML =
      '<span><i style="background:#0137FF"></i>+' + q.right + ' found</span>' +
      '<span><i style="background:#FF6600"></i>' + Math.max(0, q.done - q.right) + ' missed</span>' +
      (q.sweep ? '<span><i style="background:#59B9A4"></i>+' + q.sweep + ' all twelve</span>' : '') +
      (q.bonus ? '<span><i style="background:#59B9A4"></i>+' + q.bonus + ' seconds left</span>'
               : '<span>time ran out</span>');
    sum.hidden = false;
  } else sum.hidden = true;
  var rows = $('resRows'); rows.innerHTML='';
  S.results.forEach(function(r,i){
    var e = r.e;
    var d = document.createElement('div'); d.className='brow';
    d.innerHTML = '<div class="rn">'+shapeSvg(i,'done',r.base)+'</div>' +
      '<div class="pn">'+esc(fullName(e))+'</div>' +
      '<div class="dd">'+(r.exact ? 'exact' : fmtKm(r.km))+'</div>' +
      '<div class="pp">'+r.pts+'</div>';
    rows.appendChild(d);
  });
  if(q){
    var d2 = document.createElement('div'); d2.className = 'brow';
    d2.innerHTML = '<div class="rn">' + shapeSvg(SPRINT_SHAPE,'done',sprintBase(q)) + '</div>' +
      '<div class="pn">Sprint</div>' +
      '<div class="dd">' + sprintNote(q) + '</div>' +
      '<div class="pp">' + q.score + '</div>';
    rows.appendChild(d2);
  }
  // Playing again is a decision for the main page, which is one tap away; three
  // things to do here beats five.
  $('resNote').textContent = S.practice
    ? 'Practice runs are freshly shuffled every time and are not saved.'
    : 'Everyone playing today gets these same five places and the same sprint. '
      + 'A new set arrives at midnight UTC.';
  $('shareBox').style.display='none';
}
function shareText(){
  // The five shapes carry the round, the numbers carry the score. Emoji has no
  // coloured diamond, hexagon or star, so the colour stays on its own row.
  var head = 'Sojourner \u00b7 ' + (S.practice ? 'practice' : prettyDate(S.dayKey));
  var line = S.results.map(function(r,i){ return SHAPE_CHAR[i] + ' ' + r.pts; }).join('   ');
  var out = head + '\n' + S.total + '\n' +
            S.results.map(function(r){ return sq(r.base); }).join('') + '\n' + line + '\n';
  var q = S.sprint;
  if(q) out += SHAPE_CHAR[SPRINT_SHAPE] + ' ' + sprintNote(q) + ' \u00b7 ' + q.score +
               (q.bonus ? ' (+' + q.bonus + 's)' : '') + '\n';
  return out + GAME_URL;
}
function doShare(){
  var txt = shareCard ? GAME_URL : shareText();
  function fallback(){
    var b = $('shareBox'); b.value = txt; b.style.display='block';
    b.focus(); b.select(); toast('Select and copy the text below');
  }
  function copyText(){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(function(){ toast('Copied — paste it to a friend'); }, fallback);
    } else fallback();
  }
  // the card is built ahead of the click, so the share sheet still counts as a gesture
  if(shareCard && navigator.canShare){
    var f = new File([shareCard], 'sojourner.png', {type:'image/png'});
    if(navigator.canShare({files:[f]})){
      navigator.share({text:txt, files:[f]}).then(function(){}, copyText);
      return;
    }
  }
  if(shareCard && navigator.clipboard && window.ClipboardItem && navigator.clipboard.write){
    var flavours = { 'image/png': shareCard };
    if(cardData){
      // Mail, Docs and most chat composers take this one: the card itself is the
      // link. Anywhere that only understands plain text falls back to the URL,
      // and the site's own preview card draws the picture there instead.
      var html = '<a href="' + GAME_URL + '"><img src="' + cardData +
                 '" alt="Sojourner score card" width="660" height="372"></a>';
      flavours['text/html'] = new Blob([html], {type:'text/html'});
    }
    flavours['text/plain'] = new Blob([txt], {type:'text/plain'});
    navigator.clipboard.write([new ClipboardItem(flavours)]).then(function(){
      toast('Copied — paste it to a friend');
    }, copyText);
    return;
  }
  copyText();
}

/* ---------------- stories on the globe ---------------- */
function openStories(i){
  var btn = $('factsBtn'), label = btn.getAttribute('data-label') || btn.textContent;
  btn.setAttribute('data-label', label);
  btn.textContent = 'Loading the stories\u2026'; btn.disabled = true;
  factsFailed = false;              // a fresh attempt every time the button is pressed
  ensureFacts().then(function(){
    btn.textContent = label; btn.disabled = false;
    reallyOpenStories(i);           // opens either way; a failure says so in the sheet
  });
}
function reallyOpenStories(i){
  S.mode = 'story'; S.story = i;
  show($('resultsView'), false);
  $('topbar').style.display='none'; $('promptBox').style.display='none';
  M.idle(false); setHint('');
  goStory(i);
}
function journeyLegs(st){
  if(!st || !st.j) return [];
  var out = [];
  for(var k=0;k<st.j.length && out.length<3;k++){
    var leg = st.j[k], e = byPlace[leg[0] + '|' + leg[1]];
    if(e) out.push({ e:e, mode:leg[2] });
  }
  return out;
}
function drawJourney(anchor, legs){
  M.clearArrows();
  if(!legs.length) return null;
  var pts = [[anchor.x/100, anchor.y/100]], k, j;
  for(k=0;k<legs.length;k++){
    var o = legs[k].e;
    for(j=0;j<o.t.length;j++) M.maskData[o.t[j]*4 + 2] = 255;   // blue channel = purple wash
  }
  M.maskTex.needsUpdate = true;
  var ids = [];
  for(k=0;k<legs.length;k++) ids = ids.concat(legs[k].e.t);
  M.outline('other', ids);
  for(k=0;k<legs.length;k++){
    var L = legs[k], ox = L.e.x/100, oy = L.e.y/100;
    // the arrow is drawn other -> anchor, so 'before' points at the anchor
    var mode = L.mode === 'after' ? 'from' : (L.mode === 'both' ? 'both' : 'to');
    M.drawArrow(k, ox, oy, anchor.x/100, anchor.y/100, mode);
    pts.push([ox, oy]);
  }
  return pts;
}
function frameAll(pts){
  var D = Math.PI/180, sx=0, sy=0, sz=0, k;
  for(k=0;k<pts.length;k++){
    var v = vec3(pts[k][0], pts[k][1]);
    sx+=v[0]; sy+=v[1]; sz+=v[2];
  }
  var L = Math.hypot(sx,sy,sz) || 1; sx/=L; sy/=L; sz/=L;
  var lon = Math.atan2(-sz, sx)/D, lat = Math.asin(Math.max(-1,Math.min(1,sy)))/D;
  var half = 0;
  for(k=0;k<pts.length;k++) half = Math.max(half, angleBetween(lon, lat, pts[k][0], pts[k][1]));
  return { lon:lon, lat:lat, half:half };
}
function goStory(i){
  if(!S.results.length) return;
  i = Math.max(0, Math.min(S.results.length - 1, i));
  if(!factsLoaded && !factsFailed){
    $('stFact').textContent = 'Loading the story\u2026';
    ensureFacts().then(function(){ goStory(i); });
    return;
  }
  S.story = i;
  var r = S.results[i], e = r.e;
  var tx = e.x/100, ty = e.y/100;
  var st = storyFor(e, !S.practice);
  M.clearMarks();
  setMasks(e);
  M.clearOutlines();
  if(!e.w && e.n !== e.c) M.outline('country', byAdmin[e.a] || []);
  var rad = M.outline('answer', e.t, tx, ty) || e.rad || 0.06;

  // a story may carry a journey: the other places in the life, and the way between
  var legs = journeyLegs(st), pts = drawJourney(e, legs);
  if(pts){
    var fr = frameAll(pts);
    M.target.lon = M.aimLon(fr.lon); M.target.lat = Math.max(-84, Math.min(84, fr.lat));
    M.target.dist = M.distForAngle(Math.max(fr.half * 1.28 + 0.05, 0.20));
  }else{
    M.target.lon = M.aimLon(tx); M.target.lat = Math.max(-84, Math.min(84, ty));
    M.target.dist = M.distForAngle(Math.max((rad||0.06)*2.0, 0.20));
  }
  M.setShift(0.20);
  M.setPulse(true);

  $('stShape').innerHTML = shapeSvg(i,'done',r.base);
  $('stRound').innerHTML = 'Round ' + (i+1) + ' &middot; ' + r.pts + ' pts';
  $('stName').innerHTML = fullNameHtml(e);
  $('stFact').textContent = st ? st.f : noStoryText();
  var a = $('stSource');
  if(st && st.u){ a.href = st.u; a.textContent = st.s || 'Source'; a.style.display='inline'; }
  else a.style.display='none';
  var more = $('stMore');
  if(more) more.innerHTML = sojournLine(legs, st);
  $('stCount').textContent = (i+1) + ' / ' + S.results.length;
  $('stPrev').disabled = (i === 0);
  $('stNext').disabled = (i >= S.results.length - 1);
  // the last card hands over to the sprint, so the whole look-back is one path
  var last = (i >= S.results.length - 1) && S.sprint && S.sprint.log.length;
  $('stReview').style.display = last ? 'block' : 'none';
  var body = $('stBody'); if(body) body.scrollTop = 0;
  $('storySheet').classList.add('up');
}
function closeStories(){
  closeSheets(); M.clearMarks(); M.setPulse(false); M.setShift(0); M.idle(true);
  M.target.dist = 3.5; S.mode = 'done'; refreshQuit();
  setTimeout(function(){ show($('resultsView'), true); }, 200);
}

/* ---------------- learn mode ---------------- */
function startLearn(){
  S.mode = 'learn'; S.practice = false; refreshQuit();
  show($('introView'), false); show($('resultsView'), false);
  closeSheets();
  $('topbar').style.display = 'none';
  $('promptBox').style.display = 'none';
  M.clearMarks(); M.setPulse(false); M.setShift(0); M.idle(false);
  M.target.dist = 3.2;
  ensureFacts();          // fetch them now, so the first hold has a story to tell
  setHint('Press & hold anywhere to identify it');
}
function showLearn(pick){
  // Explore reaches this before anything else asks for the stories, so on the
  // hosted build they may still be a fetch away. Wait rather than report that
  // every place is unresearched.
  if(!factsLoaded && !factsFailed){
    setHint('Loading the stories\u2026');
    var again = function(){
      setHint('Press & hold anywhere to identify it');
      showLearn(pick);
    };
    ensureFacts().then(again, again);
    return;
  }
  var raw = GD.admins[GD.gA[pick.id]] || '', lbl = GD.gL[pick.id] || '';
  var e;
  if(raw === 'Water'){
    var wi = learnIndex[pick.id];
    e = (wi === undefined) ? null : POOL[wi];
  } else {
    // The game asks for whole countries, so Explore names whole countries too --
    // and a country with no story of its own borrows one from its regions.
    var a = GD.gA[pick.id];
    e = countryEntry[a] || synthCountry(a, 5, GD.flagA[a] || '');
    if(!e.t || !e.t.length) e = null;
  }
  var isWater = e ? !!e.w : (raw === 'Water');
  var isRegion = false;                     // never a region any more
  var name = e ? fullName(e) : regionName(pick.id);
  var ids = e ? e.t : [pick.id];
  var homeA = e ? e.a : GD.gA[pick.id];
  var lon = e ? e.x/100 : pick.lon, lat = e ? e.y/100 : pick.lat;

  var lst = e ? storyFor(e, false) : null;
  var legs = journeyLegs(lst);

  M.clearArrows();
  M.maskData.fill(0);
  if(isRegion){ var home = byAdmin[homeA] || []; for(var k=0;k<home.length;k++) M.maskData[home[k]*4+1] = 255; }
  for(var j=0;j<ids.length;j++) M.maskData[ids[j]*4] = 255;
  M.maskTex.needsUpdate = true;
  M.uniforms.uShowMask.value = 1;
  M.uniforms.uSel.value = 0;
  M.clearOutlines();
  if(isRegion) M.outline('country', byAdmin[homeA] || []);
  var rad = M.outline('answer', ids, lon, lat) || (e && e.rad) || 0.06;

  var pts = e ? drawJourney(e, legs) : null;
  M.setPulse(true);
  if(pts){
    var fr = frameAll(pts);
    M.target.lon = M.aimLon(fr.lon); M.target.lat = Math.max(-84, Math.min(84, fr.lat));
    M.target.dist = M.distForAngle(Math.max(fr.half * 1.28 + 0.05, 0.20));
  }else{
    M.target.lon = M.aimLon(lon); M.target.lat = Math.max(-84, Math.min(84, lat));
    M.target.dist = M.distForAngle(Math.max(rad*1.6, 0.055));
  }
  M.setShift(0.16);

  $('lnKind').textContent = isWater ? 'Water' : 'Country';
  $('lnName').innerHTML = e ? fullNameHtml(e) : esc(name);
  var a = $('lnSource');
  if(lst && lst.f){
    $('lnFact').textContent = lst.f;
    if(lst.u){ a.href = lst.u; a.textContent = lst.s || 'Source'; a.style.display = 'inline'; }
    else a.style.display = 'none';
  } else {
    $('lnFact').textContent = noStoryText();
    a.style.display = 'none';
  }
  $('lnMore').innerHTML = sojournLine(legs, lst);
  $('learnSheet').classList.add('up');
}
function closeLearn(){
  $('learnSheet').classList.remove('up');
  M.clearMarks(); M.setPulse(false); M.setShift(0);
  setHint('Press & hold anywhere to identify it');
}

function resetToIntro(){
  closeSheets(); closePanels();
  M.clearMarks(); M.setPulse(false); M.setShift(0); M.idle(true);
  M.target.dist = 3.5;
  S.mode = 'idle'; S.practice = false; S.results = []; S.total = 0; S.round = 0;
  S.sprint = null; S.phase = 1; stopClock(); M.clearQuiz(); applySettings();
  askLeave(false); refreshQuit();
  $('topbar').style.display = 'none';
  $('promptBox').style.display = 'none';
  setHint('');
  show($('resultsView'), false);
  show($('introView'), true);
  refreshIntro();
}
// A country can be the focus only if every one of its regions is in the game and
// there are at least five of them; otherwise its map would have holes.
function focusCandidates(){
  var groups = {}, asked = {}, i;
  for(i=1;i<GD.gA.length;i++){
    var a = GD.gA[i], nm = GD.admins[a];
    if(nm === 'Water') continue;
    (groups[nm] || (groups[nm] = {}))[i] = 1;
  }
  POOL.forEach(function(p){
    if(p.w) return;
    var nm = GD.admins[p.a];
    p.t.forEach(function(t){ (asked[nm] || (asked[nm] = {}))[t] = 1; });
  });
  var out = [];
  Object.keys(groups).forEach(function(nm){
    var g = Object.keys(groups[nm]), a = asked[nm] ? Object.keys(asked[nm]) : [];
    if(g.length < 5 || a.length !== g.length) return;
    for(var k=0;k<g.length;k++) if(!asked[nm] || !asked[nm][g[k]]) return;
    out.push({ raw:nm, label:tidy(nm), n:g.length });
  });
  out.sort(function(x,y){ return x.label < y.label ? -1 : 1; });
  return out;
}
function buildFocusOptions(){
  var list = focusCandidates(), sel = $('selFocus');
  if(!list.length) return;
  if(!list.some(function(o){ return o.raw === SET.focus; })) SET.focus = list[0].raw;
  sel.innerHTML = list.map(function(o){
    return '<option value="' + esc(o.raw) + '"' + (o.raw === SET.focus ? ' selected' : '') +
           '>' + esc(o.label) + ' \u00b7 ' + o.n + ' regions</option>';
  }).join('');
}
function renderLevelRow(){
  $('levelRow').innerHTML = LEVELS.map(function(L){
    return '<button type="button" data-lv="' + L[0] + '" aria-pressed="' +
           (SET.mode === L[0] ? 'true' : 'false') + '">' + L[1] + '</button>';
  }).join('');
}
function playButton(act, label, sub, primary){
  return '<button class="btn ' + (primary ? '' : 'alt') + '" data-go="' + act + '">' +
         esc(label) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</button>';
}
function refreshIntro(){
  if(!ready) return;
  renderLevelRow();
  replay = loadDay();
  $('playRow').innerHTML =
    playButton('daily', replay ? 'See result' : 'Play Daily Game',
               replay ? 'You have played today' : 'Five rounds + a 1 min sprint', true) +
    playButton('practice', 'Practice', '', false) +
    playButton('explore', 'Explore', '', false);
}

/* ---------------- persistence ---------------- */
function saveDay(){
  try{
    var sp = S.sprint ? { score:S.sprint.score, right:S.sprint.right, bonus:S.sprint.bonus,
                          n:S.sprint.bag.length, log:S.sprint.log } : null;
    localStorage.setItem('sojourner:'+S.dayKey, JSON.stringify(
      {total:S.total, results:S.results, picks:S.picks, p1:S.phase1Total, sprint:sp}));
  }catch(e){}
}
function loadDay(){
  try{
    var raw = localStorage.getItem('sojourner:'+S.dayKey);
    if(!raw) return false;
    var d = JSON.parse(raw);
    if(!d || !d.results || d.results.length !== 5) return false;
    S.total = d.total; S.results = d.results; S.picks = d.picks; S.practice = false; S.round = 4;
    S.phase1Total = (d.p1 === undefined) ? d.total : d.p1;
    S.sprint = d.sprint ? { score:d.sprint.score, right:d.sprint.right, bonus:d.sprint.bonus,
                            bag:new Array(d.sprint.n), log:d.sprint.log || [],
                            at:d.sprint.n, done:d.sprint.n } : null;
    return true;
  }catch(e){ return false; }
}

/* ---------------- input ---------------- */
var el = document.getElementById('glwrap');
var ptrs = {}, drag = null, hold = null, pinch = null, hintT = null;
var reticle = $('reticle'), retArc = $('retArc');

function setReticle(x,y,on){
  reticle.style.left = x+'px'; reticle.style.top = y+'px';
  reticle.classList.toggle('on', !!on);
}
function cancelHold(keep){
  // 'keep' means the hold ran its course: the chime is due exactly now, so the
  // clip is left to finish rather than cut off at the moment it pays off.
  if(hold){ if(hold.raf) cancelAnimationFrame(hold.raf); if(hold.t) clearTimeout(hold.t);
            if(hold.pick && !keep) soundStop(); hold=null; }
  clearChoosing();
  reticle.classList.remove('on');
  retArc.setAttribute('stroke-dashoffset', ARC_LEN);
  if((S.mode === 'play' && !S.sprint) || S.mode === 'learn') M.uniforms.uSel.value = 0;
}
function startHold(x,y){
  cancelHold();
  hold = { x:x, y:y, t:setTimeout(function(){
    if(!hold) return;
    var p = assistPick(M.pickAt(x,y), x, y);
    if(!p){
      // every square of sea is named now, so a null pick means the press missed
      // the globe entirely rather than landing on unmapped ocean
      cancelHold(); setHint(S.mode === 'learn' ? 'Nothing here to identify' : 'Hold on the globe');
      clearTimeout(hintT);
      hintT = setTimeout(function(){ if(S.mode==='play') setHint('Press & hold to lock in');
                                     else if(S.mode==='learn') setHint('Press & hold anywhere to identify it'); }, 1600);
      return;
    }
    var wk = (S.mode === 'learn') ? null : wrongKind(p.id);
    if(wk){
      cancelHold(); setHint(wk);
      clearTimeout(hintT);
      hintT = setTimeout(function(){
        if(S.sprint) setHint('Press & hold on the place');
        else if(S.mode==='play') setHint('Press & hold to lock in'); }, 1800);
      return;
    }
    hold.pick = p;
    // Globetrotter is meant to be navigated by terrain alone, so lighting up the
    // country under your thumb would hand over the very shape it withholds.
    if(S.mode === 'learn') M.uniforms.uSel.value = p.id;
    else if(SET.mode !== 'expert') paintChoosing(pickIds(p.id));
    setReticle(x,y,true);
    soundStart();
    var t0 = performance.now();
    (function step(){
      if(!hold) return;
      var k = Math.min(1, (performance.now()-t0)/holdMs());
      retArc.setAttribute('stroke-dashoffset', ARC_LEN*(1-k));
      if(k >= 1){ var pk = hold.pick; cancelHold(true);
        if(S.mode === 'learn'){ showLearn(pk); }
        else if(S.sprint){ sprintGuess(pk); }
        else { commitGuess(pk); }
        return; }
      hold.raf = requestAnimationFrame(step);
    })();
  }, PREVIEW_MS) };
}
el.addEventListener('pointerdown', function(ev){
  el.setPointerCapture(ev.pointerId);
  ptrs[ev.pointerId] = {x:ev.clientX, y:ev.clientY};
  var n = Object.keys(ptrs).length;
  M.idle(false);
  if(n === 1){
    drag = {id:ev.pointerId, x:ev.clientX, y:ev.clientY, moved:false};
    if(S.mode === 'play' || S.mode === 'learn') startHold(ev.clientX, ev.clientY);
  } else if(n === 2){
    cancelHold(); drag = null;
    var k = Object.keys(ptrs), a = ptrs[k[0]], b = ptrs[k[1]];
    pinch = {d0: Math.hypot(a.x-b.x, a.y-b.y), z0: M.target.dist};
  }
});
function clampD(d){ return Math.max(M.MIN_D, Math.min(M.MAX_D, d)); }
el.addEventListener('pointermove', function(ev){
  if(!ptrs[ev.pointerId]) return;
  ptrs[ev.pointerId].x = ev.clientX; ptrs[ev.pointerId].y = ev.clientY;
  var k = Object.keys(ptrs);
  if(pinch && k.length === 2){
    var a = ptrs[k[0]], b = ptrs[k[1]];
    var d = Math.hypot(a.x-b.x, a.y-b.y);
    if(d > 4) M.target.dist = clampD(pinch.z0 * (pinch.d0/d));
    return;
  }
  if(!drag || ev.pointerId !== drag.id) return;
  var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  if(!drag.moved && Math.hypot(dx,dy) > MOVE_TOL){ drag.moved = true; cancelHold(); }
  if(!drag.moved) return;
  var f = M.degPerPx() * SET.timing;
  M.target.lon -= dx * f;
  M.target.lat = Math.max(-85, Math.min(85, M.target.lat + dy * f));
  drag.x = ev.clientX; drag.y = ev.clientY;
});
function onUp(ev){
  delete ptrs[ev.pointerId];
  if(Object.keys(ptrs).length < 2) pinch = null;
  if(drag && ev.pointerId === drag.id) drag = null;
  cancelHold();
}
el.addEventListener('pointerup', onUp);
el.addEventListener('pointercancel', onUp);
el.addEventListener('lostpointercapture', onUp);
el.addEventListener('wheel', function(ev){
  ev.preventDefault(); M.idle(false);
  M.target.dist = clampD(M.target.dist * Math.exp(ev.deltaY * 0.0011));
}, {passive:false});

/* ---------------- geo maths for framing ---------------- */
function vec3(lo,la){ var D=Math.PI/180;
  return [Math.cos(la*D)*Math.cos(lo*D), Math.sin(la*D), -Math.cos(la*D)*Math.sin(lo*D)]; }
function angleBetween(lo1,la1,lo2,la2){
  var a=vec3(lo1,la1), b=vec3(lo2,la2);
  return Math.acos(Math.max(-1,Math.min(1, a[0]*b[0]+a[1]*b[1]+a[2]*b[2])));
}
function midpoint(lo1,la1,lo2,la2){
  var D=Math.PI/180, a=vec3(lo1,la1), b=vec3(lo2,la2);
  var m=[a[0]+b[0], a[1]+b[1], a[2]+b[2]];
  var L=Math.hypot(m[0],m[1],m[2]); if(L<1e-6) return [lo1,la1];
  m=[m[0]/L,m[1]/L,m[2]/L];
  return [Math.atan2(-m[2],m[0])/D, Math.asin(Math.max(-1,Math.min(1,m[1])))/D];
}

/* ---------------- wiring ---------------- */
$('levelRow').addEventListener('click', function(ev){
  var b = ev.target.closest('button[data-lv]'); if(!b) return;
  SET.mode = b.getAttribute('data-lv');
  saveSettings(); applySettings(); refreshIntro();
});
$('playRow').addEventListener('click', function(ev){
  var b = ev.target.closest('button[data-go]'); if(!b || !ready) return;
  var go = b.getAttribute('data-go');
  if(go === 'explore'){ startLearn(); return; }
  if(go === 'practice'){ startGame(true); return; }
  if(go === 'daily'){
    if(replay){ show($('introView'), false); M.idle(true); renderResults(); show($('resultsView'), true); }
    else startGame(false);
    return;
  }
});
$('setLink').addEventListener('click', function(){ $('settingsBtn').click(); });
$('helpBtn').addEventListener('click', function(){ openPanel('helpSheet'); });
$('makeBtn').addEventListener('click', function(){ openPanel('makeSheet'); });
$('friendsBtn').addEventListener('click', function(){ openPanel('friendsSheet'); });
$('makeDone').addEventListener('click', closePanels);
$('friendsDone').addEventListener('click', closePanels);
$('helpDone').addEventListener('click', closePanels);
$('homeBtn').addEventListener('click', resetToIntro);
$('leaveBtn').addEventListener('click', backToDaily);
$('nextBtn').addEventListener('click', nextRound);
$('shareBtn').addEventListener('click', doShare);
$('brGo').addEventListener('click', function(){
  $('bridgeSheet').classList.remove('up');
  setTimeout(startSprint, 240);
});
$('stReview').addEventListener('click', function(){
  closeSheets(); setTimeout(openReview, 220);
});
$('rvwBack').addEventListener('click', closeReview);
$('rvwList').addEventListener('click', function(ev){
  var b = ev.target.closest('.rvw'); if(!b) return;
  reviewGoTo(+b.getAttribute('data-i'));
});
$('factsBtn').addEventListener('click', function(){ openStories(0); });
$('stPrev').addEventListener('click', function(){ if(S.story>0) goStory(S.story-1); });
$('stNext').addEventListener('click', function(){ if(S.story < S.results.length-1) goStory(S.story+1); });
$('stBack').addEventListener('click', closeStories);
function openPanel(id){
  closePanels();
  $('scrim').classList.add('on');
  $(id).classList.add('up');
}
var PANELS = ['settingsSheet','profileSheet','helpSheet','makeSheet','friendsSheet'];
function closePanels(){
  $('scrim').classList.remove('on');
  PANELS.forEach(function(id){ $(id).classList.remove('up'); });
}
$('settingsBtn').addEventListener('click', function(){
  var mid = S.practice && (S.mode === 'play' || S.mode === 'reveal' || S.mode === 'story');
  $('rowLeave').style.display = mid ? 'block' : 'none';
  syncSettingsUI(); openPanel('settingsSheet');
});
$('profileBtn').addEventListener('click', function(){ openPanel('profileSheet'); });
$('setDone').addEventListener('click', closePanels);
$('lnClose').addEventListener('click', closeLearn);
$('quitBtn').addEventListener('click', function(){
  if(S.mode === 'learn'){ resetToIntro(); return; }   // nothing to lose in Learn
  askLeave(true);
});
$('askNo').addEventListener('click', function(){ askLeave(false); });
$('askYes').addEventListener('click', function(){ askLeave(false); resetToIntro(); });
$('askWrap').addEventListener('click', function(ev){ if(ev.target === $('askWrap')) askLeave(false); });
document.addEventListener('keydown', function(ev){
  if(ev.key === 'Escape' && !$('askWrap').hidden) askLeave(false);
});
$('profDone').addEventListener('click', closePanels);
$('scrim').addEventListener('click', closePanels);
$('segStyle').addEventListener('click', function(ev){
  var b = ev.target.closest('button'); if(!b) return;
  SET.style = b.getAttribute('data-v'); saveSettings();
  M.setStyle(SET.style); syncSettingsUI();
});
$('selFocus').addEventListener('change', function(){
  SET.focus = this.value; saveSettings();
  countryRounds = null; countryRoundsFor = null;
  applySettings(); resetToIntro();
});
$('segUnits').addEventListener('click', function(ev){
  var b = ev.target.closest('button'); if(!b) return;
  SET.units = b.getAttribute('data-v'); saveSettings(); syncSettingsUI();
  if(S.mode === 'reveal' || S.mode === 'done') refreshDistances();
});
$('rngTiming').addEventListener('input', function(){
  SET.timing = parseInt(this.value,10)/100; saveSettings();
});
$('tglSound').addEventListener('click', function(){
  SET.sound = !SET.sound; saveSettings(); syncSettingsUI();
  if(!SET.sound) soundStop(); else soundStart();
});
function refreshDistances(){
  var r = S.results[S.results.length-1];
  if(S.mode === 'reveal' && r) $('rvDist').textContent = r.exact ? '' : fmtKm(r.km) + ' away';
  if(S.mode === 'done') renderResults();
}
loadSettings();
applySettings();

(function(){
  $('segStyle').innerHTML = STYLES.map(function(s){
    return '<button type="button" data-v="'+s[0]+'">'+s[1]+'</button>';
  }).join('');
})();

$('introDate').textContent = prettyDate(S.dayKey);
(function(){
  var h='';
  for(var i=0;i<5;i++) h += '<div class="lad">' + shapeSvg(i,'todo',0) +
    '<div class="lad-m">×' + MULT[i] + '</div></div>';
  h += '<div class="lad">' + shapeSvg(SPRINT_SHAPE,'todo',0) +
       '<div class="lad-m">sprint</div></div>';
  $('introLadder').innerHTML = h;
})();

var ready = false, replay = false;


M.onReady = function(){
  indexData();
  initSound();
  var em = $('emblemImg');
  if(em) em.src = M.INLINE ? (window.__EMBLEM__ || '') : M.assetUrl('emblem.png');
  replay = loadDay();
  ready = true;
  buildFocusOptions();
  // the first applySettings ran before the map arrived, so the focus country
  // could not be resolved to an admin index yet; settle it now
  applySettings();
  refreshIntro();
};
M.onLoadError = function(){ $('playRow').innerHTML =
  '<div class="note">Could not load the map. Reload to try again.</div>'; };
})();
