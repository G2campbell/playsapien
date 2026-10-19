/* Display names are one per player (case-insensitive). A name typed by the
   player is simply refused if taken (routes/player.js). A name filled in
   automatically -- from a Google account at sign-up -- cannot be refused, so
   a taken one gets a short random tag instead: "John Smith 39K".

   Random rather than counted on purpose. "John Smith 2" tells everyone there
   was a John Smith first; "39K" says nothing about order. Two digits and a
   letter give 2,400 tags per name (I and O are left out, they read as 1 and
   0); a tag already in use is simply drawn again, and a name that has somehow
   used up its draws gets a longer tag. */

import { randomBytes } from './crypto.js';
import { first } from './db.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // 24: no I, no O
const MAX = 40;                                // cleanDisplayName's cap

function tag(digits) {
  const b = randomBytes(digits + 1);
  let out = '';
  for (let i = 0; i < digits; i++) out += String(b[i] % 10);
  return out + LETTERS[b[digits] % LETTERS.length];
}

export async function nameTaken(db, name, excludeId) {
  if (!name) return false;
  const row = await first(db,
    'SELECT 1 AS x FROM users WHERE display_name = ? COLLATE NOCASE AND id <> ? AND deleted_at IS NULL',
    name, excludeId || '');
  return !!row;
}

/* `name` if no one else has it; otherwise `name` plus a random tag that no one
   else has. Empty stays empty. */
export async function uniqueDisplayName(db, name, excludeId) {
  if (!name || !(await nameTaken(db, name, excludeId))) return name;
  for (let attempt = 0; attempt < 24; attempt++) {
    const t = tag(attempt < 16 ? 2 : 3);
    const candidate = name.slice(0, MAX - t.length - 1).trim() + ' ' + t;
    if (!(await nameTaken(db, candidate, excludeId))) return candidate;
  }
  return name.slice(0, MAX - 7).trim() + ' ' + tag(5);
}
