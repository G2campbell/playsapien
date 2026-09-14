/* The one place a network call is made, and the one place a network failure is
   turned into a value instead of an exception.

   Nothing in this file rejects. A caller gets { ok:false, status, error } for a
   dead backend, an unconfigured one, a timeout, a 500 and a malformed body
   alike, and can treat all five the same way — which is what makes the whole
   SDK safe to call from inside a render. */

export const OFFLINE = 0;          // never reached the server
export const DISABLED = -1;        // SDK switched off, or no fetch in this runtime

function pickFetch(explicit) {
  if (typeof explicit === 'function') return explicit;
  try { return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null; }
  catch (e) { return null; }
}

/** Returns { ok, status, data, error }. Never throws, never rejects. */
export async function request(cfg, method, path, body, extra = {}) {
  if (!cfg.enabled) return { ok: false, status: DISABLED, data: null, error: 'disabled' };
  const fetchImpl = pickFetch(cfg.fetch);
  if (!fetchImpl) return { ok: false, status: DISABLED, data: null, error: 'no-fetch' };

  const url = String(cfg.baseUrl).replace(/\/+$/, '') + path;
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (extra.deviceId) headers['X-PS-Device'] = extra.deviceId;

  let signal, timer;
  try {
    if (cfg.timeoutMs > 0 && typeof AbortController === 'function') {
      const ac = new AbortController();
      signal = ac.signal;
      timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, cfg.timeoutMs);
    }
  } catch (e) { /* no AbortController: the request simply has no timeout */ }

  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      credentials: 'include',
      signal,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const status = typeof res?.status === 'number' ? res.status : 0;
    let data = null;
    try { data = typeof res?.json === 'function' ? await res.json() : null; } catch (e) { data = null; }

    /* The backend wraps every response: { ok:true, data } or
       { ok:false, error:{ code, message } }. Unwrap it here, once, so that
       every caller sees `data` as the payload and `error` as a string code.
       Doing it per-caller is how `r.data.data.user` happens. */
    const enveloped = data && typeof data === 'object' && typeof data.ok === 'boolean';
    const payload = enveloped ? (data.data ?? null) : data;
    const errCode = enveloped && data.error
      ? (typeof data.error === 'string' ? data.error : data.error.code || 'error')
      : null;

    if (!res || res.ok === false || status >= 400 || (enveloped && data.ok === false)) {
      return { ok: false, status, data: payload, error: errCode || ('http_' + status) };
    }
    return { ok: true, status, data: payload, error: null };
  } catch (e) {
    const name = e && e.name;
    return {
      ok: false,
      status: OFFLINE,
      data: null,
      error: name === 'AbortError' ? 'timeout' : 'offline'
    };
  } finally {
    if (timer) { try { clearTimeout(timer); } catch (e) {} }
  }
}

/** A 4xx that is not 408/429 will never succeed on retry, so the queue drops it. */
export function isPermanent(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
