/* Promotion codes and the end of a Sapien grant.

   This is the one path that hands out paid access, so it is tested on the
   things that would cost something if they were wrong: that a code works,
   that it works once, that access actually ends when it says it does, and
   that the old way of simply asking for Sapien is closed. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, signIn } from './helpers/harness.js';

const TRIAL = 'FREETRIAL#11.1';
const TRIAL_ENDS = 1793577600;             // 2026-11-02T00:00:00Z: all of 1 Nov included

test('the launch code makes an account Sapien until the end of 1 November', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'trial@example.com');

  const r = await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.plan, 'sapien');
  assert.equal(r.data.user.plan_until, TRIAL_ENDS);
  assert.equal(r.data.granted_until, TRIAL_ENDS);

  /* ...and the session, which is what every other request reads, agrees. */
  const s = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(s.data.user.plan, 'sapien');
  assert.equal(s.data.user.plan_until, TRIAL_ENDS);
});

test('codes are read the way people type them: case and spaces do not matter', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'typist@example.com');
  const r = await call(h.env, 'POST', '/api/player/redeem',
    { cookie, body: { code: '  freetrial #11.1 ' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.plan, 'sapien');
});

test('a code works once per player', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'twice@example.com');
  assert.equal((await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } })).status, 200);
  const again = await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } });
  assert.equal(again.status, 409);
  assert.equal(h.db.one('SELECT uses FROM promo_codes WHERE code = ?', TRIAL).uses, 1);
});

test('an unknown code and an expired code fail the same way', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'guess@example.com');
  const unknown = await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: 'NOPE' } });

  h.setNow(TRIAL_ENDS + 60);
  const late = await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } });

  /* Same status, same message: the endpoint must not say which guesses are
     real codes that have merely run out. */
  assert.equal(unknown.status, 400);
  assert.equal(late.status, 400);
  assert.deepEqual(unknown.body.error, late.body.error);
});

test('access ends the second the grant does, before any nightly job runs', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'ending@example.com');
  await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } });

  h.setNow(TRIAL_ENDS - 1);
  assert.equal((await call(h.env, 'GET', '/api/auth/session', { cookie })).data.user.plan, 'sapien');

  h.setNow(TRIAL_ENDS);
  const after = await call(h.env, 'GET', '/api/auth/session', { cookie });
  assert.equal(after.data.user.plan, 'free');
  assert.equal(after.data.user.plan_until, null);
  /* The stored row still says sapien -- nothing has tidied it -- and that is
     the point: the read decides, not the row. */
  assert.equal(h.db.one("SELECT plan FROM users WHERE email = 'ending@example.com'").plan, 'sapien');
});

test('a code never shortens access someone already has', async () => {
  const h = makeEnv();
  const { cookie, user } = await signIn(h, 'longer@example.com');
  const DEC = TRIAL_ENDS + 40 * 86400;
  h.db.raw.prepare("UPDATE users SET plan = 'sapien', plan_until = ? WHERE id = ?").run(DEC, user.id);

  const r = await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.plan_until, DEC);
});

test('the browser can no longer grant itself Sapien, but can still step down', async () => {
  const h = makeEnv();
  const { cookie } = await signIn(h, 'patcher@example.com');

  const up = await call(h.env, 'PATCH', '/api/player/me', { cookie, body: { plan: 'sapien' } });
  assert.equal(up.status, 403);

  await call(h.env, 'POST', '/api/player/redeem', { cookie, body: { code: TRIAL } });
  const down = await call(h.env, 'PATCH', '/api/player/me', { cookie, body: { plan: 'free' } });
  assert.equal(down.status, 200);
  assert.equal(down.data.user.plan, 'free');
  assert.equal(down.data.user.plan_until, null);
});

test('redeeming needs an account', async () => {
  const h = makeEnv();
  const r = await call(h.env, 'POST', '/api/player/redeem', { body: { code: TRIAL } });
  assert.equal(r.status, 401);
});
