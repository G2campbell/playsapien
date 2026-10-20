-- PlaySapien 0007: friend groups -- a player's own private lists of friends
-- ("Family", "Book club"). Only the owner sees a group; the friends in it are
-- not told and do not have to agree. Groups are what Analytics compares
-- against. Making one (adding a friend to a new or existing group) is Sapien;
-- removing a friend from a group, or deleting a group, is open to everyone.
CREATE TABLE friend_groups (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- One "Family" per player, however it is capitalised.
CREATE UNIQUE INDEX friend_groups_owner_name ON friend_groups (owner_id, name COLLATE NOCASE);

CREATE TABLE friend_group_members (
  group_id    TEXT NOT NULL REFERENCES friend_groups(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX friend_group_members_member ON friend_group_members (member_id);
