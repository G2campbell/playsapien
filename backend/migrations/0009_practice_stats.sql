-- PlaySapien 0009: how much practice Word Chain players get through.
--
-- The game keeps a small set of practice chains on the device and tops it up from
-- the server when it runs low. How fast players burn through practice chains is the
-- number that says whether the practice pool is the right size (routes/wordchain-play.js),
-- so it is counted: per UTC day, per player (their account, or their device when they
-- have none), how many practice chains they finished and how many times they had to
-- top the set up. Read by the admin surface (GET /api/admin/practice-stats).
CREATE TABLE practice_stats (
  day     TEXT    NOT NULL,                 -- 'YYYY-MM-DD', UTC
  subject TEXT    NOT NULL,                 -- 'u:<user id>' or 'd:<device id>'
  plays   INTEGER NOT NULL DEFAULT 0,       -- practice chains finished that day
  topups  INTEGER NOT NULL DEFAULT 0,       -- times the device asked for more
  PRIMARY KEY (day, subject)
);
CREATE INDEX practice_stats_day ON practice_stats (day);
