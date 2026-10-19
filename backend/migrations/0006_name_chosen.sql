-- PlaySapien 0006: new players are asked to choose their display name.
--
-- name_chosen_at is when the player last saved a display name themselves.
-- While it is NULL, the site offers them a proposed name the first time they
-- sign in (and on each later visit until they save one): the part of their
-- email before the "@" plus a short random tag ("kai 39K"), or for a Google
-- sign-up the name Google gave. Either way they can change it before saving.
--
-- Players who already have a name were never asked, but they have had a name
-- on show all along, so they are counted as having chosen it.
ALTER TABLE users ADD COLUMN name_chosen_at INTEGER;
UPDATE users SET name_chosen_at = created_at
 WHERE display_name IS NOT NULL AND TRIM(display_name) <> '';
