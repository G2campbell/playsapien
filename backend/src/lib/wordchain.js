/* Word Chain on the server: the run stamp, and the replay of a finished daily.

   Word Chain is ranked on TIME (lowest wins), and a browser can say any time it
   likes -- its clock even stops when the window loses focus. So the time is
   measured here, with two stamps:

     START   when the game begins it asks for a run (POST /api/play/run). The
             Worker answers with a token that carries the day and the moment it
             answered, signed so it cannot be edited or made up.
     FINISH  when the finished daily arrives, the Worker notes the moment.

   The ranked time is the gap between them, plus the penalty for the Lifelines
   the replay found (the game's own claim of its penalty is not read). Pausing,
   switching windows or putting the phone down does not stop that clock -- that
   is exactly what makes it fair to rank on.

   What stops it being ranked rather than refused:
     - no token (offline at the start, or the server was down): the run is still
       stored and still counts for the player's own record and streak;
     - the token is for another day;
     - under ten seconds (seven words cannot be typed in that), or over an hour
       (the player left and came back; it is not one sitting);
     - the browser's own clock says it played for LONGER than the server saw
       (by more than a few seconds of network delay): the start was held back.
   None of those is an error; the result is stored unranked.

   The chain itself is checked by replaying how it was solved with the same code
   the game uses (packages/scoring/wordchain.cjs). The chain comes from the game's
   own gamedata.json and calendar. If the game ever fetches its daily from the
   bank in the database instead (routes/wordchain.js bank()), this has to follow. */

import Engine from '../../../packages/scoring/wordchain.cjs';
import gamedata from '../../../games/wordchain/src/gamedata.json' with { type: 'json' };
import { isWord } from './dictionary.js';
import { hmacSign, hmacVerify } from './crypto.js';

export const MIN_RUN_MS = 10_000;
export const MAX_RUN_MS = 60 * 60 * 1000;
/* The start request takes a moment to arrive; a player's clock starts when they
   see the first word, the server's when it answers. */
export const START_SLACK_MS = 5_000;
export const WORDCHAIN_LINKS = 7;

const secretOf = (env) => env.OAUTH_STATE_SECRET || env.LOGIN_CODE_PEPPER;
const message = (day, startedSec) => 'wcrun:' + day + ':' + startedSec;

/* "<day>.<started>.<signature>". Nothing secret is in it: it is a stamp, not a
   credential, and is good only for the one day it names. */
export async function signRun(env, day, startedSec) {
  return day + '.' + startedSec + '.' + (await hmacSign(secretOf(env), message(day, startedSec)));
}

/* The stamp, if the token is genuine; otherwise null. */
export async function readRun(env, token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\.(\d{1,12})\.([A-Za-z0-9_-]{20,64})$/.exec(token);
  if (!m) return null;
  const ok = await hmacVerify(secretOf(env), message(m[1], m[2]), m[3]);
  return ok ? { day: m[1], startedSec: Number(m[2]) } : null;
}

/* A finished daily, replayed. `x` = { run, now, claimedMs, env }:
     run        the token the game was given at the start (or undefined)
     now        the Worker's clock, seconds -- the FINISH stamp
     claimedMs  the total the game's own clock showed, penalty included
   Returns { error } for moves that are not a solved chain, else
   { score, detail, ranked, durationMs }. */
export async function replayWordchain(moves, day, x) {
  const v = Engine.verify(gamedata, moves, day, isWord);
  if (!v.ok) return { error: v.error };

  const claimedMs = Number.isFinite(x.claimedMs) ? x.claimedMs : null;
  const detail = { chain: v.chain, hints: v.hints, penalty_ms: v.penaltyMs };

  const run = x.run ? await readRun(x.env, x.run) : null;
  let why = null, wall = null;
  if (!run) why = x.run ? 'bad_token' : 'no_run';
  else if (run.day !== day) why = 'wrong_day';
  else {
    wall = (x.now - run.startedSec) * 1000;
    if (wall < MIN_RUN_MS) why = 'too_fast';
    else if (wall > MAX_RUN_MS) why = 'too_long';
    else if (claimedMs === null) why = 'no_claim';
    else if (Math.max(0, claimedMs - v.penaltyMs) > wall + START_SLACK_MS) why = 'late_start';
  }

  if (why) {
    /* Valid, but not rankable: kept as the player's own record, on their own clock. */
    return { score: WORDCHAIN_LINKS, detail: { ...detail, ranked: false, why }, ranked: false, durationMs: claimedMs };
  }
  return {
    score: WORDCHAIN_LINKS,
    detail: { ...detail, ranked: true, wall_ms: wall },
    ranked: true,
    durationMs: wall + v.penaltyMs,
  };
}
