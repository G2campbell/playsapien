# Word Chain — Critique of Spec v2
*2026-09-03. Ordered by what would cost most to discover after the build starts.*

Ground rule for this round: I wrote large parts of v2, so the **[FILLED]** items get the
harshest treatment. Three findings below are against my own choices.

---

## 1. The Easy band rejects the Easy chain

This is the one to fix first, because it is load-bearing for everything downstream.

Easy requires **every link ≥ 4** and a **mean ≥ 4.5**. Grade the reference Easy chain:

| Link | Familiarity |
|---|---|
| HAND·BOOK | 5 |
| BOOK·SHELF | 5 |
| SHELF·LIFE | 4 |
| LIFE·GUARD | 5 |
| **GUARD·HOUSE** | **3** |
| HOUSE·WORK | 5 |
| WORK·SHOP | 5 |

GUARDHOUSE is a real word almost nobody reaches for. It fails the floor, so the chain
v2 files under Easy is not Easy by v2's own definition — the identical failure mode that
critique-v1 caught in spec-v1, reintroduced one document later.

Arithmetic makes it worse. Mean ≥ 4.5 across 7 links with a floor of 4 means **at least
four links must be 5s**. Familiarity-5 compounds are a small set, and they have to chain.
My instinct is that the Easy band as written admits maybe dozens of chains, not the
hundreds a daily puzzle needs.

**Before any code:** hand-grade 20 candidate Easy chains and count how many clear the
band. If it's under half, the band is fiction. My guess at a workable Easy is **floor 3,
mean ≥ 4.0** — but that is a guess, and the exercise is cheap.

---

## 2. Hidden hint accrual is now solving a problem that no longer exists

The bank is hidden because a length-scaled hint cost would leak word length. §5 replaced
length-scaling with **ordinal** cost (1st +15s, 2nd +25s, 3rd +40s), which leaks nothing —
the price of the next hint is identical whether the word is BOW or TRANSPORTATION.

So the constraint that motivated hiding the value is gone, and hiding it now costs real
things:

- The player cannot make the decision the hint button exists to pose. "Is 15 seconds worth
  it?" is a good question. "Is an unknown number of seconds worth it?" is not a question.
- The results card becomes a gotcha. *"You finished in 1:22 — actually 2:27."* That reads
  as a trick, and it is the last thing the player sees.
- Two clocks have to be maintained, displayed and reconciled, for no gameplay gain.

**Recommendation:** keep the `alarm-minus` icons — they earn their place as a glanceable
count of hints taken — but publish the cost. Either add the seconds to the visible clock
the instant a hint is taken, or label the bank with its running total. The escalating
ordinal price does all the work the hidden bank was meant to do, honestly.

Keep the hidden bank only if the intent is that a hint should feel like a small
transgression the player doesn't want to look at. That is a legitimate design, but it is a
different one, and it should be chosen deliberately rather than inherited from a
constraint that was removed.

---

## 3. Latency leaks the verdict

CORRECT is decided locally and lands instantly. STRONG / WEAK / NO PAIR go to the model —
one to five seconds. So the player learns they are wrong *from the pause*, before any
message renders. The response bank — the game's whole voice — gets stepped on by a
progress indicator every single time it matters.

Two fixes, both needed:

- **Floor every response at a fixed delay.** If adjudication returns in 300ms, hold until
  the floor. Timing then carries no information. Correct answers stay instant; everything
  else arrives at the same tempo.
