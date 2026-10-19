/* The one free Sapien trial per inbox, and one player per display name. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';
import { normaliseTrialEmail } from '../src/lib/trial.js';

const TWO_DAYS = 2 * 86400;

test('a first-time player starts two days of Sapien with no payment details', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'new@example.com');

  const s0 = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s0.data.user.trial_available, true);
  assert.equal(s0.data.user.plan, 'free');

  const r = await call(h.env, 'POST', '/api/player/trial', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.plan, 'sapien');
  const started = r.data.user.plan_since;
  assert.equal(r.data.user.plan_until, started + TWO_DAYS);
  assert.equal(r.data.user.plan_started, started);
  assert.equal(r.data.user.trial_available, false);

  const s1 = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s1.data.user.plan, 'sapien');
  assert.equal(s1.data.user.trial_available, false);

  /* Two days later it is simply over, and "Free since" is the day it ended. */
  h.setNow(started + TWO_DAYS + 1);
  const s2 = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s2.data.user.plan, 'free');
  assert.equal(s2.data.user.plan_started, started + TWO_DAYS);
});

test('the trial is once per inbox -- not again, not after deleting the account', async () => {
  const h = makeEnv();
  let { cookie } = await signIn(h, 'Once.Only@gmail.com');
  assert.equal((await call(h.env, 'POST', '/api/player/trial', { cookie })).status, 200);

  /* Step down and ask again: refused. */
  await call(h.env, 'PATCH', '/api/player/me', { cookie, body: { plan: 'free' } });
  const again = await call(h.env, 'POST', '/api/player/trial', { cookie });
  assert.equal(again.status, 409);
  assert.equal(again.error.code, 'trial_used');

  /* Delete the account, sign up again with the same inbox written another way. */
  assert.equal((await call(h.env, 'DELETE', '/api/player/me', { cookie })).status, 200);
  ({ cookie } = await signIn(h, 'onceonly+again@googlemail.com'));
  const s = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s.data.user.trial_available, false);
  assert.equal((await call(h.env, 'POST', '/api/player/trial', { cookie })).status, 409);

  /* The address itself is not stored in the trial table. */
  assert.equal(h.db.one('SELECT COUNT(*) AS n FROM trial_claims').n, 1);
  assert.ok(!/@/.test(h.db.one('SELECT email_key FROM trial_claims').email_key));
});

test('an inbox is the same inbox however it is written', () => {
  assert.equal(normaliseTrialEmail(' Kai.C+games@GoogleMail.com '), 'kaic@gmail.com');
  assert.equal(normaliseTrialEmail('kai.c+x@example.com'), 'kai.c@example.com');
});

test('a promotion code uses up the trial', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'promo@example.com');
  assert.equal((await call(h.env, 'POST', '/api/player/redeem',
    { cookie, body: { code: 'FREETRIAL#11.1' } })).status, 200);
  const s = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s.data.user.trial_available, false);
});

test('a Sapien player cannot start a trial on top', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'already@example.com');
  await call(h.env, 'POST', '/api/player/trial', { cookie });
  const r = await call(h.env, 'POST', '/api/player/trial', { cookie });
  assert.equal(r.status, 409);
  assert.equal(r.error.code, 'already_sapien');
});

test('two players cannot share a display name, whatever the case', async () => {
  const h = makeEnv();
  const a = await signIn(h, 'a@example.com');
  const b = await signIn(h, 'b@example.com');
  assert.equal((await call(h.env, 'PATCH', '/api/player/me',
    { cookie: a.cookie, body: { display_name: 'Kai' } })).status, 200);

  const clash = await call(h.env, 'PATCH', '/api/player/me',
    { cookie: b.cookie, body: { display_name: '  kai ' } });
  assert.equal(clash.status, 409);
  assert.equal(clash.error.code, 'name_taken');

  /* Keeping your own name, or changing its case, is not a clash. */
  assert.equal((await call(h.env, 'PATCH', '/api/player/me',
    { cookie: a.cookie, body: { display_name: 'KAI' } })).status, 200);
  assert.equal((await call(h.env, 'PATCH', '/api/player/me',
    { cookie: b.cookie, body: { display_name: 'Kai B' } })).status, 200);
});
