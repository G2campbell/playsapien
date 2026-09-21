/* PlaySapien API. One Worker, one D1 database, everything under /api.

   Three things happen in this file and nothing else does: requests are routed,
   CORS is applied, and anything that throws is turned into an envelope that
   does not leak what threw. The route handlers are in routes/ and know nothing
   about any of it.

   The shape of a handler is (ctx) -> Response. ctx carries the request, the
   parsed URL, the D1 binding, the clock, the resolved session, the path
   parameters, and `deps` -- the two or three things that reach the network,
   injected rather than imported so that the tests can hand over a stub. There
   is no other mutable global anywhere in the Worker: an isolate is shared
   between requests from different players, and module-level state is how that
   turns into one player seeing another's data. */

import { ok, err, ERRORS, withCors, preflight, json } from './lib/http.js';
import { Invalid } from './lib/validate.js';
import { loadSession } from './middleware/session.js';
import { sweep as sweepRateLimits } from './middleware/ratelimit.js';
import { sendLoginCode, signinLink } from './lib/email.js';
import { DAY } from './lib/db.js';

import * as auth from './routes/auth.js';
import * as player from './routes/player.js';
import * as friends from './routes/friends.js';
import * as play from './routes/play.js';
import * as wordchain from './routes/wordchain.js';
import * as admin from './routes/admin.js';

/* ================================================================== router */

/* A table, not a framework. Patterns are literal segments and :params, matched
   segment by segment -- twenty routes do not need a regex compiler, and a table
   you can read top to bottom is its own documentation of the API surface.

   Order matters only where a literal and a parameter could both match the same
   segment, so literals come first within each group. */
const ROUTES = [
  ['POST',   '/api/auth/email/start',            auth.emailStart],
  ['POST',   '/api/auth/email/verify',           auth.emailVerify],
  ['GET',    '/api/auth/google/start',           auth.googleStart],
  ['GET',    '/api/auth/google/callback',        auth.googleCallback],
  ['POST',   '/api/auth/logout',                 auth.logout],
  ['GET',    '/api/auth/session',                auth.sessionInfo],
  ['GET',    '/api/auth/devices',                auth.listDevices],
  ['DELETE', '/api/auth/devices/:id',            auth.revokeDevice],

  /* Literals before :id -- /friends/code must not be read as a player id. */
  ['GET',    '/api/player/friends',              friends.listFriends],
  ['GET',    '/api/player/friends/code',         friends.myCode],
  ['POST',   '/api/player/friends/code/rotate',  friends.rotateCode],
  ['POST',   '/api/player/friends/add',          friends.addByCode],
  ['POST',   '/api/player/friends/:id/accept',   friends.acceptRequest],
  ['POST',   '/api/player/friends/:id/block',    friends.blockFriend],
  ['DELETE', '/api/player/friends/:id',          friends.removeFriend],

  ['GET',    '/api/player/me',                   player.me],
  ['PATCH',  '/api/player/me',                   player.updateMe],
  ['DELETE', '/api/player/me',                   player.deleteMe],
  ['POST',   '/api/player/claim',                player.claimDevices],
  ['POST',   '/api/player/redeem',               player.redeemCode],
  ['GET',    '/api/player/notices',              player.listNotices],
  ['POST',   '/api/player/notices/read',         player.readNotices],

  ['POST',   '/api/play/result',                 play.submitResult],
  ['GET',    '/api/play/standings',              play.standings],
  ['GET',    '/api/play/day/:day',               play.readDay],
  ['GET',    '/api/play/leaderboard/:game/:day', play.leaderboard],

  ['POST',   '/api/wordchain/chains',            wordchain.submitChain],
  ['GET',    '/api/wordchain/chains/mine',       wordchain.myChains],
  ['GET',    '/api/wordchain/bank/:day',         wordchain.bank],

  /* The legacy alias. partD.js:341 posts to SOJOURNER_API + '/score' already,
     so the existing game works by setting one constant (spec §4). */
  ['POST',   '/api/sojourner/score',             play.sojournerScore],

  ['GET',    '/api/admin/queue',                 admin.queue,     { admin: true }],
  ['POST',   '/api/admin/chains/:id',            admin.decideChain, { admin: true }],
  ['GET',    '/api/admin/incidents',             admin.incidents, { admin: true }],
  ['POST',   '/api/admin/users/:id/block',       admin.blockUser, { admin: true }],
];

