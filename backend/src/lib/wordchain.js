/* Word Chain on the server: the run stamp, and the replay of a finished daily.

   Word Chain is ranked on TIME (lowest wins), and the time is the GAME'S OWN
   clock: the playing time, which stops while the player is paused or has the
   window in the background. That is deliberate. A phone call, a knock at the door
   or a switch to another app must never cost anyone time, so the ranked time has
   to match the clock the player watched.

   The server does not measure the time; it keeps the game's clock from lying
   about being longer than it could have been, with two stamps:

     START   when the game begins it asks for a run (POST /api/play/run). The
             Worker answers with a token that carries the day and the moment it
             answered, signed so it cannot be edited or made up.
     FINISH  when the finished daily arrives, the Worker notes the moment.

   A run is ranked only if the game's playing time fits inside what the server
   saw pass between the two. Pauses are allowed for free -- the playing time can
   be shorter than the gap -- so this checks one side only, and it cannot catch a
   player who claims a shorter time than they played. That is a choice, not an
   oversight: every chain is in the page the game ships, so a determined cheater
   can solve one in seconds on any clock, and the rankings are friends-only, where
   a time nobody believes is simply not believed. What the checks do give is a
   daily that was really started on the server, a time that is not absurd, and the
   Lifeline penalty worked out here rather than taken on trust.

   Ranked, in plain terms: the run has a genuine stamp for this day; the playing
   time is at least ten seconds (seven words cannot be typed faster) and at most
   an hour of play; and it is no longer than the server's start-to-finish gap, give
   or take a few seconds of network delay.
   When any of that fails the result is stored UNRANKED, not refused: it still
   counts for the player's own record and streak. No stamp at all (offline when the
   game began, or the server was down) is the commonest reason.

   The chain itself is checked by replaying how it was solved with the same code
   the game uses (packages/scoring/wordchain.cjs), against the game's own
   gamedata.json and calendar. If the game ever fetches its daily from the bank in
   the database instead (routes/wordchain.js bank()), this has to follow. */

import Engine from '../../../packages/scoring/wordchain.cjs';
import gamedata from '../../../games/wordchain/src/gamedata.json' with { type: 'json' };
import { isWord } from './dictionary.js';
import { chainForDay } from './wcpools.js';
import { hmacSign, hmacVerify } from './crypto.js';

export const MIN_RUN_MS = 10_000;
/* An hour of playing time, pauses not counted. */
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

/* A finished daily, replayed. `x` = { run, now, env, db }:
     run        the token the game was given at the start (or undefined)
     now        the Worker's clock, seconds -- the FINISH stamp
   The game's playing time is in the moves (baseMs, penalty not included).
   Returns { error } for moves that are not a solved chain, else
   { score, detail, ranked, durationMs }, where durationMs is that playing time
   plus the penalty the replay found -- the same either way; ranking is the only
   thing that differs. */
export async function replayWordchain(moves, day, x) {
  /* The chain that day actually played: a player's chain the admin scheduled, or the
     calendar's. The same lookup that serves the day to the game. */
  const v = Engine.verify(gamedata, moves, day, isWord, await chainForDay(x.db, day));
  if (!v.ok) return { error: v.error };

  const detail = { chain: v.chain, hints: v.hints, penalty_ms: v.penaltyMs, base_ms: v.baseMs };

  const run = x.run ? await readRun(x.env, x.run) : null;
  let why = null, wall = null;
  if (!run) why = x.run ? 'bad_token' : 'no_run';
  else if (run.day !== day) why = 'wrong_day';
  else {
    wall = (x.now - run.startedSec) * 1000;
    if (v.baseMs < MIN_RUN_MS) why = 'too_fast';
    else if (v.baseMs > MAX_RUN_MS) why = 'too_long';
    /* Pauses make the playing time SHORTER than the gap, never longer. */
    else if (v.baseMs > wall + START_SLACK_MS) why = 'late_start';
  }

  const durationMs = v.baseMs + v.penaltyMs;
  if (why) {
    /* Valid, but not rankable: kept as the player's own record, on their own clock. */
    return { score: WORDCHAIN_LINKS, detail: { ...detail, ranked: false, why }, ranked: false, durationMs };
  }
  return {
    score: WORDCHAIN_LINKS,
    detail: { ...detail, ranked: true, wall_ms: wall },
    ranked: true,
    durationMs,
  };
}
