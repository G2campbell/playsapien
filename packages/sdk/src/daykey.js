/* One definition of "what day is it", shared by both games and the server.

   Audit S1 found Sojourner deriving the day from UTC and Word Chain from local
   time, so a player in UTC+10 saw two different "todays" for ten hours a day.
   BACKEND-SPEC.md §5 settles it: days are UTC everywhere. This file is the
   settlement. Nothing else in the SDK is allowed to call Date#getFullYear. */

const DAY_MS = 86400000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' for the given instant, in UTC. Defaults to now. */
export function dayKey(when) {
  const d = when == null ? new Date() : (when instanceof Date ? when : new Date(when));
  if (Number.isNaN(d.getTime())) return dayKey(new Date());
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/** Milliseconds for midnight UTC of a 'YYYY-MM-DD' key, or null if it is not one.
    Rejects impossible dates (2025-02-31) by round-tripping, so the pruner can
    never mistake a non-date key for an expired one. */
export function dayMs(key) {
  if (typeof key !== 'string') return null;
  const m = DAY_RE.exec(key);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  return dayKey(ms) === key ? ms : null;
}

/** Whole days from `key` to `ref` (both UTC day keys or instants). null if unparseable. */
export function daysSince(key, ref) {
  const a = dayMs(key);
  if (a == null) return null;
  const b = dayMs(typeof ref === 'string' ? ref : dayKey(ref));
  if (b == null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** The day before `key`, as a key. Used for the server's midnight grace window. */
export function prevDay(key) {
  const ms = dayMs(key);
  return ms == null ? null : dayKey(ms - DAY_MS);
}

export { DAY_MS };
