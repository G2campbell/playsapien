/* Friend invites by email, the invite queue, rejecting, and blocking. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';

const DAY = 86400;
const invite = (h, who, email) =>
  call(h.env, 'POST', '/api/player/friends/invite', { cookie: who.cookie, body: { email } });
const list = async (h, who) => (await call(h.env, 'GET', '/api/player/friends', { cookie: who.cookie })).data;

test('an address with an account gets the invite in the game, and no email is sent', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const r = await invite(h, kai, 'AMA@example.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { sent: true });
  assert.equal(h.invites.length, 0);
  const l = await list(h, ama);
  assert.equal(l.incoming.length, 1);
  assert.equal(l.incoming[0].id, kai.user.id);
});

test('an address with no account gets one email, and the same "sent" reply', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const r = await invite(h, kai, 'newbie@example.com');
  assert.deepEqual(r.data, { sent: true });
  assert.equal(h.invites.length, 1);
  assert.equal(h.invites[0].to, 'newbie@example.com');
  assert.match(h.invites[0].stopLink, /\/api\/invites\/stop\?k=/);
  /* The address itself is not stored. */
  assert.ok(!/@/.test(h.db.one('SELECT email_key FROM email_invites').email_key));
});

test('one invitation email per address per 30 days, whoever is inviting', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await invite(h, kai, 'newbie@example.com');
  const r = await invite(h, ama, 'newbie@example.com');
  assert.deepEqual(r.data, { sent: true });
  assert.equal(h.invites.length, 1);
  h.setNow(h.now() + 31 * DAY);
  const bo = await signIn(h, 'bo@example.com');
  await invite(h, bo, 'newbie@example.com');
  assert.equal(h.invites.length, 2);
});

test('joining with an invited address turns the invites into friend requests', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await invite(h, kai, 'new.bie@example.com');
  await invite(h, ama, 'new.bie@example.com');
  const nb = await signIn(h, 'new.bie@example.com');
  const l = await list(h, nb);
  assert.deepEqual(l.incoming.map((x) => x.id).sort(), [kai.user.id, ama.user.id].sort());
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM email_invites').n, 0);
});

test('the stop link ends invitation emails to that address', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  await invite(h, kai, 'quiet@example.com');
  const url = new URL(h.invites[0].stopLink);
  const stop = await call(h.env, 'GET', url.pathname + url.search, { raw: true });
  assert.equal(stop.status, 200);
  h.setNow(h.now() + 40 * DAY);
  const ama = await signIn(h, 'ama@example.com');
  const r = await invite(h, ama, 'quiet@example.com');
  assert.deepEqual(r.data, { sent: true });
  assert.equal(h.invites.length, 1);
  const bad = await call(h.env, 'GET', '/api/invites/stop?k=x&t=y', { raw: true });
  assert.equal(bad.status, 400);
});

test('email invites: 20 a day', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  for (let i = 0; i < 20; i++) {
    assert.equal((await invite(h, kai, 'p' + i + '@example.com')).status, 200, 'invite ' + i);
  }
  assert.equal((await invite(h, kai, 'p20@example.com')).status, 429);
});

test('Later keeps an invite; Reject removes it; rejections pause the sender', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const others = [];
  for (const n of ['a', 'b', 'c', 'd']) others.push(await signIn(h, n + '@example.com'));
  for (const o of others) await invite(h, kai, o.user.email);

  const a = others[0];
  assert.equal((await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/later', { cookie: a.cookie })).status, 200);
  let l = await list(h, a);
  assert.equal(l.incoming.length, 0);
  assert.equal(l.later.length, 1);

  for (const o of others.slice(0, 3)) {
    const r = await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/reject', { cookie: o.cookie });
    assert.equal(r.status, 200);
  }
  l = await list(h, a);
  assert.equal(l.later.length + l.incoming.length, 0);

  /* Three rejections in a week: Kai's invites are paused. */
  const k = await list(h, kai);
  assert.ok(k.paused_until > h.now());
  const r = await invite(h, kai, 'someone@example.com');
  assert.equal(r.status, 403);
  assert.equal(r.error.code, 'invites_paused');
  h.setNow(h.now() + 8 * DAY);
  assert.equal((await invite(h, kai, 'someone@example.com')).status, 200);
});

test('the queue shows 30; more wait until there is room', async () => {
  const h = makeEnv();
  const me = await signIn(h, 'me@example.com');
  for (let i = 0; i < 32; i++) {
    if (i % 8 === 7) h.setNow(h.now() + 3601);   /* the sign-in limiter is per hour */
    const s = await signIn(h, 's' + i + '@example.com');
    await invite(h, s, 'me@example.com');
  }
  let l = await list(h, me);
  assert.equal(l.incoming.length, 30);
  assert.deepEqual(l.queue, { used: 30, cap: 30, waiting: 2 });
  await call(h.env, 'POST', '/api/player/friends/' + l.incoming[0].id + '/accept', { cookie: me.cookie, body: {} });
  l = await list(h, me);
  assert.equal(l.incoming.length, 30);
  assert.equal(l.queue.waiting, 1);
});

test('a block is seen and undone only by the blocker; their invites go nowhere', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await invite(h, kai, 'ama@example.com');
  assert.equal((await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/block', { cookie: ama.cookie })).status, 200);

  assert.equal((await list(h, ama)).blocked.length, 1);
  const k = await list(h, kai);
  assert.equal(k.blocked.length + k.outgoing.length + k.accepted.length, 0);

  /* Kai inviting again is "sent" -- and nothing arrives. */
  assert.deepEqual((await invite(h, kai, 'ama@example.com')).data, { sent: true });
  assert.equal((await list(h, ama)).incoming.length, 0);

  /* Kai cannot unblock; Ama can. */
  assert.equal((await call(h.env, 'POST', '/api/player/friends/' + ama.user.id + '/unblock', { cookie: kai.cookie })).status, 404);
  assert.equal((await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/unblock', { cookie: ama.cookie })).status, 200);
  assert.equal((await list(h, ama)).blocked.length, 0);
});
