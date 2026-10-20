> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# Offline play vs. real scores — the options

Written 19 October 2026.

> **DECIDED (Kai, 19 Oct): option D.** Gameplay is saved on the device, the
> moves (not the score) are uploaded when a connection returns, and the server
> recomputes every score itself. A service worker makes offline play real. All
> the server work this needs is approved. The one sub-decision still open is
> how Word Chain's *time* is treated for runs played offline — see
> `accounts-and-admin.md`, "Decisions needed".

## Why they look like they conflict

A score is only trustworthy if the thing that judges it is a thing the player
cannot edit. Offline play requires that the judging happen *in* the thing the
player controls. So "the server decides" and "it works with no connection"
cannot both be true **of the same moment**.

They can both be true of the same *game*, if the judging moves later rather
than elsewhere. That is the whole trick, and it is option B.

## Two facts about where PlaySapien actually stands

1. **Neither game posts results to the API yet.** Sojourner has the hook
   (`window.SOJOURNER_API`, partD.js:348) and it is unset; Word Chain has none.
   The scoring pipeline is still entirely local, so this is the cheapest moment
   this decision will ever be made.
2. **There is no service worker and no manifest anywhere in the repo.** Offline
   play today is whatever the browser's HTTP cache happens to be holding. It is
   accidental, not engineered: a cold load with no connection fails, and
   Sojourner needs `three.min.js` plus baked artwork before it can draw a globe.

## The options

### A — Trusted client (today)
Browser plays, browser scores, server stores what it is told.
*Offline: perfect. Integrity: none.*

### B — Offline play, server replay
The browser records the **moves**, not the score. When a connection returns it
uploads the move log, and the server re-runs the same scoring function and
computes the score itself. The client's claimed number is discarded.
Stops all casual cheating; does not stop a determined cheat from synthesising a
plausible log. Needs one shared scoring module in `packages/`, run in both the
browser and the Worker.

### C — Server-authoritative live play
Strongest integrity, no offline at all.

### D — Hybrid by stake  ← chosen
Offline play always works and always counts **for you**. Offline results reach
a competitive board once verified (B), or are marked unverified.

### E — Signing the result in the browser
Not an option. Any key the browser holds, the player holds.

## Specific to these two games

**Sojourner suits replay verification almost perfectly**: the score is a
deterministic function of guessed coordinates against an answer key the server
already has. The one-minute sprint is the exception.

**Word Chain's score is elapsed time, measured by the browser.** A move log can
prove the chain was solved; it cannot prove how long it took. Timed results are
unverifiable offline in principle. Trustworthy time needs a server-issued start
and a server-stamped finish, i.e. online for that run.

- **Timed Friend Challenges** are the sharpest case — time is the competition.
- **1v1 challenges** are authoritative for free — turns go through the server.

## Build order this implies

1. Service worker — offline becomes real. Needs no decisions.
2. Shared scoring module + a move-log format per game.
3. Server: store move logs, replay them, record a verified score.
4. Games post move logs (queued offline, sent when back online).
5. Analytics: Daily / Last dozen / Lifetime from verified scores.
6. Leaderboards.
7. Friend challenges (1v1 turns, timed groups).
8. Admin page.
