/* The one free Sapien trial each email address gets.

   Two days, no payment details, once per inbox -- for ever, including after
   the account is deleted (migrations/0004). What is stored is a keyed hash of
   the normalised address, so the table can answer "has this inbox had a
   trial?" and nothing more.

   LOGIN_CODE_PEPPER is the key. Rotating that secret would make every past
   trial unrecognisable, so if it is ever rotated, keep the old value for this
   purpose (TRIAL_KEY_SECRET, below, takes precedence when set). */

import { hmacSign } from './crypto.js';
import { first } from './db.js';

export const TRIAL_SECONDS = 2 * 86400;

/* One inbox, however it is written. Lower case, no "+tag", and for Gmail no
   dots and googlemail.com folded into gmail.com -- the cheap ways of making a
   "new" address that still lands in the same inbox. */
export function normaliseTrialEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at), domain = e.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

export async function trialKey(env, email) {
  const secret = env.TRIAL_KEY_SECRET || env.LOGIN_CODE_PEPPER || 'playsapien-trial';
  return hmacSign(secret, 'trial:' + normaliseTrialEmail(email));
}

/* Has this address never had a trial (or a promotion-code grant)? */
export async function trialAvailable(db, env, email) {
  if (!email) return false;
  const key = await trialKey(env, email);
  const row = await first(db, 'SELECT 1 AS x FROM trial_claims WHERE email_key = ?', key);
  return !row;
}