function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  let methodMismatch = false;

  for (const [routeMethod, pattern, handler, opts] of ROUTES) {
    const want = pattern.split('/').filter(Boolean);
    if (want.length !== parts.length) continue;

    const params = {};
    let hit = true;
    for (let i = 0; i < want.length; i++) {
      if (want[i][0] === ':') {
        if (!parts[i]) { hit = false; break; }
        params[want[i].slice(1)] = decodeURIComponent(parts[i]);
      } else if (want[i] !== parts[i]) {
        hit = false; break;
      }
    }
    if (!hit) continue;
    if (routeMethod !== method) { methodMismatch = true; continue; }
    return { handler, params, opts: opts || {} };
  }
  /* Distinguishing 405 from 404 is not politeness, it is the difference between
     "you have the wrong URL" and "you have the wrong verb", which is an hour of
     somebody's afternoon. */
  return methodMismatch ? { methodMismatch: true } : null;
}

/* ================================================================ dependencies */

/* Everything that reaches the network, in one place. env.DEPS lets a test
   replace any of them; nothing else in the Worker calls fetch directly.

   The clock is in here too. It is not a network call, but a handler that reads
   Date.now() directly cannot be tested against a chosen day, and every rule in
   this API -- streaks, the today-or-yesterday window, code expiry -- is a rule
   about time. */
export function makeDeps(env) {
  const override = env.DEPS || {};
  const fetchImpl = override.fetchImpl || ((...a) => fetch(...a));

  return {
    now: override.now || (() => Math.floor(Date.now() / 1000)),

    fetchImpl,

    sendLoginCode: override.sendLoginCode || (({ to, code, ttlMinutes }) =>
      sendLoginCode({
        to,
        code,
        link: signinLink(env.APP_ORIGIN || 'https://playsapien.com', to, code),
        ttlMinutes,
        apiKey: env.RESEND_API_KEY,
        /* The fallback matters: an unset var here would otherwise send from a
           domain Resend has not verified, and the send would 403 while the
           endpoint still answered { sent: true }. Keep it equal to the
           wrangler.toml value. */
        from: env.MAIL_FROM || 'PlaySapien <no-reply@profiles.playsapien.com>',
        fetchImpl,
      })),

    googleJwks: override.googleJwks ||
      (() => cachedJwks(fetchImpl, 'https://www.googleapis.com/oauth2/v3/certs')),

    accessJwks: override.accessJwks ||
      ((team) => cachedJwks(fetchImpl, 'https://' + team + '/cdn-cgi/access/certs')),
  };
}

/* A JWKS fetch per sign-in would add a round trip to Google to every callback.
   The Cache API is used rather than a module-level variable because a Worker
   isolate is short-lived and per-colo, so a variable caches nothing useful and
   a cache entry is shared across every isolate in the colo. `caches` is absent
   under plain Node, which is exactly the situation the tests are in, so the
   fallback is an uncached fetch rather than a crash. */
async function cachedJwks(fetchImpl, url) {
  const req = new Request(url, { headers: { accept: 'application/json' } });
  const store = typeof caches !== 'undefined' && caches.default ? caches.default : null;

  if (store) {
    const hit = await store.match(req);
    if (hit) return await hit.json();
  }

  const res = await fetchImpl(req);
  if (!res.ok) throw new Error('jwks fetch ' + res.status);
  const body = await res.text();

  if (store) {
    /* An hour. Google rotates keys on the order of days and publishes the new
       one well before it signs with it, so an hour-stale key set is never the
       reason a token fails to verify. */
    const copy = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
    });
    await store.put(req, copy);
  }
  return JSON.parse(body);
}

