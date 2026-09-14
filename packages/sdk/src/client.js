/* PlaySapien client SDK.

   The contract, in one paragraph: the games work today with no server and must
   keep working, so nothing here throws into game code and nothing here blocks a
   render. localStorage is the fast copy and is written first, synchronously;
   the server is the durable copy and is written next, best-effort. A write that
   does not reach the server is queued and retried on the next load rather than
   lost. Reads fall back to the last good response, then to whatever the device
   knows, then to an empty-but-correctly-shaped value. A player who is not
   signed in cannot tell whether the backend exists. */

import { dayKey, prevDay } from './daykey.js';
import { makeStore, pruneOldDays, KEYS } from './storage.js';
import { request, isPermanent, OFFLINE, DISABLED } from './http.js';

const QUEUE_MAX = 100;
const QUEUE_MAX_TRIES = 25;

function uuid4() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch (e) {}
  try {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  } catch (e) {}
  // Last resort: no WebCrypto at all. Still a valid v4 shape, just not a strong one.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function createClient() {
  let cfg = {
    baseUrl: '/api',
    enabled: true,
    timeoutMs: 6000,
    pruneDays: 90,
    autoFlush: true,
    storage: null,
    fetch: null
  };
  let store = makeStore(null);
  let started = false;

  /* ---------------------------------------------------------------- device */

  function deviceId() {
    let id = store.get(KEYS.device);
    if (id && /^[0-9a-f-]{36}$/i.test(id)) return id;
    id = uuid4();
    store.set(KEYS.device, id);
    return id;
  }

  /* ----------------------------------------------------------------- cache */

  const cacheGet = (name, fallback = null) => store.getJSON(KEYS.cache + name, fallback);
  const cacheSet = (name, value) => store.setJSON(KEYS.cache + name, value);
  const cacheDrop = (name) => store.remove(KEYS.cache + name);

  /* ------------------------------------------------------------- transport */

  function call(method, path, body) {
    return request(cfg, method, path, body, { deviceId: deviceId() });
  }

  /* A read that must always produce something: try the network, fall back to the
     last good response, fall back to a correctly-shaped empty value. */
  async function read(name, path, empty, shape = (d) => d) {
    const r = await call('GET', path);
    if (r.ok) {
      const data = shape(r.data) ?? empty;
      cacheSet(name, data);
      return { ok: true, source: 'network', ...data };
    }
    const cached = cacheGet(name);
    if (cached) return { ok: false, source: 'cache', error: r.error, ...cached };
    return { ok: false, source: 'offline', error: r.error, ...empty };
  }

  /* ----------------------------------------------------------- write queue */

  const queue = () => {
    const q = store.getJSON(KEYS.queue, []);
    return Array.isArray(q) ? q : [];
  };
  const setQueue = (q) => store.setJSON(KEYS.queue, q.slice(-QUEUE_MAX));

  function enqueue(method, path, body) {
    const q = queue();
    // One entry per (method, path): a resubmitted day replaces its predecessor
    // rather than queueing twice. The server rejects the second anyway.
    const at = q.findIndex((e) => e.method === method && e.path === path);
    const entry = { id: uuid4(), method, path, body, at: Date.now(), tries: 0 };
    if (at >= 0) q[at] = entry; else q.push(entry);
    setQueue(q);
    return entry;
  }

  /** Retry everything queued. Stops at the first genuine offline failure. */
  async function flush() {
    let q = queue();
    if (!q.length || !cfg.enabled) return { sent: 0, dropped: 0, left: q.length };
    let sent = 0, dropped = 0;
    while (q.length) {
      const e = q[0];
      const r = await call(e.method, e.path, e.body);
      if (r.ok) { q.shift(); sent++; setQueue(q); continue; }
      if (isPermanent(r.status) || (e.tries || 0) + 1 >= QUEUE_MAX_TRIES) {
        // A 409 is first-write-wins: the server already has this day. A 400 is
        // never going to become a 200. Either way, stop carrying it forever.
        q.shift(); dropped++; setQueue(q); continue;
      }
      e.tries = (e.tries || 0) + 1;
      setQueue(q);
      break;                                   // still offline; try again next load
    }
    return { sent, dropped, left: q.length };
  }

  /* ------------------------------------------------------------------ init */

  function init(opts = {}) {
    cfg = {
      ...cfg,
      ...opts,
      baseUrl: opts.baseUrl ?? cfg.baseUrl,
      enabled: opts.enabled !== false && opts.enabled !== 'false'
    };
    store = makeStore(cfg.storage);
    deviceId();                                              // mint on first use
    try { pruneOldDays(store, { days: cfg.pruneDays }); } catch (e) {}
    started = true;
    if (cfg.enabled && cfg.autoFlush !== false) {
      // Deliberately not awaited: init must never delay a first paint.
      Promise.resolve().then(flush).catch(() => {});
    }
    return api;
  }

  /* ------------------------------------------------------------------ auth */

  async function session() {
    const r = await call('GET', '/auth/session');
    if (r.ok) {
      const user = r.data?.user ?? null;
      cacheSet('session', { user });
      return { ok: true, source: 'network', user };
    }
    const cached = cacheGet('session');
    // Offline we report the last known user so the UI does not flicker to
    // signed-out, but never invent one we have not seen.
    return { ok: false, source: cached ? 'cache' : 'offline', error: r.error, user: cached?.user ?? null };
  }

  async function signInEmail(email) {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      return { ok: false, sent: false, error: 'bad_email' };
    }
    const r = await call('POST', '/auth/email/start', { email: addr });
    // The server answers { sent:true } whether or not the address is known
    // (spec §5, email enumeration); we pass that through unchanged.
    return { ok: r.ok, sent: !!r.ok, error: r.ok ? null : r.error };
  }

  async function verifyEmail(email, code) {
    const addr = String(email || '').trim().toLowerCase();
    const digits = String(code || '').replace(/\D/g, '');
    if (digits.length !== 6) return { ok: false, user: null, error: 'bad_code' };
    const r = await call('POST', '/auth/email/verify', { email: addr, code: digits });
    if (!r.ok) return { ok: false, user: null, error: r.error };
    const user = r.data?.user ?? null;
    cacheSet('session', { user });
    if (user) { claim().catch(() => {}); }   // bind this device's history, best effort
    return { ok: true, user, error: null };
  }

  async function signOut() {
    // Local state is cleared whether or not the server hears about it: a player
    // who taps Sign out on a plane must not still look signed in.
    cacheSet('session', { user: null });
    store.del(KEYS.cache + 'me');
    store.del(KEYS.cache + 'friends');
    store.del(KEYS.cache + 'notices');
    const r = await call('POST', '/auth/logout');
    return { ok: r.ok, error: r.ok ? null : r.error };
  }

  async function claim(extraDeviceIds = []) {
    const ids = [deviceId(), ...extraDeviceIds].filter(Boolean);
    const r = await call('POST', '/player/claim', { device_ids: ids });
    if (!r.ok) { enqueue('POST', '/player/claim', { device_ids: ids }); }
    return { ok: r.ok, claimed: r.ok ? (r.data?.claimed ?? ids.length) : 0, error: r.ok ? null : r.error };
  }

  /* --------------------------------------------------------------- profile */

  function me() {
    return read('me', '/player/me', { user: null, streaks: [] }, (d) => ({
      user: d?.user ?? null,
      /* The backend returns one row per game plus '*' for the platform streak,
         always an array, always complete. Anything else is a broken response
         and an empty array is the safe read for a caller doing .find(). */
      streaks: Array.isArray(d?.streaks) ? d.streaks : []
    }));
  }

  async function updateMe(patch) {
    const r = await call('PATCH', '/player/me', patch || {});
    if (r.ok) cacheSet('me', { user: r.data?.user ?? null, streaks: r.data?.streaks ?? [] });
    // Not queued: a name change the player cannot see take effect is worse
    // than one they are told to retry.
    return { ok: r.ok, user: r.ok ? (r.data?.user ?? null) : null, error: r.ok ? null : r.error };
  }

  function notices() {
    return read('notices', '/player/notices', { notices: [] }, (d) => ({
      notices: Array.isArray(d?.notices) ? d.notices : (Array.isArray(d) ? d : [])
    }));
  }

  async function readNotices(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const r = await call('POST', '/player/notices/read', { ids: list });
    if (!r.ok && !isPermanent(r.status)) enqueue('POST', '/player/notices/read', { ids: list });
    return { ok: r.ok, error: r.ok ? null : r.error };
  }

  /* --------------------------------------------------------------- friends */

  function friends() {
    return read('friends', '/player/friends', { friends: [], pending: [], code: null }, (d) => ({
      friends: Array.isArray(d?.friends) ? d.friends : [],
      pending: Array.isArray(d?.pending) ? d.pending : [],
      code: d?.code ?? null
    }));
  }

  async function friendCode() {
    const r = await friends();
    return { ok: r.ok, code: r.code, error: r.error ?? null };
  }

  async function rotateFriendCode() {
    const r = await call('POST', '/player/friends/code/rotate', {});
    if (r.ok) cacheDrop('friends');
    return { ok: r.ok, code: r.ok ? (r.data?.code ?? null) : null, error: r.ok ? null : r.error };
  }

  async function addFriend(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return { ok: false, state: null, error: 'bad_code' };
    const r = await call('POST', '/player/friends/add', { code: c });
    // Not queued: an invite code can be revoked, and a retry days later would
    // add a stranger. This one needs the player present to hear the answer.
    return { ok: r.ok, state: r.ok ? (r.data?.state ?? 'pending') : null, error: r.ok ? null : r.error };
  }

  /* ------------------------------------------------------------------ play */

  const resultKey = (game, day, mode) => KEYS.result + game + ':' + day + ':' + (mode || 'daily');

  function localResult(game, day, mode = 'daily') {
    return store.getJSON(resultKey(game, day, mode));
  }

  function localResultsFor(day) {
    const out = [];
    const suffix = ':' + day + ':';
    for (const k of store.keys()) {
      if (!k.startsWith(KEYS.result) || !k.includes(suffix)) continue;
      const v = store.getJSON(k);
      if (v) out.push(v);
    }
    return out;
  }

  /**
   * Record a finished game. The localStorage write happens synchronously before
   * this function's first await, so a tab closed a millisecond later still keeps
   * the score. The network attempt is what may be slow, and may never land.
   */
  function saveResult(r = {}) {
    const rec = {
      game: r.game,
      day: r.day || dayKey(),
      mode: r.mode || 'daily',
      score: Number(r.score) || 0,
      max_score: Number(r.maxScore ?? r.max_score) || 0,
      detail: r.detail ?? null,
      duration_ms: r.durationMs ?? r.duration_ms ?? null,
      device_id: deviceId(),
      at: Date.now()
    };
    if (!rec.game) return Promise.resolve({ ok: false, source: 'local', synced: false, queued: false, error: 'no_game', result: rec });

    store.setJSON(resultKey(rec.game, rec.day, rec.mode), rec);

    return (async () => {
      const res = await call('POST', '/play/result', rec);
      if (res.ok) return { ok: true, source: 'network', synced: true, queued: false, error: null, result: rec };
      if (isPermanent(res.status)) {
        // 409 = the server already has this day (first write wins, spec §5).
        // Nothing to retry, and nothing the player needs to hear about.
        return { ok: false, source: 'local', synced: false, queued: false, error: res.error, result: rec };
      }
      enqueue('POST', '/play/result', rec);
      return { ok: false, source: 'local', synced: false, queued: true, error: res.error, result: rec };
    })();
  }

  async function today(day = dayKey()) {
    const r = await call('GET', '/play/day/' + encodeURIComponent(day));
    if (r.ok) {
      const results = Array.isArray(r.data?.results) ? r.data.results : [];
      cacheSet('day:' + day, { day, results });
      return { ok: true, source: 'network', day, results };
    }
    const cached = cacheGet('day:' + day);
    if (cached) return { ok: false, source: 'cache', error: r.error, ...cached };
    return { ok: false, source: 'local', error: r.error, day, results: localResultsFor(day) };
  }

  async function leaderboard(game, day = dayKey()) {
    const path = '/play/leaderboard/' + encodeURIComponent(game) + '/' + encodeURIComponent(day);
    const r = await call('GET', path);
    if (r.ok) {
      const entries = Array.isArray(r.data?.entries) ? r.data.entries : (Array.isArray(r.data) ? r.data : []);
      cacheSet('lb:' + game + ':' + day, { game, day, entries });
      return { ok: true, source: 'network', game, day, entries };
    }
    const cached = cacheGet('lb:' + game + ':' + day);
    if (cached) return { ok: false, source: 'cache', error: r.error, ...cached };
    // Offline, the only honest board is the one entry this device played.
    const mine = localResult(game, day);
    return {
      ok: false, source: 'local', error: r.error, game, day,
      entries: mine ? [{ you: true, score: mine.score, max_score: mine.max_score, day, game }] : []
    };
  }

  function standings() {
    return read('standings', '/play/standings', { standings: [] }, (d) => ({
      standings: Array.isArray(d?.standings) ? d.standings : (Array.isArray(d) ? d : [])
    }));
  }

  /* ------------------------------------------------------------------- api */

  const api = {
    init,
    get config() { return { ...cfg }; },
    get enabled() { return cfg.enabled; },
    get started() { return started; },

    dayKey,
    prevDay,
    deviceId,

    session, signInEmail, verifyEmail, signOut, claim,
    me, notices, readNotices,
    friends, addFriend, friendCode, rotateFriendCode,
    updateMe,
    saveResult, today, leaderboard, standings,

    // escape hatches, mostly for the games' own offline paths and for tests
    localResult, localResultsFor,
    flush,
    queue,
    queueLength: () => queue().length,
    prune: (opts) => pruneOldDays(store, { days: cfg.pruneDays, force: true, ...opts }),
    _store: () => store
  };

  return api;
}
