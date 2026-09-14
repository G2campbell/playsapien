/* The game. Everything platform-shaped is already wired by the time this runs:
 PSTheme has stamped the theme pre-paint, PSUI owns sheets and toasts, and PS
 is the offline-first client for accounts, streaks and friends.

 An ES module, so it has its own scope and can import the SDK. Word Chain
 shipped 107 globals for a year because it was a classic script, and on one
 shared origin that is a collision waiting to happen.

 PS is the platform client, served once at /sdk.js and cached across every
 surface -- the payoff of putting the whole platform on one origin. */
import PS from '/sdk.js';

var $ = function (id) { return document.getElementById(id); };

/* ---- platform wiring. Four lines, the same four in every game. --------- */
PSUI.init({ sheets: ['aboutSheet', 'settingsSheet'], scrim: 'scrim', toast: 'toast' });
PSTheme.bindControl($('themeSeg'));
PS.init({ baseUrl: '/api' });
var DAY = PS.dayKey();                  // UTC, platform-wide. Never local time.

$('daystamp').textContent = DAY;

/* ---- the game's own settings ------------------------------------------ */
var KEY = 'template:';                  // <- your game's prefix. One origin,
                                        //    one keyspace: never write a bare key.
function get(k, dflt) {
  try { var v = localStorage.getItem(KEY + k); return v === null ? dflt : JSON.parse(v); }
  catch (e) { return dflt; }
}
function set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) {} }

var sound = get('sound', true);
function paintSettings() { $('soundToggle').setAttribute('aria-pressed', sound ? 'true' : 'false'); }
$('soundToggle').addEventListener('click', function () {
  sound = !sound; set('sound', sound); paintSettings();
});
paintSettings();

/* ---- the round -------------------------------------------------------- */
var MAX = 100;                          // your game's perfect score

function start() {
  // Build today's puzzle from DAY so every player gets the same one, and so
  // the same date always produces the same puzzle. Seed a PRNG from it --
  // never Math.random() for the daily.
  $('board').textContent = 'Playing ' + DAY;
  $('playBtn').disabled = true;
}

/* Call when the round ends. saveResult writes localStorage first and
   synchronously, then syncs; a dead backend is invisible to the player and a
   failed sync is retried on next load. Do not await it to render. */
function finish(score, detail, durationMs) {
  PS.saveResult({
    game: 'template',                   // <- your game's slug, matching its path
    day: DAY, mode: 'daily',
    score: score, maxScore: MAX,
    detail: detail, durationMs: durationMs
  });
  PSUI.toast('Scored ' + score + ' of ' + MAX);
}

$('playBtn').addEventListener('click', start);

/* Anything that paints its own colours -- a share card on a canvas -- has to
 redraw when the theme changes, or it keeps yesterday's palette.
 PSTheme.onChange(redrawTheCard); */
