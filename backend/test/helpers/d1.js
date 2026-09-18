/* A D1 interface over better-sqlite3.

   D1 is SQLite with a promise-shaped API bolted on. That is the whole of the
   difference this shim papers over: prepare/bind/first/all/run/batch, async,
   returning D1's result envelopes. Everything underneath is the same engine
   running the same SQL, including the partial indexes and the CHECK constraint
   the schema leans on.

   This is what lets every route handler be tested without wrangler, without a
   container and without a network -- `node --test` and nothing else. The
   handlers never learn which one they are talking to, because they only ever
   use the five methods below.

   What it does NOT reproduce, and what the tests therefore cannot claim to
   cover: D1's per-query latency, its 1 MB response cap, and the fact that a
   batch on a real D1 crosses a network boundary between statements. None of
   those change a result, only a duration. */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

/* better-sqlite3 refuses a bound value that is not a number, string, bigint,
   Buffer or null. D1 accepts booleans and undefined and coerces them, so the
   shim has to do the same or a handler that works in production fails in a
   test for a reason that is entirely the test harness's fault. */
function coerce(v) {
  if (v === undefined || v === null) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v === 'number' && !Number.isInteger(v)) return v;
  return v;
}

class Stmt {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Stmt(this.db, this.sql, params.map(coerce));
  }

  prepared() {
    return this.db.prepare(this.sql);
  }

  async first(column) {
    const s = this.prepared();
    /* A statement with a RETURNING clause is a reader even though it writes,
       which is exactly the case the rate limiter depends on. */
    if (!s.reader) {
      s.run(...this.params);
      return null;
    }
    const row = s.get(...this.params);
    if (row === undefined) return null;
    return column === undefined ? row : row[column];
  }

  async all() {
    const s = this.prepared();
    if (!s.reader) {
      const info = s.run(...this.params);
      return { success: true, results: [], meta: metaOf(info) };
    }
    const results = s.all(...this.params);
    return { success: true, results, meta: { changes: 0, last_row_id: 0, rows_read: results.length } };
  }

  async run() {
    const s = this.prepared();
    if (s.reader) {
      /* D1's run() on a returning statement discards the rows but still
         reports the write. better-sqlite3 will not let .run() touch a reader,
         so the rows are drained and thrown away here. */
      const rows = s.all(...this.params);
      return { success: true, results: [], meta: { changes: rows.length, last_row_id: 0 } };
    }
    return { success: true, results: [], meta: metaOf(s.run(...this.params)) };
  }

  async raw() {
    const s = this.prepared();
    return s.raw().all(...this.params);
  }
}

function metaOf(info) {
  return {
    changes: info.changes,
    last_row_id: Number(info.lastInsertRowid || 0),
    duration: 0,
  };
}

class D1Shim {
  constructor(db) {
    this.sqlite = db;
  }

  prepare(sql) {
    return new Stmt(this.sqlite, sql, []);
  }

  /* D1 runs a batch as one implicit transaction, in order, rolling the whole
     thing back if any statement fails. better-sqlite3's transaction() has the
     same semantics, which is the property the claim/merge relies on. */
  async batch(statements) {
    const run = this.sqlite.transaction((list) => {
      const out = [];
      for (const st of list) {
        const s = st.prepared();
        if (s.reader) {
          const results = s.all(...st.params);
          out.push({ success: true, results, meta: { changes: results.length, last_row_id: 0 } });
        } else {
          out.push({ success: true, results: [], meta: metaOf(s.run(...st.params)) });
        }
      }
      return out;
    });
    return run(statements);
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  /* Test-only escape hatches. Nothing in src/ may use these -- they exist so a
     test can assert on a row directly without going through a route. */
  get raw() {
    return this.sqlite;
  }

  one(sql, ...params) {
    return this.sqlite.prepare(sql).get(...params.map(coerce));
  }

  many(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params.map(coerce));
  }
}

export function makeDb(migrationPaths) {
  const db = new Database(':memory:');
  /* D1 enforces foreign keys; plain SQLite does not unless asked. Without this
     the cascade behaviour in the delete-account path would silently pass a test
     it should fail. */
  db.pragma('foreign_keys = ON');
  /* EVERY migration, in order -- not just the initial schema. This took one
     argument and one file until 0002 added columns, at which point the tests
     were running against a schema the code no longer targets, and failing on
     "no such column" rather than on anything real. A test database that is not
     the deployed database is not a test. */
  const list = Array.isArray(migrationPaths) ? migrationPaths : [migrationPaths];
  for (const f of list) db.exec(readFileSync(f, 'utf8'));
  return new D1Shim(db);
}
