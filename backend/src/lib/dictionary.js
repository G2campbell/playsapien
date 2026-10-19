/* Is this a word? Word Chain's dictionary, the same list the game uses for
   NOT A WORD. Built into a Set on first use, not at start-up: most requests
   never ask. */
import WORDLIST from './wordlist.js';

let SET = null;
export function isWord(w) {
  if (!SET) SET = new Set(WORDLIST.split('\n'));
  return SET.has(String(w || '').toUpperCase());
}
