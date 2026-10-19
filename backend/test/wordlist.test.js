/* The Worker's copy of the dictionary must match Word Chain's dict.txt. If this
   fails, run: node scripts/make-wordlist.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wordsFromDict, DICT_PATH } from '../scripts/make-wordlist.mjs';
import WORDLIST from '../src/lib/wordlist.js';
import { isWord } from '../src/lib/dictionary.js';

test('the Worker dictionary matches dict.txt', () => {
  assert.equal(WORDLIST, wordsFromDict(readFileSync(DICT_PATH, 'utf8')).join('\n'));
});

test('isWord knows a word, ignores case, and refuses a typo', () => {
  assert.equal(isWord('fire'), true);
  assert.equal(isWord('GO'), true);
  assert.equal(isWord('BORAD'), false);
});
