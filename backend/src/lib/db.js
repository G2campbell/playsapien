/* Thin helpers over the D1 binding.

   Every statement in this codebase goes through prepare()/bind(), so there is
   no path by which a caller-supplied string reaches SQL. These wrappers exist
   only to keep that shape short enough that nobody is tempted to template a
   query together instead. */

export function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function all(db, sql, ...params) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || [];
}

export function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

/* A prepared, bound statement, ready to go into db.batch(). D1 runs a batch as
   one implicit transaction, in order, and rolls the whole thing back on any
   failure -- which is the only transaction primitive the binding offers, and
   the reason the merge in routes/player.js is shaped the way it is. */
export function stmt(db, sql, ...params) {
  return db.prepare(sql).bind(...params);
}

/* D1 surfaces a constraint violation as a thrown Error whose message carries
   SQLite's text. There is no error code to switch on, so this matches the text,
   which is stable across both D1 and the better-sqlite3 shim the tests use. */
export function isUniqueViolation(err) {
  return /constraint failed/i.test(String(err && err.message)) &&
    /UNIQUE|PRIMARY KEY/i.test(String(err && err.message));
}

export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86400;
export const YEAR = 31536000;
