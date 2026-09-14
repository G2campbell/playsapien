/* A localStorage that behaves like the real one (string values, `key(i)`,
   `length`) and a fetch that behaves like the real one without a network. */

export class FakeStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  keys() { return [...this.map.keys()]; }
}

/** Every access throws — a private window, or site data blocked. */
export class HostileStorage {
  get length() { throw new Error('SecurityError'); }
  key() { throw new Error('SecurityError'); }
  getItem() { throw new Error('SecurityError'); }
  setItem() { throw new Error('QuotaExceededError'); }
  removeItem() { throw new Error('SecurityError'); }
}

/* The real backend wraps everything: { ok:true, data } / { ok:false, error }.
   The mock must wrap too, or the tests quietly encode a contract the server
   does not honour -- which is exactly how the envelope bug got this far.
   A body that already looks enveloped, or is not a plain object, is passed
   through so a test can still assert on a malformed response. */
function envelope(status, body) {
  if (body === undefined || body === null) return body;
  if (typeof body !== 'object') return body;
  if (typeof body.ok === 'boolean') return body;
  return status >= 200 && status < 300
    ? { ok: true, data: body }
    : { ok: false, error: { code: body.error || 'error', message: '' } };
}

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => envelope(status, body)
  };
}

/**
 * mockFetch(handler) — handler(path, opts) may return:
 *   a number            -> that status, empty body
 *   [status, body]      -> that status and body
 *   an object           -> 200 with that body
 *   the string 'offline'-> a rejected promise, as a dead network does
 * The returned function records every call on `.calls`.
 */
export function mockFetch(handler) {
  const f = async (url, opts = {}) => {
    f.calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers });
    const out = typeof handler === 'function' ? handler(url, opts) : handler;
    if (out === 'offline') throw new TypeError('Failed to fetch');
    if (typeof out === 'number') return res(out, null);
    if (Array.isArray(out)) return res(out[0], out[1]);
    return res(200, out);
  };
  f.calls = [];
  return f;
}

export const offlineFetch = () => mockFetch(() => 'offline');
