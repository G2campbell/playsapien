# Word Chain — write new daily chains (brief for one batch)

Word Chain shows 8 words in a row. Word 1 is shown in full; for words 2-8 the
player sees only the first letter and must guess each word, where every
neighbouring pair forms a familiar English compound or set phrase:

    SNOW  BALL  PARK  BENCH  MARK  UP  TOWN  HALL
    (snowball, ballpark, park bench, benchmark, mark up, uptown, town hall)

The game has only 34 chains, so the daily puzzle repeats every 34 days. We are
writing about 450 new ones. You are writing one batch.

## Your batch

- Write **80 chains** whose FIRST word starts with one of these letters: **LETTERS**.
  (Later words can start with anything.)
- Output: JSON Lines to **OUTFILE**, one chain per line:

      {"words":["RAIN","DROP","KICK","BACK","PACK","HORSE","SHOE","STRING"],
       "links":[{"fam":5,"form":"closed","sense":false,"hetero":false}, ... 7 links ...]}

- Check your file with the checker, from /home/claude/wc/chains:

      python3 check_chains.py OUTFILE                (problems + summary)
      python3 check_chains.py OUTFILE --ambiguity    (also shows, per link, how
                                                      many OTHER everyday answers
                                                      share that first letter)

  Fix or replace every failing chain until the checker reports 0 failing.
  Append in chunks of ~20 chains (bash heredoc `cat >> OUTFILE <<'EOF'`) and
  check as you go.

## Hard rules (the checker enforces these)

1. Exactly 8 words, all different, UPPERCASE.
2. Every link must be an everyday pair in pairs.json (the strong list). If a
   pair you want is missing, pick another -- do not edit pairs.json. (You may
   note missing pairs you are confident about in your final reply.)
3. Every word must be a familiar word (word frequency zipf >= 3.0); no WURST,
   SHRIFT, BENCHER.
4. No link from the old 34 chains (old_pairs.json).
5. Within your file, no pair used twice, and no word in more than 6 chains.

## What makes a good chain (your judgement)

- Each pair is something people actually say or write: firework, park bench,
  kick off. Not a pair that is only "technically" a compound.
- Avoid morphological accidents that merely spell a word (WAR + RANT =
  warrant, JUST + ICE = justice, PAR + DON). Every link must be a real
  compound of the two meanings.
- The chain should flow and be fun: a mix of closed (FIREPLACE) and open
  (PARK BENCH) links, some pivots where a word changes meaning (BALL in
  SNOWBALL vs BALLPARK -> that is a sense shift).
- Guessability: prefer links where the answer is THE natural word for that
  head and letter. A link where 6+ other everyday answers share the letter
  (UP T... -> TOWN, TIME, TURN, TIGHT...) is fine occasionally, not in every
  chain. Use --ambiguity to see the counts.
- Word 8 has no neighbour after it, so it should be a well-known pair.
- Avoid offensive, gloomy or adult content; nothing about death, drugs,
  weapons beyond everyday words (GUN in SHOTGUN is ok, avoid making it a theme).
- Variety: avoid leaning on the same hub words (MAN, BACK, LINE, HOUSE, WORK,
  OFF, UP) -- they are allowed but at most 6 chains each, and fewer is better.

## Grade every link

- "fam": 5 = everyone knows it instantly (snowball, fireplace); 4 = very
  familiar (park bench, benchmark); 3 = familiar but you might hesitate (town
  crier); 2 = known to many but not all; 1 = obscure. Most links should be 4-5.
- "form": "closed" if usually written as one word (FIREPLACE, SNOWBALL), else
  "open" (PARK BENCH, TOWN HALL; hyphenated counts as open).
- "sense": true if the shared word changes meaning from the previous link
  (BALL: snow-ball -> ball-park is a ball as a sphere vs a ball game). For
  link 1 it is false.
- "hetero": true only if the shared word changes PRONUNCIATION (BOW in
  CROSSBOW vs BOW OUT).

Aim for a spread: about 40% easy (all links fam >= 4, mean >= 4.3, at most 2
sense shifts), 40% medium (all >= 3, mean >= 3.6), 20% harder.

When you finish, reply briefly: how many chains, checker result, and up to 15
missing pairs you would add to pairs.json.
