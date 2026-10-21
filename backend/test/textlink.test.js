/* A challenge sent by text message: the sender gets a one-time link, whoever opens it first
   gets the challenge, and it starts when they accept the friend request that comes with it. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';

async function sapien(h, who) {
  assert.equal((await call(h.env, 'POST', '/api/player/trial', { cookie: who.cookie })).status, 200);
}
const duel = (h, who, to) => call(h.env, 'POST', '/api/duels', { cookie: who.cookie, body: { to, chain: { source: 'practice' } } });
const timed = (h, who, to) => call(h.env, 'POST', '/api/timed', { cookie: who.cookie, body: { to } });
const claim = (h, who, token) => call(h.env, 'POST', '/api/invites/claim', { cookie: who.cookie, body: { token } });
const duels = (h, who) => call(h.env, 'GET', '/api/duels', { cookie: who.cookie });
const timeds = (h, who) => call(h.env, 'GET', '/api/timed', { cookie: who.cookie });

async function setup() {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  await sapien(h, kai);
  return { h, kai, ama };
}

test('a text challenge hands back a token, names no one and sends no email', async () => {
  const { h, kai } = await setup();
  const d = await duel(h, kai, { text: true });
  assert.equal(d.status, 201);
  assert.equal(d.data.state, 'invited');
  assert.match(d.data.token, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal(h.invites.length, 0, 'no email goes out');
  const mine = (await duels(h, kai)).data.games[0];
  assert.equal(mine.state, 'invited');
  assert.equal(mine.waitingOn, 'your text invite');
  /* the link itself is never kept, only its keyed hash */
  const row = h.db.one('SELECT invite_key FROM duels');
  assert.ok(row.invite_key && !row.invite_key.includes(d.data.token));
});

test('opening the link gives the challenge to the opener, with a friend request, and accepting starts it', async () => {
  const { h, kai, ama } = await setup();
  const { token } = (await duel(h, kai, { text: true })).data;
  const c = await claim(h, ama, token);
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.kinds, ['duel']);
  assert.equal(c.data.friends, false);
  assert.equal((await call(h.env, 'GET', '/api/player/friends', { cookie: ama.cookie })).data.incoming.length, 1);
  const theirs = (await duels(h, ama)).data;
  assert.equal(theirs.games[0].needsFriendAccept, true);
  assert.equal(theirs.yourTurn, 0);

  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept', { cookie: ama.cookie });
  const after = (await duels(h, ama)).data;
  assert.equal(after.games[0].state, 'active');
  assert.equal(after.yourTurn, 1);
});

test('a text link is spent by the first person to open it', async () => {
  const { h, kai, ama } = await setup();
  const bo = await signIn(h, 'bo@example.com');
  const { token } = (await timed(h, kai, { text: true })).data;
  assert.equal((await claim(h, ama, token)).status, 200);
  const second = await claim(h, bo, token);
  assert.equal(second.status, 404);
  assert.equal(second.error.code, 'link_used');
  assert.equal((await timeds(h, bo)).data.games.length, 0);
});

test('a text link also works for a timed challenge, and starts at once between friends', async () => {
  const { h, kai, ama } = await setup();
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: ama.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: kai.cookie, body: { code } });
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/accept', { cookie: ama.cookie });

  const { token } = (await timed(h, kai, { text: true })).data;
  const c = await claim(h, ama, token);
  assert.deepEqual(c.data.kinds, ['timed']);
  assert.equal(c.data.friends, true);
  const t = (await timeds(h, ama)).data;
  assert.equal(t.games[0].state, 'active');
  assert.equal(t.yourTurn, 1);
});

test('the sender cannot open their own link, and a made-up token finds nothing', async () => {
  const { h, kai } = await setup();
  const { token } = (await duel(h, kai, { text: true })).data;
  const own = await claim(h, kai, token);
  assert.equal(own.status, 400);
  assert.equal(own.error.code, 'own_link');
  assert.equal((await claim(h, kai, 'A'.repeat(22))).status, 404);
  assert.equal((await claim(h, kai, 'not a token!')).status, 400);
});

test('a blocked pair gets the same answer as a spent link, and nothing is attached', async () => {
  const { h, kai, ama } = await setup();
  await call(h.env, 'POST', '/api/player/friends/' + kai.user.id + '/block', { cookie: ama.cookie });
  const { token } = (await duel(h, kai, { text: true })).data;
  const c = await claim(h, ama, token);
  assert.equal(c.status, 404);
  assert.equal(c.error.code, 'link_used');
  assert.equal((await duels(h, ama)).data.games.length, 0);
});

test('only a signed-in player can open a link, and only a Sapien can make one', async () => {
  const { h, kai, ama } = await setup();
  const { token } = (await duel(h, kai, { text: true })).data;
  assert.equal((await call(h.env, 'POST', '/api/invites/claim', { body: { token } })).status, 401);
  const free = await duel(h, ama, { text: true });
  assert.equal(free.status, 403);
});
