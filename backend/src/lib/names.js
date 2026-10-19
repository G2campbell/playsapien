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
import { first, run } from './db.js';

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

/* ---------- the first-sign-in name ----------

   A new player is asked to choose a display name (ui.js, the name card). The
   card opens with a proposal already filled in so that most people only have
   to press Save: for an email sign-up, the part of the address before the "@"
   with a random tag ("kai 39K"); for a Google sign-up, the name Google gave
   (tagged only if taken). Until they save, the proposal is what others see,
   so nobody ever shows up as a blank "Player". */
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0].split('+')[0];
  return local.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 24);
}

export async function suggestName(db, email, excludeId) {
  const base = nameFromEmail(email) || 'Player';
  for (let attempt = 0; attempt < 24; attempt++) {
    const candidate = base + ' ' + tag(attempt < 16 ? 2 : 3);
    if (!(await nameTaken(db, candidate, excludeId))) return candidate;
  }
  return base + ' ' + tag(5);
}

/* Read the player's name state, filling in a proposal if they have no name at
   all (an account made before names were proposed). Returns what /auth/session
   and /player/me add to the user: { display_name, name_needed }. */
export async function settleName(db, user) {
  const row = await first(db, 'SELECT display_name, name_chosen_at FROM users WHERE id = ?', user.id);
  if (!row) return {};
  if (row.name_chosen_at != null) return { display_name: row.display_name || '', name_needed: false };
  let name = row.display_name || '';
  if (!name) {
    name = await suggestName(db, user.email, user.id);
    await run(db,
      "UPDATE users SET display_name = ? WHERE id = ? AND (display_name IS NULL OR display_name = '')",
      name, user.id);
  }
  return { display_name: name, name_needed: true };
}
