/* What a player is actually entitled to, right now.

   One function, used everywhere a plan is read, so that "has this Sapien grant
   run out?" is answered in exactly one place. The stored `plan` column is not
   trusted on its own: a Sapien row whose plan_until has passed IS a free
   account from that second on, whether or not the nightly job has caught up
   with it yet. */

export function effectivePlan(plan, planUntil, now) {
  if (plan !== 'sapien') return 'free';
  if (planUntil != null && planUntil <= now) return 'free';
  return 'sapien';
}

/* Promotion codes are compared the way people type them: case-insensitive,
   spaces ignored. "freetrial #11.1" and "FREETRIAL#11.1" are the same code. */
export function normalisePromo(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase().slice(0, 64);
}
