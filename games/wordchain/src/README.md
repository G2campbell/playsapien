# Word Chain — source

    part-a-style.html   tokens + all CSS
    part-b-body.html    markup (home, play, four sheets, results)
    part-c-app.js       game logic
    build.py            concatenates the three parts, inlines gamedata + dictionary,
                        emits artifact.html (for publishing) and wordchain.html (standalone)

    gen2.py             pulls closed compounds out of a frequency list by splitting words
    graph.py            builds the link graph: auto compounds + a curated open-phrase list
    search2.py          searches the graph for 8-word chains, penalising hub words
    bank.py             the hand-graded chain bank and the level bands
    finalize.py         de-dupes, flags number-strict links, emits gamedata.json + dict.txt

## Rebuilding

    pip install wordfreq
    python3 graph.py && python3 bank.py && python3 finalize.py && python3 build.py

`search2.py` is a candidate generator, not part of the build — it proposes chains for a
human to vet. Its output is deliberately not wired into the bank, because the automatic
compound splitter produces morphological accidents (JUSTICE -> JUST + ICE) that read as
valid links to a scorer and as nonsense to a player.

## On grading

Corpus frequency is used as a **rarity flag, not as the familiarity score**. It only works
on genuinely closed compounds, and it undercounts anything usually written as two words —
`ratrace` scores 0.0. Familiarity is hand-graded 1-5 in `bank.py`; `finalize.py` prints a
RARITY-FLAG on any closed compound under 2.0 zipf so the author can look again.
