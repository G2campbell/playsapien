/* Identifiers.

   Ids are prefixed so that a value is self-describing in a log line and a
   mis-wired query fails loudly instead of quietly matching nothing: 'u_...' is
   a user, 's_...' a session, 'r_...' a result. base58 (the Bitcoin alphabet)
   drops 0, O, I and l, which is what makes an id safe to read aloud or copy out
   of a support email. */

import { randomBytes } from './crypto.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/* 22 base58 characters is a shade over 128 bits of entropy, which is the same
   ballpark as a UUIDv4 and needs no collision handling at any volume this will
   ever see. Drawn a character at a time by rejection so the distribution is
   flat -- 58 does not divide 256. */
export function randomBase58(n) {
  let out = '';
  while (out.length < n) {
    const buf = randomBytes(n * 2);
    for (const b of buf) {
      if (b >= 232) continue;            // 232 = 4 * 58, the largest usable multiple
      out += BASE58[b % 58];
      if (out.length === n) break;
    }
  }
  return out;
}

export function newId(prefix, len = 22) {
  return prefix + '_' + randomBase58(len);
}

/* Invite codes are read off a screen and typed by a human, sometimes over the
   phone. The alphabet keeps exactly one character out of every set that looks
   alike in a sans-serif face -- 0/O/Q, 1/I/L/J, 5/S, 8/B, 2/Z, U/V/W -- which
   costs a little entropy and buys back every "but I typed it right" support
   message. 8 characters of a 22-symbol alphabet is ~35 bits: far too sparse to
   enumerate, and a code is revocable besides. */
const INVITE_ALPHABET = '34679ACDEFGHJKMNPRTWXY';

export function newInviteCode() {
  let out = '';
  while (out.length < 8) {
    for (const b of randomBytes(16)) {
      if (b >= 242) continue;            // 242 = 11 * 22, the largest usable multiple
      out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
      if (out.length === 8) break;
    }
  }
  return out;
}

/* Accepts what a human typed, not what we printed: case is folded up,
   punctuation and spaces are dropped, and each character the alphabet
   deliberately avoids is folded onto the one it looks like. 'l0ve zap8' finds
   the code we issued; a genuinely wrong code still misses. */
const LOOKALIKE = {
  O: '0', Q: '0', I: 'J', L: 'J', '1': 'J', S: '6', '5': '6',
  B: 'H', '8': 'H', Z: 'A', '2': 'A', U: 'W', V: 'W'
};

export function normaliseInviteCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  let out = '';
  for (const ch of raw) out += LOOKALIKE[ch] || ch;
  return out;
}
