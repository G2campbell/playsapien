# Word Chain — Spec v3 (as built)
*2026-09-11. Supersedes spec-v2.md. This describes what `build/` actually does.*

Live: the published artifact. Offline: `build/wordchain.html`.

---

## 1. Decisions taken since v2

| | v2 | v3 |
|---|---|---|
| Alternates | unresolved | **Rejected.** The authored chain is the answer. A valid-but-unintended pair gets its own reply. |
| Score | points | **None.** A running clock, Pips-style. |
| Wrong guess | −1 point | **A read-lockout.** The clock runs while you read the reply; nothing is deducted. |
| Hint cost | tied to word length, hidden | **Ordinal and published:** +15s, +25s, +40s within a word, added to the clock the instant you tap. |
| Hint bank | hidden until the results card | **Visible.** `alarm-minus` icons count the hints, with the running total beside them. |
| Plurals | "all answers singular" | **Number-agnostic, except where number is meaningful.** §4. |
| Sense shifts | capped per level | **Not capped.** Commonality of the link is the measure; shifts and heteronyms are contributing weights. |
| Theme | one light skin | **Light and dark, switchable in Settings**, defaulting to the system setting. |

---

## 2. The chain

Eight words. Word 1 in full, words 2–8 first letter only, no letter counts at any level.
Word 8 has no right-hand neighbour and is therefore the softest link in the chain —
authors should give it the least common pair to compensate. *(Anchoring both ends was
considered and dropped: rejecting alternates removed the need, and a visible last word
gives away too much of the middle.)*

---

## 3. The seven buckets

Everything decidable locally is decided locally and instantly. Only the last three —
which are a question of taste, not correctness — reach the model.

| Bucket | Test | Where | Lockout |
|---|---|---|---|
| CORRECT | matches the authored word after normalising | local | 0 ms |
| NUMBER | right word, wrong number, on a link where that matters | local | 1100 ms |
| NOT A WORD | fails the dictionary and is not a near-miss | local | 1100 ms |
| WRONG LETTER | first letter ≠ the revealed letter | local | 1100 ms |
| STRONG PAIR | a real, established pair — just not the authored one | lexicon, else model | 900 ms |
| WEAK PAIR | attested but marginal, forced or regional | model | 1700 ms |
| NO PAIR | a real word that makes no pair at all | model | 2400 ms |

Order matters: typo-tolerance runs **before** the first-letter check (so `NOARD` for
`BOARD` is a slip, not a lecture), and the dictionary runs **before** the first-letter
check too (telling someone their invented string starts with the wrong letter is true and
useless).

**Two clocks, deliberately separated.** The clock *runs* through the lockout — that is the
penalty. The clock *freezes* while the model is consulted, and while any sheet is open.
The player pays for reading, never for latency.

**Latency must not leak the verdict.** CORRECT lands instantly and locally; everything
else is held to a 450 ms floor, so a slow answer and a fast one arrive at the same tempo.
A model failure falls through to WEAK, never to NO PAIR — being snarked at because the
network dropped is the worst available outcome.

---

## 4. Number

The rule is your formulation, made precise:

- Number is judged **only against the incoming link** — the pair (word N−1, word N).
  The outgoing link constrains the *author*, not the player, who cannot see word N+1 yet.
- A link is **number-strict** when the singular and the plural are two *different
  established compounds*: FIREWORK (the object) and FIREWORKS (the display). On those,
  the wrong number gets *"That's the word — check the ending."* and does not advance.
- Everywhere else either number is accepted and the board shows the authored form.
  ARMCHAIR / ARMCHAIRS are one word in two numbers, not two words.

`numberStrict` is **hand-flagged**. Automatic detection by corpus frequency was tried and
abandoned: it flags every regular plural, because of course "armchairs" is frequent.
The flag currently fires on exactly one link in the bank, FIRE·WORK.

The blanket "all answers are singular" rule was rejected — it costs FIREWORKS, GRASSROOTS,
SUNGLASSES, CLOTHESLINE, NEWSPAPER, SPORTS CAR, ARMS RACE, DOWNSTAIRS, SOUR GRAPES and
about ten more, several of them exactly the high-familiarity links Easy needs. Some
(CLOTHES, ODDS, MEANS, PANTS, SCISSORS) have no singular at all.

Also normalised before any of this: case, spaces and hyphens (`LIGHT HOUSE` = `LIGHTHOUSE`),
and a one-edit typo that is not itself a dictionary word.

---

## 5. Replies

Six registers, authored to fit their lockout. `{PREV}`, `{GUESS}`, `{LETTER}` interpolate.

