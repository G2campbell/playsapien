import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, pruneOldDays, dayPartOf, KEYS } from '../src/storage.js';
import { FakeStorage, HostileStorage } from './helpers/fake.js';

const TODAY = '2025-06-01';
const ago = (n) => {
  const d = new Date(Date.UTC(2025, 5, 1) - n * 86400000);
  return d.toISOString().slice(0, 10);
};

test('dayPartOf matches only keys that genuinely end in a date', () => {
  assert.equal(dayPartOf('sojourner:2025-01-01'), '2025-01-01');
  assert.equal(dayPartOf('wordchain:daily:2025-01-01'), '2025-01-01');
  assert.equal(dayPartOf('ps:result:sojourner:2025-01-01:daily'), '2025-01-01');

  for (const k of [
    'sojourner:settings', 'sojourner:seen', 'wordchain:set', 'wordchain:history',
    'wordchain:last', 'wordchain:game:daily', 'wordchain:friends', 'wordchain:puzzles',
    'wordchain:practiceAt', 'ps:device', 'ps:queue', 'sojourner:2025-01-01:extra',
    'notsojourner:2025-01-01'
  ]) {
    assert.equal(dayPartOf(k), null, k + ' must never be prunable');
  }
});

test('pruning drops day keys older than 90 days and nothing else', () => {
  const ls = new FakeStorage({
    'sojourner:settings': '{"units":"km"}',
    'sojourner:seen': '{"Kyoto":1}',
    'wordchain:set': '{"theme":"dark"}',
    'wordchain:history': '[1,2,3]',
    'wordchain:game:daily': '{"row":2}',
    [`sojourner:${ago(200)}`]: '{"total":1}',
    [`sojourner:${ago(91)}`]: '{"total":2}',
    [`sojourner:${ago(90)}`]: '{"total":3}',
    [`sojourner:${ago(1)}`]: '{"total":4}',
    [`wordchain:daily:${ago(365)}`]: '{"s":1}',
    [`wordchain:daily:${ago(2)}`]: '{"s":2}',
    'sojourner:2025-02-30': '{"impossible":true}',
    'ps:device': 'abc'
  });
  const store = makeStore(ls);
  const dropped = pruneOldDays(store, { days: 90, today: TODAY });

  assert.deepEqual(dropped.sort(), [`sojourner:${ago(200)}`, `sojourner:${ago(91)}`, `wordchain:daily:${ago(365)}`].sort());

  // the settings keys are the whole point of the careful regex
  assert.equal(ls.getItem('sojourner:settings'), '{"units":"km"}');
  assert.equal(ls.getItem('sojourner:seen'), '{"Kyoto":1}');
  assert.equal(ls.getItem('wordchain:set'), '{"theme":"dark"}');
  assert.equal(ls.getItem('wordchain:history'), '[1,2,3]');
  assert.equal(ls.getItem('wordchain:game:daily'), '{"row":2}');
  assert.equal(ls.getItem('ps:device'), 'abc');
  // exactly 90 days old is kept — the boundary is "older than", not "at least"
  assert.notEqual(ls.getItem(`sojourner:${ago(90)}`), null);
  assert.notEqual(ls.getItem(`sojourner:${ago(1)}`), null);
  // a key shaped like a date but not one is left alone rather than guessed at
  assert.notEqual(ls.getItem('sojourner:2025-02-30'), null);
});

test('pruning runs once a day, then no-ops', () => {
  const ls = new FakeStorage({ [`sojourner:${ago(400)}`]: '{}' });
  const store = makeStore(ls);
  assert.equal(pruneOldDays(store, { days: 90, today: TODAY }).length, 1);
  assert.equal(store.get(KEYS.pruned), TODAY);

  ls.setItem(`sojourner:${ago(401)}`, '{}');
  assert.equal(pruneOldDays(store, { days: 90, today: TODAY }).length, 0);   // marker holds
  assert.equal(pruneOldDays(store, { days: 90, today: '2025-06-02' }).length, 1);  // next day
});

test('a storage that throws on every access degrades to a no-op', () => {
  const store = makeStore(new HostileStorage());
  assert.equal(store.available(), true);        // it exists, it just does not work
  assert.equal(store.get('x'), null);
  assert.equal(store.set('x', 'y'), false);
  assert.equal(store.del('x'), false);
  assert.deepEqual(store.keys(), []);
  assert.equal(store.getJSON('x', 'fallback'), 'fallback');
  assert.equal(store.setJSON('x', { a: 1 }), false);
  assert.deepEqual(pruneOldDays(store, { days: 90, today: TODAY, force: true }), []);
});

test('no storage at all is also fine', () => {
  const store = makeStore(undefined);            // no localStorage in plain node
  assert.equal(store.available(), false);
  assert.equal(store.get('x'), null);
  assert.deepEqual(store.keys(), []);
});

test('getJSON survives a corrupted value', () => {
  const store = makeStore(new FakeStorage({ k: '{not json' }));
  assert.deepEqual(store.getJSON('k', { safe: true }), { safe: true });
});
