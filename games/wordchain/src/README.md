# Word Chain — source

    part-a-style.html   tokens + all CSS
    part-b-body.html    markup (home, play, four sheets, results)
    part-c-app.js       game logic
    dict.txt            66,293 words, the NOT-A-WORD check. CHECKED IN (543 KB)
    build.py            concatenates the three parts, inlines gamedata + dictionary,
                        emits dist/ (the hosted page) and preview/ (artifact.html,
                        wordchain.html)

    gen2.py             pulls closed compounds out of a frequency list by splitting words
    graph.py            builds the link graph: auto compounds + a curated open-phrase list
    search2.py          searches the graph for 8-word chains, penalising hub words
    bank.py             the hand-graded chain bank and the level bands
    finalize.py         de-dupes, flags number-strict links, emits gamedata.json + dict.txt

## Rebuilding

    python3 build.py              # from anywhere; -> games/wordchain/dist/
    python3 build.py --check      # validate, write nothing. CI runs this

`build.py` needs nothing that is not in the repo. Regenerating the chain bank and
the dictionary does:

    pip install wordfreq
    python3 graph.py && python3 bank.py && python3 finalize.py && python3 build.py

## Why dict.txt is committed

It is 66,293 words / 543 KB of plain text, and `finalize.py` produces it from
`wordfreq`'s top-70k English list — a 57 MB pip install with its own data files.
Three options were weighed: commit it, generate it at build time from something
already in the repo, or download it with a checksum.

Generating it is not possible. The largest word source in the repo is
`gamedata.json`'s lexicon, about 1,500 words. `part-c-app.js` uses the dictionary
to separate a typo from an invented word (`:394`, `:398`); with a 1,500-word stub
most real English words are judged NOT A WORD and single-letter typos of real
words are silently accepted. That is a behaviour change, not a build fix.

Downloading it would make the build need the network, which is the manual step
being removed. So: commit it. It is ~182 KB in the pack, it changes essentially
never, and every built `index.html` already carries the same bytes inline.

`search2.py` is a candidate generator, not part of the build — it proposes chains for a
human to vet. Its output is deliberately not wired into the bank, because the automatic
compound splitter produces morphological accidents (JUSTICE -> JUST + ICE) that read as
valid links to a scorer and as nonsense to a player.

## On grading

Corpus frequency is used as a **rarity flag, not as the familiarity score**. It only works
on genuinely closed compounds, and it undercounts anything usually written as two words —
`ratrace` scores 0.0. Familiarity is hand-graded 1-5 in `bank.py`; `finalize.py` prints a
RARITY-FLAG on any closed compound under 2.0 zipf so the author can look again.
