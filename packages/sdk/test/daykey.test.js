import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, dayMs, daysSince, prevDay } from '../src/daykey.js';

test('dayKey is UTC, not local', () => {
  // 22:30 UTC on the 9th. In UTC+10 the local date is already the 10th; the
  // audit (S1) says both games must call this the 9th.
  assert.equal(dayKey(Date.UTC(2025, 2, 9, 22, 30)), '2025-03-09');
  // one minute past midnight UTC is the next day for everybody, everywhere
  assert.equal(dayKey(Date.UTC(2025, 2, 10, 0, 1)), '2025-03-10');
  // and the last millisecond of the day is still that day
  assert.equal(dayKey(Date.UTC(2025, 2, 9, 23, 59, 59, 999)), '2025-03-09');
});

test('dayKey pads and handles year/month rollover', () => {
  assert.equal(dayKey(Date.UTC(2025, 0, 1)), '2025-01-01');
  assert.equal(dayKey(Date.UTC(2024, 11, 31, 23, 59)), '2024-12-31');
  assert.equal(dayKey(Date.UTC(2024, 1, 29)), '2024-02-29');   // leap day
});

test('dayKey accepts Date, number and nothing at all', () => {
  assert.equal(dayKey(new Date(Date.UTC(2025, 5, 4))), '2025-06-04');
  assert.equal(dayKey(Date.UTC(2025, 5, 4)), '2025-06-04');
  assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(dayKey(new Date('nonsense')), /^\d{4}-\d{2}-\d{2}$/);   // never NaN-NaN-NaN
});

test('dayMs rejects anything that is not a real date', () => {
  assert.equal(dayMs('2025-03-09'), Date.UTC(2025, 2, 9));
  assert.equal(dayMs('2025-02-30'), null);      // round-trips to 03-02, so not a date
  assert.equal(dayMs('2025-13-01'), null);
  assert.equal(dayMs('settings'), null);
  assert.equal(dayMs('2025-3-9'), null);        // unpadded is not our format
  assert.equal(dayMs(''), null);
  assert.equal(dayMs(null), null);
});

test('daysSince counts whole UTC days across a DST change', () => {
  // US DST begins 2025-03-09. Days are UTC, so this is exactly 2, not 1.96.
  assert.equal(daysSince('2025-03-08', '2025-03-10'), 2);
  assert.equal(daysSince('2025-01-01', '2025-04-01'), 90);
  assert.equal(daysSince('2025-01-01', '2025-01-01'), 0);
  assert.equal(daysSince('nope', '2025-01-01'), null);
});

test('prevDay steps back over a month boundary', () => {
  assert.equal(prevDay('2025-03-01'), '2025-02-28');
  assert.equal(prevDay('2024-03-01'), '2024-02-29');
  assert.equal(prevDay('2025-01-01'), '2024-12-31');
  assert.equal(prevDay('rubbish'), null);
});