- **Freeze the clock during adjudication, run it during lockout.** v2 §6 says the clock
  runs through the lockout (right — that's the penalty) but never addresses the network
  round trip (wrong — the player shouldn't pay for my latency). These are two different
  intervals and the spec currently conflates them.

Also unspecified: what happens when adjudication fails or times out. Suggest failing to
WEAK PAIR with a neutral line — never to NO PAIR, since snarking at a player because the
network dropped is the worst available outcome.

---

## 4. The lockout penalty is inverted

The wrong-guess penalty is time spent reading a message with input disabled. The clock
runs through it. Consider who actually pays:

- A player who **knows the next word** and fat-fingered it loses 1.1 seconds of typing time. Real cost.
- A player who is **stuck** loses nothing. They weren't going to type anyway. The lockout
  is 2.4 seconds of staring at the board with the pressure off — arguably a rest, not a fine.

The penalty is heaviest on competence and lightest on the state it is meant to discourage.

The graduated version does still deter one specific thing — alphabet-crawling, where NO
PAIR at 2.4s makes brute force tedious. That is worth keeping. But it is worth being clear
that the lockout is an **anti-spam device, not a difficulty mechanism**, and that under
this design a thoughtful wrong guess is genuinely free. Which is consistent with "wrong
answer = keep going anyway," so it may be exactly right — it just shouldn't be mistaken
for a penalty that scales with how wrong you were.

If you want the graduation to mean something, the lever is a small explicit clock bump on
NO PAIR only (+5s, shown). I'd hold off until playtesting says spam is real.

---

## 5. Number-agnostic matching needs a lemmatizer, not suffix rules

§3 rule 3 says "differ only by a regular plural inflection (`-s`, `-es`, `-ies/-y`)."
Implemented as string surgery this misfires immediately, and the misfires are all in the
chain vocabulary:

| Word | Naive strip gives | Problem |
|---|---|---|
| CROSS | CROS | not a plural; `-s` is structural |
| NEWS | NEW | plural-form singular, and NEW is a different word |
| SERIES | SERY | `-ies/-y` rule is nonsense here |
| GLASS / GLASSES | collide loosely | GLASS and GLASSES are different words |
| PRESS, BOSS, MOSS, BRASS | truncated | same as CROSS |

Use a real lemmatizer or an explicit inflection table over the chain vocabulary — the
vocabulary is authored and finite, so the table is small and can be validated at build
time. String rules will produce a wrong accept in the first week.

Related ordering bug in §3: **typo tolerance must run before the WRONG LETTER check.**
Answer BOARD, guess NOARD (N is adjacent to B) — as written, bucket 3 fires and says
"Starts with B", when the player simply mistyped a word they knew.

**The recommendation against "all answers are singular" stands.** The plural-only nouns
(CLOTHES, ODDS, MEANS, PANTS, SCISSORS) have no singular to fall back on, and the
meaning-changing pairs (ARM/ARMS, GLASS/GLASSES, WORK/WORKS) would lose links that Easy
chains specifically need. The list in spec §3 is the evidence you asked for.

---

## 6. Header density — resolving the open item

Seven interactive elements in a 390px header (back, About, Friends, Settings, Profile,
clock, hint bank, hint button) is roughly double what the reference does.
`pips--header.png` carries exactly four: `‹` on the left, then `Clear · ? · ⚙ · ···`.

**Match it.** Top row: `‹` left; `?` (About), `⚙` (Settings), `···` right — with Friends
and Profile living inside `···`. Second row: clock left, hint bank centre, sleeve button
right.

This does demote Friends from the top level, which cuts against "Friends between About and
Settings." Worth noting that Friends has no content yet, so the demotion costs nothing now
and can be revisited when it does. If top-level placement matters for a reason I can't
see, the alternative is dropping Settings into `···` instead.

---

## 7. Gentle mode defaults are backwards

§4 sets Gentle **on** for Easy. Easy is where new players are. So the players most likely
to be forming an opinion of the game are the only ones who never hear its voice — and the
snarky response bank is the most distinctive thing in this spec.

Suggest Gentle **off at every level**, with the existing damper (three wrong guesses on a
word drops NO PAIR to the WEAK register) carrying the load. That damper already solves the
real problem, which is escalating at someone who is struggling. Gentle stays available for
people who want it off entirely.

---

## 8. Daily or endless is not a small open item

§11 lists this fourth. It should be first, because it sets the content pipeline and
nothing else can be sized without it.

Home shows a date and a byline, and the results card offers "Play Another Difficulty" —
both borrowed from Pips, both implying **one chain per level per day**. That is
**1,095 authored, graded, validated chains a year**. Against the §7 bands, which §1 above
suggests are already near-infeasible at Easy.

Three shapes, pick one before building:

| | Content need | Notes |
|---|---|---|
| **Daily** | ~1,095 chains/yr | Matches the aesthetic and the share mechanic. Needs a generator or an author. |
| **Endless from a bank** | one-time bank, replayable | No date, no byline, no streak. Cheapest to ship. |
| **Daily front, endless behind** | ~365/yr + bank | Daily chain is the headline; "more chains" is unlimited practice. |

I'd ship the third — but the honest version of that recommendation is that the Easy band
has to be proven satisfiable first (§1), because it constrains all three.

---

## Verdict

The spec is buildable. Nothing here is structural in the way the v1 rule 5 / rule 6
contradiction was.

Settle these three before writing code, because each one changes what gets built:

1. **§1** — grade 20 candidate Easy chains and fix the bands to reality.
2. **§8** — daily, endless, or both.
3. **§2** — hidden hint bank, or published cost.

The rest (§3–§7) are corrections that can land in spec-v3 without a re-litigation.
