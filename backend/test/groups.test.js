/* Friend groups: private lists of friends, made by Sapien players. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';

async function befriend(h, x, y) {
  const code = (await call(h.env, 'GET', '/api/player/friends/code', { cookie: y.cookie })).data.code;
  await call(h.env, 'POST', '/api/player/friends/add', { cookie: x.cookie, body: { code } });
  const r = await call(h.env, 'POST', '/api/player/friends/' + x.user.id + '/accept', { cookie: y.cookie });
  assert.equal(r.status, 200);
}
const add = (h, who, name, friend) =>
  call(h.env, 'POST', '/api/player/groups/add', { cookie: who.cookie, body: { name, friend_id: friend.user.id } });

test('a Sapien player makes a group by adding a friend, and only they see it', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, ama); await befriend(h, kai, bo);

  /* Free: refused. */
  const free = await add(h, kai, 'Family', ama);
  assert.equal(free.status, 403);
  assert.equal(free.error.code, 'sapien_required');

  assert.equal((await call(h.env, 'POST', '/api/player/trial', { cookie: kai.cookie })).status, 200);
  const r1 = await add(h, kai, 'Family', ama);
  assert.equal(r1.status, 200);
  /* Same group however it is capitalised. */
  const r2 = await add(h, kai, '  family ', bo);
  assert.equal(r2.data.group.id, r1.data.group.id);
  assert.equal(r2.data.group.name, 'Family');
  await add(h, kai, 'Book club', ama);

  const list = await call(h.env, 'GET', '/api/player/friends', { cookie: kai.cookie });
  assert.deepEqual(list.data.groups.map((g) => g.name), ['Book club', 'Family']);
  assert.deepEqual(list.data.groups[1].members.sort(), [ama.user.id, bo.user.id].sort());
  /* Ama never sees Kai's groups. */
  const theirs = await call(h.env, 'GET', '/api/player/friends', { cookie: ama.cookie });
  assert.deepEqual(theirs.data.groups, []);
});

test('only friends go in a group; reserved names are refused', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const stranger = await signIn(h, 'x@example.com');
  await call(h.env, 'POST', '/api/player/trial', { cookie: kai.cookie });
  assert.equal((await add(h, kai, 'Family', stranger)).status, 404);
  const ama = await signIn(h, 'ama@example.com');
  await befriend(h, kai, ama);
  assert.equal((await add(h, kai, 'All', ama)).error.code, 'reserved_name');
  assert.equal((await add(h, kai, 'blocked', ama)).error.code, 'reserved_name');
  assert.equal((await add(h, kai, '   ', ama)).error.code, 'invalid_name');
});

test('remove from a group, delete a group, and removing or blocking a friend un-groups them', async () => {
  const h = makeEnv();
  const kai = await signIn(h, 'kai@example.com');
  const ama = await signIn(h, 'ama@example.com');
  const bo = await signIn(h, 'bo@example.com');
  await befriend(h, kai, ama); await befriend(h, kai, bo);
  await call(h.env, 'POST', '/api/player/trial', { cookie: kai.cookie });
  const fam = (await add(h, kai, 'Family', ama)).data.group.id;
  await add(h, kai, 'Family', bo);
  const club = (await add(h, kai, 'Club', ama)).data.group.id;

  const out = await call(h.env, 'DELETE', `/api/player/groups/${fam}/members/${bo.user.id}`, { cookie: kai.cookie });
  assert.equal(out.status, 200);
  /* Someone else cannot touch Kai's group. */
  assert.equal((await call(h.env, 'DELETE', '/api/player/groups/' + fam, { cookie: ama.cookie })).status, 404);

  /* Ama blocks... no -- Kai blocks Ama: she leaves both of Kai's groups. */
  await call(h.env, 'POST', '/api/player/friends/' + ama.user.id + '/block', { cookie: kai.cookie });
  let g = (await call(h.env, 'GET', '/api/player/groups', { cookie: kai.cookie })).data.groups;
  assert.deepEqual(g.map((x) => [x.name, x.members.length]), [['Club', 0], ['Family', 0]]);

  /* Removing Bo as a friend takes him out too. */
  await add(h, kai, 'Club', bo);
  await call(h.env, 'DELETE', '/api/player/friends/' + bo.user.id, { cookie: kai.cookie });
  g = (await call(h.env, 'GET', '/api/player/groups', { cookie: kai.cookie })).data.groups;
  assert.equal(g.find((x) => x.id === club).members.length, 0);

  assert.equal((await call(h.env, 'DELETE', '/api/player/groups/' + club, { cookie: kai.cookie })).status, 200);
  g = (await call(h.env, 'GET', '/api/player/groups', { cookie: kai.cookie })).data.groups;
  assert.deepEqual(g.map((x) => x.name), ['Family']);
});
