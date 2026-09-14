/* Word Chain: the submission queue and the daily bank.

   SUBMISSION-PIPELINE.md describes the whole flow and is worth reading before
   changing anything here. The part that matters for this file is its central
   rule: nothing reaches the daily pool without a human. The model, when it is
   wired up, may promote a chain to practice on its own and that is the whole of
   its write authority; "really good" sorts the admin queue, it does not empty
   it. A bad daily goes to every player at once and cannot be taken back once
   the day has started, so the daily pool has exactly one gate.

   This file therefore only ever writes status='pending'. The promotion paths
   all live in routes/admin.js. */

import { ok, err, ERRORS, readJson, conflict } from '../lib/http.js';
import { first, all, run, isUniqueViolation } from '../lib/db.js';
import { newId } from '../lib/id.js';
import { sha256Hex } from '../lib/crypto.js';
import { asObject, isDay, utcDay } from '../lib/validate.js';
import { consume } from '../middleware/ratelimit.js';

/* Eight words, per spec-v3 §2. The bounds are loose on purpose -- the composer
   is the thing that enforces the game's shape, and a backend that hard-coded
   eight would need a deploy the day a six-word variant is tried. What it does
   enforce is that a submission cannot be used as free storage. */
const MIN_WORDS = 4;
const MAX_WORDS = 12;
const MAX_WORD_LEN = 24;

/* POST /api/wordchain/chains  { words, credit } -> queue a submission */
export async function submitChain(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();

  /* A blocked author's submit button still works and the chain simply never
     leaves the queue -- SUBMISSION-PIPELINE.md calls this silent blocking and
     prefers it, because it wastes less of the operator's time than an argument.
     The response is indistinguishable from a successful queue. */
  const silentlyDropped = ctx.user.blocked;

  const body = await readJson(ctx.req);
  if (body.bad || body.tooLarge) return ERRORS.invalid('Send { words: [...] }.');
  const payload = asObject(body.value);

  const gate = await consume(ctx.db, 'chain', ctx.user.id, ctx.now);
  if (!gate.allowed) {
    return ERRORS.rateLimited(gate.retryAfter,
      'Five chains a day is the limit. Try again tomorrow.');
  }

  const words = normaliseWords(payload.words);
  if (!words) {
    return err('bad_chain',
      'A chain is ' + MIN_WORDS + ' to ' + MAX_WORDS + ' single words, letters only.', 400);
  }

  /* The dedupe key is the normalised chain, so the same eight words submitted
     twice -- by one person or by two -- collapse to one queue entry. Hashing
     rather than storing the joined string as the key keeps the index narrow and
     means the unique constraint cannot be defeated by whitespace. */
  const wordsHash = await sha256Hex(words.join(' '));

  if (silentlyDropped) {
    return ok({ id: newId('c'), status: 'pending', words });
  }

  const id = newId('c');
  try {
    await run(ctx.db,
      `INSERT INTO chains (id, author_id, words, words_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      id, ctx.user.id, JSON.stringify(words), wordsHash, ctx.now);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const mine = await first(ctx.db,
        'SELECT id, status FROM chains WHERE words_hash = ? AND author_id = ?',
        wordsHash, ctx.user.id);
      /* Their own resubmission gets the original back. Somebody else's
         identical chain gets a flat refusal with no detail -- telling a
         submitter that their chain already exists would leak what is in another
         player's queue. */
      if (mine) return conflict('already_submitted', 'You have already submitted that chain.', { chain: mine });
      return conflict('duplicate_chain', 'That chain cannot be accepted.', null);
    }
    throw e;
  }

  return ok({
    id,
    status: 'pending',
    words,
    /* The composer's checkbox says "once saved, this cannot be revoked", so the
       response says the same thing back rather than implying an undo exists. */
    credit: payload.credit === false ? false : true,
  }, { status: 201 });
}

function normaliseWords(input) {
  if (!Array.isArray(input)) return null;
  if (input.length < MIN_WORDS || input.length > MAX_WORDS) return null;
  const out = [];
  for (const w of input) {
    if (typeof w !== 'string') return null;
    const t = w.trim().toUpperCase();
    if (!/^[A-Z]{2,}$/.test(t) || t.length > MAX_WORD_LEN) return null;
    out.push(t);
  }
  /* A chain that repeats a word is not a chain. Cheap to check here and it
     spares the assessment model a question with an obvious answer. */
  if (new Set(out).size !== out.length) return null;
  return out;
}

/* GET /api/wordchain/chains/mine -> your submissions + status

   The author sees status and nothing else about a rejection. Spec and pipeline
   agree: a flagged chain's words show on the admin page and nowhere else, and
   the rejection reason is never fed back, because explaining exactly which rule
   tripped is a tutorial in getting past it. */
export async function myChains(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const rows = await all(ctx.db,
    `SELECT id, words, status, pool, scheduled_for, created_at, decided_at
       FROM chains WHERE author_id = ? ORDER BY created_at DESC LIMIT 50`, ctx.user.id);

  return ok({
    chains: rows.map((r) => ({
      id: r.id,
      words: safeWords(r.words),
      /* 'blocked' is collapsed into 'rejected' on the way out. The distinction
         is an operator's record, not news for the author. */
      status: r.status === 'blocked' ? 'rejected' : r.status,
      pool: r.pool,
      scheduled_for: r.scheduled_for,
      created_at: r.created_at,
      decided_at: r.decided_at,
    })),
  });
}

/* GET /api/wordchain/bank/:day -> the day's chain

   The client fetches the bank rather than carrying it inline, so a new chain
   reaches everyone without a redeploy (SUBMISSION-PIPELINE.md §5). */
export async function bank(ctx) {
  const day = ctx.params.day;
  if (!isDay(day)) return err('bad_day', 'day must be YYYY-MM-DD.', 400);

  /* A future day is not served, to anyone. The bank is scheduled up to ten days
     ahead, and an endpoint that answers "what is tomorrow's chain" hands the
     whole schedule to anybody who can count. */
  if (day > utcDay(ctx.now)) return ERRORS.notFound('That day has not happened yet.');

  const row = await first(ctx.db,
    `SELECT c.id, c.words, c.created_at, u.display_name, u.handle
       FROM chains c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.scheduled_for = ? AND c.status = 'approved' AND c.pool = 'daily'`, day);

  if (!row) return ERRORS.notFound('No chain is scheduled for that day.');

  return ok({
    day,
    chain: {
      id: row.id,
      words: safeWords(row.words),
      /* The byline. "Created by <name>" on the play screen, and nothing at all
         when the author has since deleted their account -- the chain stays, the
         name does not. */
      author: row.display_name || row.handle || null,
    },
  });
}

function safeWords(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
