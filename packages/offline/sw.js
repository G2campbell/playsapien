/* PlaySapien offline service worker.

   ONE file, copied by each surface's build.sh into that surface's own folder --
   /sw.js for the front door, /sojourner/sw.js, /wordchain/sw.js -- so each
   surface registers its own worker with its own scope, and a game's offline
   copy can never be served or evicted by another surface's deploy. That is the
   same independence the deploys already have: one surface, one Worker, one
   cache.

   What "offline" means here, precisely:

     PAGES (navigations)   network first, with a short timeout. Online, you get
                           the newest page exactly as you would with no worker
                           at all; offline -- or on a connection so poor it
                           would have failed anyway -- you get the last copy.
     CODE and STYLES       network first, same reason. A game's index.html and
                           its app.js are a matched pair: serving a fresh page
                           with a stale script (or the reverse) is the classic
                           service-worker bug, and network-first cannot cause it.
     HEAVY STATIC FILES    cache first, refreshed in the background: Sojourner's
                           textures, three.min.js, images, fonts. Large, rarely
                           changed, and the reason a game is slow to load on a
                           poor connection.
     /api/*                NEVER touched. Accounts, results and sessions are live
                           data; a cached answer there is a wrong answer.

   The page also tells the worker what it already loaded before the worker
   existed (see the 'cache' message below), so the very first visit is enough
   to make the next one work offline -- not the second visit.

   The front door's worker covers "/", which also contains /sojourner/ and
   /wordchain/. Those paths belong to the games' own workers, so the front door
   is told to leave them alone: it is registered as sw.js?x=/sojourner/,/wordchain/
   and reads that list from its own URL. */

'use strict';

const VERSION = 'v1';
const SCOPE = new URL(self.registration.scope).pathname;          // "/", "/sojourner/"
const CACHE = 'ps-offline-' + VERSION + ':' + SCOPE;
const EXCLUDE = (new URL(self.location.href).searchParams.get('x') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const NET_TIMEOUT_MS = 4000;

const HEAVY = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|bin|ktx2|glb|mp3|ogg)$/i;
const isHeavyPath = (p) => HEAVY.test(p) || p.includes('/assets/') || p.endsWith('three.min.js');
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  /* The page itself, so even a worker that has seen nothing else can open the
     game's front screen with no connection. */
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.add(new Request(self.registration.scope, { cache: 'reload' })))
      .catch(() => { /* offline at install: the runtime cache fills in later */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  /* Drop this scope's caches from older versions; never touch another scope's. */
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('ps-offline-') && k.endsWith(':' + SCOPE) && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Whether this worker should handle a request at all. */
function mine(url) {
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return false;
    /* The avatar pictures live at the site root (/avatars/) but are worn on
       every surface, so each game's worker keeps the ones it has shown --
       otherwise a player's face would vanish from a game's bar offline. */
    if (url.pathname.startsWith('/avatars/')) return true;
    if (!url.pathname.startsWith(SCOPE)) return false;
    if (EXCLUDE.some((x) => url.pathname.startsWith(x))) return false;
    if (url.pathname.endsWith('/sw.js')) return false;
    return true;
  }
  return FONT_HOSTS.includes(url.hostname);
}

function cacheable(res) {
  if (!res) return false;
  if (res.type === 'opaque') return true;                 // the Google Fonts stylesheet
  return res.ok && res.status === 200;
}

async function put(req, res) {
  if (!cacheable(res)) return;
  try { const c = await caches.open(CACHE); await c.put(req, res); } catch (e) { /* quota: carry on */ }
}

/* Race the network against a timer. A dead connection rejects at once; a
   crawling one is given up on after NET_TIMEOUT_MS, so a player on a train
   gets the cached game in four seconds rather than a spinner for forty. */
function networkWithTimeout(req) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT_MS);
    fetch(req).then((r) => { clearTimeout(t); resolve(r); },
                    (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(req, isPage) {
  try {
    const res = await networkWithTimeout(req);
    put(req, res.clone());
    return res;
  } catch (e) {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: isPage });
    if (hit) return hit;
    if (isPage) {
      /* Deliberately NOT the home page. Serving the front door under the Terms
         address -- which an earlier version did -- tells someone the page they
         asked for exists and looks like this. It does not. Say what is true. */
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Offline</title><body style="font:16px system-ui;padding:40px;text-align:center">' +
        '<p>You are offline, and this page has not been opened on this device before.</p>' +
        '<p>Open it once while connected, and it will work offline after that.</p>',
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    throw e;
  }
}

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  /* Refresh in the background either way, so a changed texture arrives on the
     next visit without ever making this one wait. */
  const refresh = fetch(req).then((res) => { put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!mine(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, true));
  } else if (url.origin !== self.location.origin || isHeavyPath(url.pathname)) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req, false));
  }
});

/* "Here is what I loaded before you were watching." Sent once by the page
   after the worker takes control; fetched again so the copies stored are
   complete responses rather than whatever the HTTP cache happens to hold. */
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type !== 'ps-cache' || !Array.isArray(d.urls)) return;
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const u of d.urls.slice(0, 1000)) {
      let url;
      try { url = new URL(u, self.registration.scope); } catch (e) { continue; }
      if (!mine(url)) continue;
      if (await c.match(url.href)) continue;
      try {
        const sameOrigin = url.origin === self.location.origin;
        const res = await fetch(url.href, sameOrigin ? {} : { mode: url.hostname === 'fonts.gstatic.com' ? 'cors' : 'no-cors' });
        await put(new Request(url.href), res);
      } catch (e) { /* offline again, or gone: skip it */ }
    }
  })());
});