- **CORRECT** — *Yes. · That's it. · Exactly. · Nailed it. · Clean. · Sharp. · There it is.*
- **STRONG** — *Good guess, but not the one I'm thinking of. · Real pair. Wrong chain. · I'll allow it as English. Not as the answer.*
- **WEAK** — *No… and I'm not so sure about that one either. · Technically? Maybe. Correctly? No.*
- **NO PAIR** — *Really, since when is {PREV} {GUESS} a thing?! NO. · {PREV} {GUESS}. Say it out loud. Now don't. · Bold. Wrong, but bold.*
- **NOT A WORD** — *Not a word. Try again.*
- **WRONG LETTER** — *Starts with {LETTER}.*
- **NUMBER** — *Right word. Wrong number. · That's the word — check the ending.*

**Snark governor.** After three wrong guesses on the same word, NO PAIR drops to the WEAK
register. A **Gentle replies** toggle in Settings does the same permanently. It is **off by
default at every level** — including Easy, because Easy is where new players are, and the
voice is the most distinctive thing in the game.

---

## 6. Hints — the Lifeline

Tabler `lifebuoy`. Each tap reveals the next letter of the current word and adds its cost
to the clock immediately, with a `+15s` flash.

*(Named "Sleeve" in the first build, after the `jacket` icon then specified — "an ace up
your sleeve". Renamed once the icon changed.)*

- Cost by **ordinal within the word**: +15s, +25s, +40s. Resets on each new word, so one
  hint on three words (45s) is cheaper than three on one (80s).
- Cost is ordinal rather than length-based precisely so it leaks nothing about the word.
- Cap: **3 per word at every level.** If a hint completes a short word, the word
  auto-advances as solved-with-hints. A cap expressed in word length would leak length the
  moment the button greyed out.
- The bank shows `alarm-minus` icons (one per hint) and the running total.

---

## 7. One chain a day

Levels are gone from the interface. The home screen offers **Play daily challenge** and
**Practice** beneath it.

- The **daily** is seeded by date and drawn from the whole bank regardless of a chain's
  graded level, so everyone gets the same chain and difficulty swings day to day.
- **Practice** walks the rest of the bank and never serves the day's chain, so warming up
  cannot spoil the challenge.
- The two are held in **separate save slots**: a half-finished daily survives a practice
  round, and each offers Resume independently. An unfinished daily from a previous day is
  discarded on load, because the chain has rolled over.
- Once the daily is finished, its button stops being a way in and becomes **Share your
  score** — live, still primary. The time moves down to the footer line
  (*Today's chain · 1:47 · 1 lifeline*), so the button carries the action and the page
  carries the result.
- Once done, the home screen also **lists the solution** beneath the time — the chain is
  spent for that player, so there is nothing left to protect.
- The whole daily record is stored, not just its time, because that share can happen hours
  later — by which point a practice run may have overwritten `last`. Verified: finish the
  daily, play a practice round, then share from home, and the daily is what goes out.

The grading below still lives in the data and still governs what goes in the bank; it is
simply no longer something the player chooses. With 34 chains, practice repeats after 33.

## 7b. Difficulty (authoring, not player-facing)

Familiarity is hand-graded 1–5 per link. Corpus frequency is a **rarity flag only** — it
works on closed compounds and is worthless on open phrases (`ratrace` scores 0.0 because
nobody writes it closed). `finalize.py` flags any closed compound under 2.0 zipf for
author review.

| | every link ≥ | mean ≥ | sense shifts | heteronyms |
|---|---|---|---|---|
| **Easy** | 4 | 4.3 | ≤ 2 | 0 |
| **Medium** | 3 | 3.6 | ≤ 4 | — |
| **Hard** | — | — | — | — |

These bands were set from a graded bank, not guessed. v2's Easy band (floor 4, mean 4.5)
was tested against 26 hand-authored chains and **not one cleared it** — the failure
critique-v2 §1 predicted. Heteronym pivots (CROSS·**BOW**·OUT) count as sense shifts,
weighted heavier.

Bank as shipped: **34 chains — 8 easy, 20 medium, 6 hard.**

---

## 8. Screens

**Home** — full-bleed ochre, link mark, title, one-line tagline, Easy/Medium/Hard segmented
control with a tick on anything finished today, black Play pill, date and byline.
Difficulty is chosen here and only here.

**Play** — three fixed zones that never move, because the game brings its own keyboard:

1. **Bar**, pinned top: home icon, clock, mode chip, Lifeline bank, Lifeline button.
2. **Board**, filling the middle.
3. **Keyboard**, pinned bottom: QWERTY, with ENTER and DELETE on the third row.

Nothing on the board is a focusable text field, so no device ever raises a soft keyboard
and nothing scrolls out from under the player — which is what the old layout kept doing.
The container is sized to the **visual** viewport and re-sized on `visualViewport` events,
so browser chrome sliding in and out cannot crop the keyboard either. A physical keyboard
works too, and lights the matching key as you type.

**The caret lives in the chain.** There is no input box at the foot of the screen. The
active row carries the letters already revealed as fixed, styled characters — the given
first letter in ink, any bought letters in accent — and the text cursor sits flush against
the last of them, with the submit arrow on the same row. You type where you are looking.
The reply appears in a reserved slot directly beneath that row.

Two consequences:

- **WRONG LETTER is now unreachable.** The first letter is part of the row, not something
  the player can get wrong. The bucket stays in the code for pasted input but should never
  fire in normal play.
- **Typing the whole word out of habit** would double the prefix (`W` + `WORK` = `WWORK`).
  Guarded: if the doubled form is not a word and the plain one is, the plain one is used.

**Sheets** — four, opened from the **home screen's** upper right, in the order About,
Friends, Settings, Profile. Each is a card rising from the bottom with a drag handle,
dismissed by Close, the scrim, or Escape. About and Settings carry content; Friends and
Profile are structured empty states.

They live on the landing page rather than in the game header because a player should not
have to start a game to read the rules or change the theme.

**Pausing** — the home icon does not leave immediately. It stops the clock at the instant
it is tapped, blurs the board, and asks *"Pause the game and go back?"* with
**No, continue game** (primary) and **Yes**.

- **No** resumes: the clock picks up exactly where it stopped, and focus returns to the
  caret in the active row.
- **Yes** goes home and **holds the game**. The Play button for that level then reads
  **Resume**, and resuming restores the board and the clock unchanged. Choosing a
  different level shows **Play** again, and starting it discards the held game.
- The held game lives in memory only — it does not survive a page reload.

**Results** — *"You finished a **medium** chain in **1:47**"*, the hint breakdown if any, the
full chain, then Play another difficulty / Share your result.

---

## 9. Visual system

Light and dark are both first-class, and the viewer has three states, not two: an explicit
choice stamps `data-theme`; the default system setting stamps nothing and is resolved by
`prefers-color-scheme`. All three are handled at token level.

**Light is the default**, for everyone, whatever their device is set to — stamped on the
root element by a small script before first paint, so a dark-OS phone never flashes the
dark palette while the app loads. Settings offers Light / Dark / System; an explicit choice
always wins, and System then defers to `prefers-color-scheme`.

- **Light** — ochre ground `#D4B072`, warm off-white `#FAF9F7`, ink `#1F1A14`, burnt sienna
  accent `#9A4A24`. Deliberately outside the NYT Games hues.
- **Dark** — Sojourner's palette unchanged: ink `#0C0B0A`, paper `#F0E8DA`, amber `#E0A44A`,
  so the two games read as a family.
- **Type** — Fraunces (display, 900/600), Public Sans (UI), IBM Plex Mono (clock, tabular).
  Fraunces is also Sojourner's display face and a far better Cheltenham stand-in than a
  neutral serif.
- **Mechanics from Sojourner** — `.sheet` translateY spring, corner icon cluster, `setrow` /
  `toggle` / `seg` settings vocabulary, `soon` empty states — re-skinned light.

---

## 10. Daily or endless — settled

**Daily, with practice behind it.** See §7. The open question from critique-v2 §8 is closed.

---

## 11. Saved state

A game in progress is written to `localStorage` on every move — each solved word, each
Lifeline, each wrong guess — and again on `visibilitychange` and `pagehide`. Closing the
tab, the phone sleeping, or a reload all return to the same board with the same clock. On
opening, a saved game turns the Play button for that level into **Resume**.

Stored with it: which words are solved, which letters are revealed, the Lifeline bank, the
elapsed clock, and **the guesses already tried on the current word**.

Finished chains go to a `history` list (date, level, time, Lifelines, the chain itself),
which is what the Profile sheet now shows: best time per level, and the last twelve
finished chains. The tried-list resets on each new word — it answers "have I already tried
this here?", not "in this chain".

## 12. Letters bought with a Lifeline

A revealed letter is drawn in the accent and **stays** that colour for the life of the
chain — on the board after its word is solved, on the results card, and in the solution on
the home screen. It was only marked on the active row before, so the record of what was
bought vanished the moment you moved on.

The marking is derived from the per-word Lifeline count rather than stored separately:
letter 0 is the free given one, letters 1..n were bought. One renderer (`chainHTML`) draws
the finished chain for both the results card and the home screen, so the two cannot
disagree.

## 13. Wrong-guess treatment

- The guess **stays on screen**, greyed, for the length of its lockout, so it can be read
  back against the reply.
- Then it fades out over 240 ms and the caret returns to its place after the revealed
  letters. Nothing to clear by hand.
- A guess already tried on this word is caught locally and instantly: *"You've guessed that
  already."*
- **Every wrong reply is set in the accent**, whatever its register. Correct is green;
  wrong is burnt orange; the board itself is ink. Three voices, one each.

## 14. Sharing a result

Finishing offers **Share your result**, which draws a card on a canvas and hands it to the
**native share sheet** (`navigator.share` with the PNG as a file), falling back to copying
the image, then to copying text. Same behaviour as Sojourner.

**Only the daily is shareable.** A practice result shows *Back to start* alone, promoted
to the primary button — a practice time is a private rehearsal, with no shared chain behind
it for anyone to measure against. (The practice branch of the card drawing is therefore
unreachable for now; it is kept rather than deleted, in case practice sharing ever returns.)

**The card is drawn before the tap, never during it.** The share sheet may only be opened
from a live user gesture, and that permission is spent the moment the code awaits anything.
Awaiting font loading and canvas encoding was enough to lose it, so sharing silently
degraded to a clipboard copy. The card is now built as soon as a result exists — on
finishing, and again when the home screen shows *Share your score* — and the tap does
nothing but call `navigator.share` synchronously with the file already in hand. Clipboard
remains the fallback only where there is genuinely no share API.

Note that a page inside an iframe also needs `web-share` in its permissions policy, which
is outside the page's control; the hosted build, being top-level, is the reliable test.

The share carries **the link to the game** as well as the card — in `url` for the share
sheet, and repeated at the end of the text, because several targets quietly drop `url`
when a file is attached. Where the game lives is a single build constant (`SITE` in
`build.py`), injected as `window.__WC_SITE__`: the hosted build shares
`wordchain.g2campbell.com`, the artifact build shares its own artifact address, and the
card's footer line is drawn from the same value so it can never disagree with the link.

The **daily card does not show the chain.** It shows the shape of the run — one link per
word, ringed where a Lifeline was spent — plus the date and the time. Sharing a result must
not hand the answers to everyone else playing the same chain that day. The **practice
card** does show the words, since nobody else is racing on it.

## 15. Link preview

Shared links to the hosted build unfurl as a card: the chain mark and "Word Chain" set in
Fraunces on the ochre ground, 1200×630, rendered at build time by `src/og.js` (headless
Chromium with the font inlined, so it matches the game exactly rather than approximating
it). Shipped as `og.png` beside `index.html`, with `icon-512.png` for home-screen installs.

Open Graph requires an **absolute** URL for the image, so `SITE` at the top of `build.py`
has to match wherever the game is hosted. It is currently
`https://wordchain.g2campbell.com`. Nothing else depends on it; a mismatch costs only the
preview card.

This applies to the Cloudflare build. The published artifact's own link preview is
generated by claude.ai and is not affected.

## 16. The composer

A chain mark with a plus, in the home corner between About and Friends, opens a **page**
rather than a sheet — it is a working surface like the board, so it gets the same three
zones and the same keyboard. No clock, no Lifeline.

- **Any row, any time.** Tap a row to put the caret in it; ENTER steps to the next.
- **Save** is greyed until all eight rows hold a word of at least three letters. It is
  greyed but still *clickable*, because a dead button cannot explain itself: pressing it
  early says *"Each row must contain a word of at least three letters,"* and pressing it
  after a save says *"This puzzle has already been saved."*
- **Send** (the paper plane) is greyed until the chain is saved, and says so if pressed.
- The **home button** confirms first, but only when there is unsaved work to lose —
  confirming a departure from an untouched or already-saved page is noise, not safety.

**My chains** (the letters-list icon) shows each chain as its first word, a divider, then
the initials of the other seven: `SNOW | B, P, B, M, U, T, H`, with whether it has been
sent. Three actions: edit, send, delete. Delete asks first.

**Editing** loads the chain with Save greyed and Send live — the saved version is still
sendable. Changing any word flips that: Save becomes available, Send greys out until the
new version is saved. Saving from an edit writes a **new** chain rather than overwriting.

**Deleted but sent** is a real bucket. Deleting a chain that was never sent removes it;
deleting one that was sent moves it to an archive, because someone else may still be
playing it. Archived chains are listed, tagged, and carry no actions.

### Friends are local, and honestly so

There is no friends backend, so rather than invent names, the send sheet reads and writes
a local list that starts **empty**. The search field doubles as the way in: type a name,
press `+`, and it joins the list (anything plural or ending in *team / group / club /
family* is filed as a group). Every part of the flow — search, multi-select, send, and the
per-chain record of who it went to — is real against that local list, and will keep working
unchanged when a real friends service replaces the store behind it.

## 17. Known gaps

1. **The Easy tier is a small clique.** Eight chains, and four of them run through
   WORK·SHOP·LIFT·OFF. The vocabulary that satisfies the Easy band is genuinely narrow,
   which is the real answer to "can this be a daily?" — see critique-v3.
2. Friends and Profile hold no data.
3. The offline compound lexicon (3,883 pairs, auto-extracted) carries noise; it is the
   fallback path only, and a false "good guess" is a cheap failure.
