# Writing more Word Chain chains

How the October 2026 chains (../src/chains-2026-10.jsonl) were made, kept so
the next batch can be made the same way.

1. Writers (Claude subagents) each followed BRIEF.md, one per range of
   starting letters, checking their file with `check_chains.py FILE`
   (needs pairs.json, dict.txt and old_pairs.json beside it, and `pip install
   wordfreq`). Round 2 (BRIEF2.md, `--round2`) asked for fresh pairs because
   round 1's writers converged on the same ones.
2. Merged: dropped chains with a British-only or word-part-accident link or a
   link graded below 3; kept each pair to at most 3 chains and each 3-word run
   to at most 2.
3. `schedule.py` ordered them (simulated annealing) so a pair comes back as
   late as possible: closest repeat 56 days, none within a week.
4. `../src/make_bank.py` adds them to gamedata.json with the calendar.
