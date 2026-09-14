/* Input validation.

   Two rules run through all of it. First, validate before doing anything
   expensive -- a malformed body should never reach a hash, a mail send or a
   second query. Second, say what is wrong without saying anything the caller
   did not already know: "that code is not right", never "no account for that
   address". */

/* The declared maximum for each game. A submission whose max_score disagrees
   with this is rejected outright rather than clamped, because a disagreement
   means the client and the server are running different versions of the scoring
   rules, and the honest thing to do with a row you cannot interpret is refuse
   it.

   sojourner: 1000. partD.js:6-10 fixes phase 1 at 750 (100 + 125 + 150 + 175 +
     200) and the sprint ladder plus its sweep bonus tops out the remaining 250.

   wordchain: 7, and this one needs explaining. Word Chain has no points at all.
     spec-v3.md §1 settles it in one line: "Score: points -> None. A running
     clock, Pips-style." There is therefore no maximum in the client's scoring
     code to read, because there is no scoring code: finish() at
     part-c-app.js:392 records a time, a hint count and the letters bought per
     word, and nothing else. So the platform's `score` for Word Chain is the
     count of links solved, and an eight-word chain (spec-v3.md §2: word 1 given
     in full, words 2-8 guessed) has seven of them. The clock -- the number
     players actually care about -- travels in duration_ms, where it belongs and
     where a "fastest today" leaderboard can sort on it. Today the client only
     reaches finish() on a completed chain, so in practice every Word Chain
     score is 7; keeping it a count rather than a constant means a future
     abandon-and-keep-your-progress ending needs no schema change. */
export const MAX_SCORE = { sojourner: 1000, wordchain: 7 };
export const GAMES = Object.keys(MAX_SCORE);
export const MODES = ['daily', 'practice'];

/* Sojourner's sprint runs a minute and Word Chain's daily is open-ended, but
   nobody sits at one for six hours. A sanity bound, not a fraud check: the
   point is to keep a garbage value out of an average, not to catch anyone. */
export const MAX_DURATION_MS = 6 * 3600 * 1000;

/* detail is stored whole so that replay validation can be added retroactively
   (spec §5). 16 KB is roomy for five rounds of Sojourner or eight words of Word
   Chain, and small enough that nobody can use results as free object storage. */
export const MAX_DETAIL_BYTES = 16384;

export class Invalid extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

export function fail(message, code) {
  throw new Invalid(message, code);
}

/* ---------------------------------------------------------------- days */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Unix seconds to 'YYYY-MM-DD', UTC. The single definition of what day it is,
   used by the day validator, the streak walk and the chain scheduler alike.
   users.tz never participates: spec §5, and the audit found Word Chain deciding
   the day in local time, which is the bug this function exists to stop
   recurring. */
export function utcDay(nowSec) {
  const d = new Date(nowSec * 1000);
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

export function isDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  /* Rejects 2026-02-31 and friends: Date.UTC rolls them over silently, so the
     only reliable test is to format the parse back and compare. */
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Number.isFinite(t) && utcDay(t / 1000) === s;
}

export function shiftDay(day, deltaDays) {
  const [y, m, d] = day.split('-').map(Number);
  return utcDay(Date.UTC(y, m - 1, d + deltaDays) / 1000);
}

export function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/* Today or yesterday, UTC. Yesterday is the grace for someone who started at
   23:50 and finished at 00:05; anything older is a stale client clock or a
   backfill attempt, and neither belongs in a streak. */
export function isSubmittableDay(day, nowSec) {
  const today = utcDay(nowSec);
  return day === today || day === shiftDay(today, -1);
}

/* ---------------------------------------------------------------- strings */

export function normaliseEmail(input) {
  /* Deliberately not stripping gmail dots or plus-tags. Two addresses that
     happen to deliver to one inbox are still two addresses, and folding them
     would let one player quietly occupy another's account. */
  return String(input == null ? '' : input).trim().toLowerCase();
}

/* Not RFC 5322 -- that grammar accepts things no mail server will. This is the
   shape a human types, with a hard length cap so that a megabyte of 'a' cannot
   reach the hash function or the mail provider. */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>".]+\.[^\s@,;<>"]{2,}$/;

export function isEmail(s) {
  return typeof s === 'string' && s.length >= 6 && s.length <= 254 && EMAIL_RE.test(s);
}

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export function isHandle(s) {
  return typeof s === 'string' && HANDLE_RE.test(s);
}

/* Device ids are minted by the client as a UUIDv4 in `ps:device` (spec §2). Any
   RFC 4122 shape is accepted rather than version 4 specifically, because the id
   is a bucket key and not a credential -- what stops one device claiming
   another's history is that a claim requires a session, not that the id is hard
   to guess. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDeviceId(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function isSixDigits(s) {
  return typeof s === 'string' && /^[0-9]{6}$/.test(s);
}

/* Control characters, zero-width joiners and the bidirectional overrides that
   let a display name paint over the UI around it, all removed; whitespace runs
   collapsed; then trimmed and cut to length. Built from code points rather than
   written as a literal class so that the source file itself stays plain ASCII. */
const NASTY = new Set();
for (let c = 0x00; c <= 0x1f; c++) NASTY.add(c);
NASTY.add(0x7f);
for (let c = 0x200b; c <= 0x200f; c++) NASTY.add(c);
for (let c = 0x202a; c <= 0x202e; c++) NASTY.add(c);
for (let c = 0x2066; c <= 0x2069; c++) NASTY.add(c);

export function cleanDisplayName(s, max = 40) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    if (!NASTY.has(ch.codePointAt(0))) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function asObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Expected a JSON object.');
  return body;
}

/* A bounded list of strings, for { device_ids: [] } and { ids: [] }. Anything
   that is not a string is dropped rather than erroring: the caller is a client
   sending its own localStorage back, and one junk entry should not fail the
   whole claim. */
export function stringList(value, { max = 100, test = null } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    if (test && !test(v)) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}