/* ================================================================== entry */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return preflight(request, env);

    if (!url.pathname.startsWith('/api/')) {
      return withCors(ERRORS.notFound('This Worker only serves /api.'), request, env);
    }

    /* A health check that touches nothing. Useful for confirming a deploy and
       a route binding without needing a session or a database. */
    if (url.pathname === '/api/health') {
      return withCors(ok({ status: 'ok' }), request, env);
    }

    const route = match(request.method, url.pathname);
    if (!route) return withCors(ERRORS.notFound('No such endpoint.'), request, env);
    if (route.methodMismatch) {
      return withCors(err('method_not_allowed', 'That endpoint does not take a ' +
        request.method + '.', 405), request, env);
    }

    const deps = makeDeps(env);
    const now = deps.now();

    const context = {
      req: request,
      env,
      url,
      db: env.DB,
      now,
      deps,
      params: route.params,
      waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : () => {},
      /* CF-Connecting-IP is set by the edge and cannot be spoofed by the
         client; X-Forwarded-For can, and is deliberately not read. */
      ip: request.headers.get('cf-connecting-ip') || null,
      ipCc: request.headers.get('cf-ipcountry') || null,
      session: null,
      user: null,
      admin: null,
    };

    try {
      if (!env.DB) throw new Error('D1 binding DB is missing');

      /* The session is resolved for every route, including the ones that do not
         need it. It is a single indexed read, and the alternative -- a per-route
         flag saying whether to look -- is one more thing to get wrong on the
         route where it matters. */
      const resolved = await loadSession(env.DB, request, now);
      context.session = resolved.session;
      context.user = resolved.user;

      if (route.opts.admin) {
        const refused = await admin.requireAccess(context);
        if (refused) return withCors(refused, request, env);
      }

      const response = await route.handler(context);
      return withCors(response, request, env);
    } catch (e) {
      /* Invalid is the validators' way of failing from deep inside a handler
         without every one of them threading a return value back up. It carries
         a message written for a player, so it is safe to show. */
      if (e instanceof Invalid) {
        return withCors(err(e.code || 'invalid', e.message, 400), request, env);
      }
      /* Everything else is a bug, and the response says so and nothing more. A
         stack trace in a response body is a map of the source tree; it goes to
         the log, where it is useful, and never to the client. */
      console.error('[api] ' + request.method + ' ' + url.pathname + ' failed', e);
      return withCors(
        json({ ok: false, error: { code: 'internal', message: 'Something went wrong.' } },
          { status: 500 }),
        request, env);
    }
  },

  /* Housekeeping. The nightly chain assessment described in
     SUBMISSION-PIPELINE.md §3 is not wired up -- it needs an Anthropic API key
     and a batch job, and it is step 5 of the build order while this is step 1.
     What runs today is the cleanup that stops three tables growing forever. */
  async scheduled(event, env, ctx) {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil((async () => {
      try {
        await env.DB.batch([
          /* Consumed and expired codes, after a day. Kept for a day rather than
             deleted immediately so that "I typed it and it said no" can be
             looked into while the player is still asking. */
          env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(now - DAY),
          /* Sessions that expired or were revoked a month ago. The month is so
             that "your devices" can still show a recently revoked session, which
             is how someone confirms that signing out everywhere worked. */
          env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?')
            .bind(now - 30 * DAY, now - 30 * DAY),
          /* Sapien grants that have run out. Access already ended at the
             instant plan_until passed -- effectivePlan decides that at read
             time -- so this only makes the stored row say what is already
             true, for anyone reading the table directly. */
          env.DB.prepare(
            "UPDATE users SET plan = 'free', plan_since = plan_until, plan_until = NULL " +
            "WHERE plan = 'sapien' AND plan_until IS NOT NULL AND plan_until <= ?").bind(now),
        ]);
        await sweepRateLimits(env.DB, now);
      } catch (e) {
        console.error('[cron] housekeeping failed', e);
      }
    })());
  },
};
