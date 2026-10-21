/* Who a friend challenge is for. Shared by 1v1 (routes/duels.js) and timed challenges
   (routes/timed.js), so the two can never differ on the things that matter:

     - a friend, picked from the list: they must be an accepted friend;
     - or a text-message link ({ text: true }): nobody is named, the answer carries a token
       that becomes the link, and whoever opens it first gets the challenge;
     - or an email address / invite code typed in: it does exactly what inviting them would
       (the same limits, the same friend request or invitation email) and the answer never
       says whether an address has an account. The challenge then waits until they have
       joined and accepted. Someone who has blocked the sender never sees it, and the sender
       is not told (the caller returns the same answer and creates nothing). */

import { err, ERRORS } from '../lib/http.js';
import { getFriendship, inviteForChallenge, textInviteForChallenge } from './friends.js';

export const MAX_PER_FRIEND = 5;      // games going at once with the same friend

/* `pairBusy(me, them)` counts the games already going between the two, for the caller's table.
   Resolves to { error } or { them, key, label, state, blocked, invited, token? }. */
export async function resolveTarget(ctx, to, pairBusy) {
  const me = ctx.user.id;
  if (to.friend_id) {
    const them = String(to.friend_id);
    const f = await getFriendship(ctx.db, me, them);
    if (!f || f.state !== 'accepted') return { error: err('not_friends', 'That player is not your friend.', 400) };
    if ((await pairBusy(me, them)) >= MAX_PER_FRIEND) {
      return { error: err('too_many_with_friend', 'You already have ' + MAX_PER_FRIEND + ' games going with them.', 400) };
    }
    return { them, key: null, label: null, state: 'active', blocked: false, invited: false };
  }
  if (to.text === true) {
    const r = await textInviteForChallenge(ctx);
    if (r.error) return { error: r.error };
    return { them: null, key: r.key, label: r.label, state: 'invited', blocked: false, invited: true, token: r.token };
  }
  if (typeof to.invite === 'string') {
    const r = await inviteForChallenge(ctx, to.invite);
    if (r.error) return { error: r.error };
    let state = 'invited';
    if (r.them) {
      const f = await getFriendship(ctx.db, me, r.them);
      if (f && f.state === 'accepted') state = 'active';        // they were already a friend
    }
    return { them: r.them || null, key: r.key || null, label: r.label || null, state, blocked: !!r.blocked, invited: true };
  }
  return { error: ERRORS.invalid('Say who it is for.') };
}
