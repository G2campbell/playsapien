/* The few database statements about duels that OTHER routes need to include in their own
   batches: when a friendship is accepted, refused, removed or blocked, and when someone
   joins at an address a challenge was sent to. They are statements, not calls, so that
   the friendship change and the duel change happen together (routes/friends.js). */

import { stmt } from './db.js';

/* Both players have agreed to be friends: any challenge waiting on it can start. */
export function activateDuelsStmt(db, x, y, now) {
  return stmt(db,
    `UPDATE duels SET state = 'active', updated_at = ?
      WHERE state = 'invited'
        AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`, now, x, y, y, x);
}

/* No longer friends, or never going to be: challenges between the two stop, quietly, with no
   result. (A block is never announced, and neither is this.) */
export function cancelDuelsStmt(db, x, y, now) {
  return stmt(db,
    `UPDATE duels SET state = 'cancelled', updated_at = ?
      WHERE state IN ('invited', 'active')
        AND ((a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?))`, now, x, y, y, x);
}

/* A challenge sent to an address with no account yet: when that person joins, it becomes
   theirs. It stays 'invited' until they accept the friend request that arrives with it. */
export function attachInvitedDuelsStmt(db, inviteKey, userId, now) {
  return stmt(db,
    `UPDATE duels SET
        a_id = CASE WHEN a_id IS NULL THEN ? ELSE a_id END,
        b_id = CASE WHEN b_id IS NULL THEN ? ELSE b_id END,
        invite_key = NULL, updated_at = ?
      WHERE invite_key = ? AND state = 'invited' AND challenger_id != ?
        AND created_at > ?`, userId, userId, now, inviteKey, userId, now - 90 * 86400);
}
