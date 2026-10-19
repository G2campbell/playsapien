/* New players are asked to choose a display name, with a proposal filled in. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';
import { nameFromEmail } from '../src/lib/names.js';

test('an email sign-up gets a proposed name and is asked until they save one', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'jo.anne+games@example.com');

  const s0 = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.match(s0.data.user.display_name, /^jo\.anne \d{2}[A-HJ-NP-Z]$/);
  assert.equal(s0.data.user.name_needed, true);

  /* Asked again on the next visit: nothing has been saved yet. */
  const s1 = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s1.data.user.display_name, s0.data.user.display_name);
  assert.equal(s1.data.user.name_needed, true);

  /* Saving the proposal unchanged counts as choosing it. */
  const save = await call(h.env, 'PATCH', '/api/player/me',
    { cookie, body: { display_name: s0.data.user.display_name } });
  assert.equal(save.status, 200);
  assert.equal(save.data.user.name_needed, false);
  const s2 = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s2.data.user.name_needed, false);
  const me = await call(h.env, 'GET', '/api/player/me', { cookie });
  assert.equal(me.data.user.name_needed, false);
});

test('a player can change the proposal before saving, and taken names are refused', async () => {
  const h = makeEnv();
  const a = await signIn(h, 'ama@example.com');
  assert.equal((await call(h.env, 'PATCH', '/api/player/me',
    { cookie: a.cookie, body: { display_name: 'Ama' } })).status, 200);

  const b = await signIn(h, 'bo@example.com');
  const taken = await call(h.env, 'PATCH', '/api/player/me',
    { cookie: b.cookie, body: { display_name: 'ama' } });
  assert.equal(taken.status, 409);
  const s = await call(h.env, 'GET', '/api/auth/session', { cookie: b.cookie });
  assert.equal(s.data.user.name_needed, true);
  const ok = await call(h.env, 'PATCH', '/api/player/me',
    { cookie: b.cookie, body: { display_name: 'Bo' } });
  assert.equal(ok.data.user.display_name, 'Bo');
  assert.equal(ok.data.user.name_needed, false);
});

test('an account with no name at all gets a proposal filled in', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'blank@example.com');
  h.db.raw.prepare("UPDATE users SET display_name = ''").run();
  const s = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.match(s.data.user.display_name, /^blank \d{2}[A-Z]$/);
  assert.equal(s.data.user.name_needed, true);
});

test('the proposal is the part before the @, without a +tag or odd characters', () => {
  assert.equal(nameFromEmail('kai@g2campbell.com'), 'kai');
  assert.equal(nameFromEmail('Jo.Anne+news@example.com'), 'Jo.Anne');
  assert.equal(nameFromEmail('a"b<c>@x.com'), 'abc');
  assert.equal(nameFromEmail(''), '');
});
