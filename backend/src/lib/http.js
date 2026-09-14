/* The response envelope and the CORS rules.

   Split out of index.js purely so that route modules can import the helpers
   without importing the router that imports them -- a cycle that works in ESM
   but only because of hoisting, which is not a thing to rely on. index.js still
   owns the router and the top-level catch; this file owns the shape.

   Every response is one of exactly two shapes:

     { ok: true,  data: ... }
     { ok: false, error: { code, message } }

   `code` is a stable machine string the client can switch on; `message` is for
   a human and may be reworded at any time. Nothing else ever appears at the top
   level, including on a 500 -- see errorResponse. */

export function json(data, { status = 200, headers = {}, cookies = [] } = {}) {
  const h = new Headers(headers);
  h.set('content-type', 'application/json; charset=utf-8');
  /* API responses are per-session by definition. Getting this wrong once, on a
     path Cloudflare decides to cache, serves one player's profile to another. */
  h.set('cache-control', 'no-store');
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function ok(data, init) {
  return json({ ok: true, data: data === undefined ? null : data }, init);
}

export function err(code, message, status = 400, init = {}) {
  return json({ ok: false, error: { code, message } }, { ...init, status });
}

/* The errors used in more than one place, so that a client switching on `code`
   sees the same string from every route that can produce the condition. */
export const ERRORS = {
  unauthorised: () => err('unauthorised', 'Sign in to do that.', 401),
  forbidden: (m = 'You cannot do that.') => err('forbidden', m, 403),
  notFound: (m = 'Not found.') => err('not_found', m, 404),
  invalid: (m = 'That request did not make sense.') => err('invalid', m, 400),
  conflict: (code, m, data) => json({ ok: false, error: { code, message: m }, data }, { status: 409 }),
  rateLimited: (retryAfter, m) => err('rate_limited', m, 429, {
    headers: { 'retry-after': String(retryAfter) },
  }),
};

/* A 409 that carries the row that won. The duplicate-result case needs it:
   "first write wins" is only a usable rule if the loser is told what won, so
   the client can reconcile its localStorage without a second request. It is the
   one place `data` and `error` appear together, and it is deliberate. */
export function conflict(code, message, data) {
  return ERRORS.conflict(code, message, data);
}

/* ---------------------------------------------------------------- bodies */

/* 64 KB is a generous ceiling for any body this API takes -- the largest is a
   result with its detail blob, capped at 16 KB by validate.js -- and it means a
   malformed or hostile request cannot make the Worker buffer megabytes before
   the validator gets a look at it. */
const MAX_BODY_BYTES = 65536;

export async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return { tooLarge: true };
  let text;
  try { text = await request.text(); } catch { return { bad: true }; }
  if (text.length > MAX_BODY_BYTES) return { tooLarge: true };
  if (!text) return { value: {} };
  try { return { value: JSON.parse(text) }; } catch { return { bad: true }; }
}

/* ---------------------------------------------------------------- CORS */

/* The path-based layout (playsapien.com/sojourner/, /wordchain/) means the
   games and the API are the same origin and the browser sends no Origin header
   worth answering. CORS here exists only for local development, where the shell
   runs on a Pages dev server and the Worker on wrangler's port.

   No wildcard, ever: Access-Control-Allow-Origin: * cannot be combined with
   credentials, and every endpoint here is credentialed. */
export function allowedOrigins(env) {
  const list = [];
  if (env.APP_ORIGIN) list.push(env.APP_ORIGIN.replace(/\/$/, ''));
  for (const o of String(env.ALLOWED_ORIGINS || '').split(',')) {
    const t = o.trim().replace(/\/$/, '');
    if (t) list.push(t);
  }
  return list;
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const h = new Headers();
  /* Vary is set whether or not the origin matched: without it a cache could
     serve the allowed-origin response to a request from a different one. */
  h.set('vary', 'Origin');
  if (!origin) return h;
  if (!allowedOrigins(env).includes(origin.replace(/\/$/, ''))) return h;
  h.set('access-control-allow-origin', origin);
  h.set('access-control-allow-credentials', 'true');
  return h;
}

export function preflight(request, env) {
  const h = corsHeaders(request, env);
  if (!h.has('access-control-allow-origin')) return new Response(null, { status: 403, headers: h });
  h.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  h.set('access-control-max-age', '86400');
  return new Response(null, { status: 204, headers: h });
}

export function withCors(response, request, env) {
  /* The headers are set on the response in place rather than the response being
     rebuilt. Rebuilding means round-tripping the header list through a new
     Headers object, and Set-Cookie is the one header that does not survive that
     reliably across runtimes -- a sign-in response carries two of them. */
  for (const [k, v] of corsHeaders(request, env)) response.headers.set(k, v);
  return response;
}
