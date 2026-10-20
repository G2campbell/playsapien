/* Word Chain's chains, in three pools, and which chain belongs to which day.

   The game no longer carries the bank. Every chain is the game's intellectual
   property, so the page holds only a few practice chains and asks the server for
   the rest, one at a time (routes/wordchain-play.js). This file is where the
   server decides WHICH one.

   THREE POOLS (Kai, 20 Oct 2026), so that the daily challenge feels fresh:

     daily      ~250 chains that are NEVER practice, not even after they have been a
                daily. Players only ever meet them as dailies. Chains players make
                belong here too (they are scheduled into days by the admin queue and
                are never in the bank below).
     reserve    ~100 chains that are dailies first. Once one has been a daily it joins
                practice; before that, practice may dip into them only if it has to.
     practice   everything else: practice first, and a daily only if the other
                pools run out. The 34 original chains (every one already a daily, in
                the old rotation) start here.

   The DAILY ORDER is untouched: it is still the game's calendar (gamedata.json), the
   chains in the order they were laid out, so days already planned do not move. The
   pools are a classification laid over that order -- the first 250 of the newer chains
   are 'daily', the next 100 'reserve', the rest 'practice' -- which is also what keeps
   the pair-spacing the calendar was built with. Change POOL_SIZES to move the
   boundaries; nothing else depends on them.

   PRACTICE draws, for a device, from: the practice pool and reserve chains that have
   already been a daily (tier 1), then reserve chains that have not (tier 2), and only
   when the device has seen all of those, repeats. The 'daily' pool is never touched,
   and neither is today's chain. */

import Engine from '../../../packages/scoring/wordchain.cjs';
import gamedata from '../../../games/wordchain/src/gamedata.json' with { type: 'json' };
import { first } from './db.js';

export const POOL_SIZES = { daily: 250, reserve: 100 };

const BANK = gamedata.chains;
const CAL = gamedata.calendar;
const LEGACY = CAL.legacy;

export const BANK_SIZE = BANK.length;

export function poolOf(idx) {
  if (idx < LEGACY) return 'practice';
  const k = idx - LEGACY;
  if (k < POOL_SIZES.daily) return 'daily';
  if (k < POOL_SIZES.daily + POOL_SIZES.reserve) return 'reserve';
  return 'practice';
}

/* What the game is given for a chain: the words, and the two things about each link
   that the rules need. Nothing about quality, level or pool. */
export function shape(id, chain) {
  return {
    id,
    words: chain.words,
    links: (chain.links || chain.words.slice(1).map(() => ({}))).map((l) => ({
      numberStrict: !!l.numberStrict, alt: l.alt || '',
    })),
  };
}

/* The bank chain the calendar puts on a day. */
export function bankIndexForDay(dayKey) {
  return Engine.idxForDay(CAL, BANK_SIZE, Engine.dayNumber(dayKey));
}

/* The chain for a day: a player's chain the admin has scheduled for it, if there is
   one, otherwise the calendar's. Used both to SERVE a day and to CHECK a finished
   daily against it, so the two can never disagree. */
export async function chainForDay(db, dayKey) {
  const row = await first(db,
    `SELECT c.id, c.words,
            /* A proposed name the author has not yet confirmed can be part of their
               email address, so it is never put in front of everyone. */
            CASE WHEN u.name_chosen_at IS NULL THEN NULL ELSE u.display_name END AS display_name,
            u.handle
       FROM chains c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.scheduled_for = ? AND c.status = 'approved' AND c.pool = 'daily'`, dayKey);
  if (row) {
    try {
      const words = JSON.parse(row.words);
      if (Array.isArray(words) && words.length >= 2) {
        return {
          id: row.id, words, links: words.slice(1).map(() => ({ numberStrict: false })),
          author: row.display_name || row.handle || null, source: 'player',
        };
      }
    } catch { /* a corrupt row falls through to the calendar rather than breaking the day */ }
  }
  const idx = bankIndexForDay(dayKey);
  return { id: idx, words: BANK[idx].words, links: BANK[idx].links, source: 'bank' };
}

/* The day a bank chain is (first) a daily: the newer chains run one a day from the
   calendar's start. Legacy chains were dailies in the old rotation, long ago. */
function firstDailyDay(idx) {
  return idx < LEGACY ? -Infinity : CAL.start + (idx - LEGACY);
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Up to n practice chains for a device that has already seen `seen` (bank indexes).
   `today` is the UTC day number. */
export function practiceBatch(today, seen, n) {
  const seenSet = new Set(seen);
  const todaysIdx = bankIndexForDay(Engine.dayKeyOf(today));
  const tier1 = [], tier2 = [];
  for (let i = 0; i < BANK_SIZE; i++) {
    if (i === todaysIdx) continue;                     // never today's, whatever pool it is in
    const pool = poolOf(i);
    if (pool === 'daily') continue;                    // never practice
    const used = firstDailyDay(i) < today;
    if (pool === 'practice' || used) tier1.push(i); else tier2.push(i);
  }
  const unseen = (t) => shuffle(t.filter((i) => !seenSet.has(i)));
  const picked = unseen(tier1);
  if (picked.length < n) picked.push(...unseen(tier2));
  if (picked.length < n) picked.push(...shuffle(tier1.filter((i) => seenSet.has(i))));   // a repeat, last
  return picked.slice(0, n).map((i) => shape(i, BANK[i]));
}

/* The pools as they stand, for the admin surface. */
export function poolStats(today) {
  const todaysIdx = bankIndexForDay(Engine.dayKeyOf(today));
  const count = { daily: 0, reserve: 0, practice: 0 };
  let tier1 = 0, tier2 = 0;
  for (let i = 0; i < BANK_SIZE; i++) {
    const pool = poolOf(i);
    count[pool]++;
    if (i === todaysIdx || pool === 'daily') continue;
    if (pool === 'practice' || firstDailyDay(i) < today) tier1++; else tier2++;
  }
  return { chains: BANK_SIZE, ...count, practice_ready: tier1, reserve_unused: tier2, sizes: { ...POOL_SIZES } };
}
