# Word Chain — round 2: fresh chains (read BRIEF.md first)

Read /home/claude/wc/chains/BRIEF.md for the game, the format and the grading;
everything there still applies, with these changes.

Round 1 produced good chains, but the six writers converged on the same pairs
(DOG FOOD CHAIN SAW, TIME TABLE TENNIS...). Players would notice repeats, so
round 2 is about FRESH pairs.

- Write **35 chains** whose first word starts with **LETTERS**, to **OUTFILE**.
- Check with:  python3 check_chains.py OUTFILE --round2   (add --ambiguity for
  the per-link counts). It must report 0 failing.
- New rules (the checker enforces them with --round2):
  * At least 5 of the 7 links must be pairs NOT in used_pairs.json.
  * No link that used_pairs.json shows as used twice already.
  * No link from bad_pairs.json; every link graded fam >= 3.
- Steer away from the hub words in used_words.json with high counts (BOOK,
  LIGHT, TIME, GAME, HOUSE, KEY, ROOM, SHOW, WORK, TABLE, DOG, FRONT, BALL, TOP,
  SIDE...). Explore other parts of the vocabulary: food, nature, sport,
  weather, body, music, travel, school, colours, animals, tools.
- The players are mostly American: avoid British-only phrases (car park, high
  street, post code, fish finger, windscreen, jumper...). Phrases known on both
  sides of the Atlantic are best.
- Same quality bar as before: real compounds of both meanings, no
  word-part accidents (-SHIP, -HOOD, -NESS, PIECE MEAL, WAR RANT), nothing
  gloomy or adult.

When finished, reply briefly: count, checker result, and any pairs you wanted
that were missing from pairs.json (up to 10).
