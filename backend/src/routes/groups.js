/* Friend groups: a player's own private lists of friends (migration 0007).

   Only the owner ever sees a group. A friend can be in any number of the
   owner's groups, and must be an accepted friend to go in one. Removing or
   blocking a friend takes them out of the groups on both sides (friends.js).

   Adding to a group -- which is also how a group is made -- is Sapien.
   Taking a friend out of a group and deleting a group are open to everyone,
   so a player who steps down to Free can still tidy up what they made. */

import { ok, err, ERRORS, readJson } from '../lib/http.js';
import { first, all, run, stmt } from '../lib/db.js';
import { asObject, cleanDisplayName } from '../lib/validate.js';
import { newId } from '../lib/id.js';
import { getFriendship } from './friends.js';

export const MAX_GROUPS = 50;
export const MAX_MEMBERS = 500;
const RESERVED = new Set(['all', 'blocked']);   // the two lists the card always shows

/* The owner's groups, each with its member ids, alphabetical. */
export async function groupsFor(db, ownerId) {
  const groups = await all(db,
    'SELECT id, name FROM friend_groups WHERE owner_id = ? ORDER BY name COLLATE NOCASE', ownerId);
  const members = await all(db,
    `SELECT m.group_id, m.member_id FROM friend_group_members m
       JOIN friend_groups g ON g.id = m.group_id WHERE g.owner_id = ?`, ownerId);
  const byGroup = new Map(groups.map((g) => [g.id, { id: g.id, name: g.name, members: [] }]));
  for (const m of members) { const g = byGroup.get(m.group_id); if (g) g.members.push(m.member_id); }
  return [...byGroup.values()];
}

/* Statements that take each of two players out of the other's groups. */
export function unGroupStatements(db, x, y) {
  return [
    stmt(db, `DELETE FROM friend_group_members WHERE member_id = ?
               AND group_id IN (SELECT id FROM friend_groups WHERE owner_id = ?)`, y, x),
    stmt(db, `DELETE FROM friend_group_members WHERE member_id = ?
               AND group_id IN (SELECT id FROM friend_groups WHERE owner_id = ?)`, x, y),
  ];
}

/* GET /api/player/groups -> { groups: [{id, name, members: [ids]}] } */
export async function listGroups(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  return ok({ groups: await groupsFor(ctx.db, ctx.user.id) });
}

/* POST /api/player/groups/add { name, friend_id } -> { group, added }

   Adds a friend to the group with that name, making the group first if the
   player has none by that name (case does not matter: "family" finds
   "Family"). */
export async function addToGroup(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  if (ctx.user.plan !== 'sapien') {
    return err('sapien_required', 'Friend groups are part of Sapien.', 403);
  }
  const raw = await readJson(ctx.req);
  if (raw.bad || raw.tooLarge) return ERRORS.invalid('Send { name, friend_id }.');
  let body;
  try { body = asObject(raw.value); } catch { return ERRORS.invalid('Send { name, friend_id }.'); }
  const name = cleanDisplayName(body.name, 30);
  const friendId = String(body.friend_id || '');
  if (!name) return err('invalid_name', 'Give the group a name.', 400);
  if (RESERVED.has(name.toLowerCase())) {
    return err('reserved_name', 'That name is already used by the card. Choose another.', 400);
  }
  const f = friendId && friendId !== ctx.user.id ? await getFriendship(ctx.db, ctx.user.id, friendId) : null;
  if (!f || f.state !== 'accepted') return ERRORS.notFound('You can only add your friends to a group.');

  let group = await first(ctx.db,
    'SELECT id, name FROM friend_groups WHERE owner_id = ? AND name = ? COLLATE NOCASE',
    ctx.user.id, name);
  if (!group) {
    const n = await first(ctx.db, 'SELECT COUNT(*) AS n FROM friend_groups WHERE owner_id = ?', ctx.user.id);
    if (n.n >= MAX_GROUPS) return err('too_many_groups', 'You have the most groups allowed. Delete one first.', 409);
    group = { id: newId('g'), name };
    await run(ctx.db, 'INSERT INTO friend_groups (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)',
      group.id, ctx.user.id, name, ctx.now);
  }
  const m = await first(ctx.db, 'SELECT COUNT(*) AS n FROM friend_group_members WHERE group_id = ?', group.id);
  if (m.n >= MAX_MEMBERS) return err('group_full', 'That group is full.', 409);
  await run(ctx.db,
    `INSERT INTO friend_group_members (group_id, member_id, added_at) VALUES (?, ?, ?)
     ON CONFLICT(group_id, member_id) DO NOTHING`, group.id, friendId, ctx.now);
  return ok({ group: { id: group.id, name: group.name }, added: friendId });
}

/* DELETE /api/player/groups/:id/members/:member -> take a friend out of a group */
export async function removeFromGroup(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const res = await run(ctx.db,
    `DELETE FROM friend_group_members WHERE group_id = ? AND member_id = ?
       AND group_id IN (SELECT id FROM friend_groups WHERE owner_id = ?)`,
    ctx.params.id, ctx.params.member, ctx.user.id);
  if (!(res && res.meta && res.meta.changes)) return ERRORS.notFound('That friend is not in that group.');
  return ok({ removed: ctx.params.member, group: ctx.params.id });
}

/* DELETE /api/player/groups/:id -> delete the whole group (members cascade) */
export async function deleteGroup(ctx) {
  if (!ctx.user) return ERRORS.unauthorised();
  const res = await run(ctx.db, 'DELETE FROM friend_groups WHERE id = ? AND owner_id = ?',
    ctx.params.id, ctx.user.id);
  if (!(res && res.meta && res.meta.changes)) return ERRORS.notFound('No such group.');
  return ok({ deleted: ctx.params.id });
}
