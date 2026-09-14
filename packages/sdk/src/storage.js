/* Every localStorage access in the platform goes through here.

   Two reasons. First, `localStorage` throws rather than returning null in a
   private window, when site data is blocked, and when the 5 MB quota is full —
   so every access needs try/catch, and a helper is the only way to guarantee
   that. Second, audit S2: two unbounded per-day key series now share one
   quota, so somebody has to prune them, and the pruner needs to enumerate keys
   without being confused by the settings keys that live in the same prefix. */

import { dayKey, daysSince } from './daykey.js';

/** Cross-game platform state. Per-game progress keeps its own prefix (audit S3). */
export const PS_PREFIX = 'ps:';

export const KEYS = {
  device:  'ps:device',
  session: 'ps:session',
  profile: 'ps:profile',
  friends: 'ps:friends',
  notices: 'ps:notices',
  queue:   'ps:queue',
  pruned:  'ps:pruned',
  cache:   'ps:cache:',        // + <name>
  result:  'ps:result:'        // + <game>:<day>:<mode>
};

function resolve(explicit) {
  if (explicit) return explicit;
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}

/** A never-throwing view over a Storage-like object. */
export function makeStore(explicit) {
  const s = () => resolve(explicit);

  const get = (k) => { try { const v = s()?.getItem(k); return v == null ? null : v; } catch (e) { return null; } };
  const set = (k, v) => { try { s()?.setItem(k, v); return true; } catch (e) { return false; } };
  const del = (k) => { try { s()?.removeItem(k); return true; } catch (e) { return false; } };

  const keys = () => {
    try {
      const st = s();
      if (!st) return [];
      if (typeof st.key === 'function' && typeof st.length === 'number') {
        const out = [];
        for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k != null) out.push(k); }
        return out;
      }
      return Object.keys(st);
    } catch (e) { return []; }
  };

  const getJSON = (k, fallback = null) => {
    const raw = get(k);
    if (raw == null) return fallback;
    try { const v = JSON.parse(raw); return v === undefined ? fallback : v; } catch (e) { return fallback; }
  };

  const setJSON = (k, v) => { try { return set(k, JSON.stringify(v)); } catch (e) { return false; } };

  return { get, set, del, keys, getJSON, setJSON, available: () => !!s() };
}

/* ------------------------------------------------------------------ pruning */

/* Only keys that genuinely END in a real date are candidates. `sojourner:settings`,
   `sojourner:seen`, `wordchain:set`, `wordchain:history` and `wordchain:game:daily`
   all fail the regex; `sojourner:2025-02-31` fails the round-trip in dayMs(). */
const PRUNABLE = [
  /^sojourner:(\d{4}-\d{2}-\d{2})$/,
  /^wordchain:daily:(\d{4}-\d{2}-\d{2})$/,
  /^ps:result:[^:]+:(\d{4}-\d{2}-\d{2}):[^:]*$/
];

export function dayPartOf(key) {
  for (const re of PRUNABLE) {
    const m = re.exec(key);
    if (m) return m[1];
  }
  return null;
}

/**
 * Drop per-day keys older than `days` (default 90). Returns the keys removed.
 * Runs at most once a day — the marker costs one key and saves a full keyspace
 * scan on every page load.
 */
export function pruneOldDays(store, { days = 90, today = dayKey(), force = false } = {}) {
  if (!force && store.get(KEYS.pruned) === today) return [];
  store.set(KEYS.pruned, today);
  const dropped = [];
  for (const k of store.keys()) {
    const part = dayPartOf(k);
    if (part == null) continue;
    const age = daysSince(part, today);
    if (age == null || age <= days) continue;
    if (store.del(k)) dropped.push(k);
  }
  return dropped;
}
