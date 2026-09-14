# Player-submitted chains: what exists, and what it needs

## What is built, today, in the client

- The composer carries a checkbox, checked by default, above the keyboard:
  *"Allow chain to be used as a daily challenge (with credit); note that once saved,
  this cannot be revoked."*
- Saving with it checked writes the chain into a **submission queue**, with the author's
  name (from Profile → Your name), a timestamp, and `status: "pending"`.
- Profile now takes a name, which is what a byline would use.
- The chain list shows which of your chains have been offered, and under whose name.

## What is NOT built, and cannot be

Everything after the queue. The queue lives in **that player's browser**, in their own
localStorage. It has never left their device and there is no mechanism by which it could.
Concretely, none of the following exists:

- a pool **you** can see
- Claude assessing a batch, on demand or at 2am
- approval moving a chain into the daily or practice pool **for other players**
- notifying an author that their chain was accepted
- following another player

Each of those needs a server. Not a large one, but a real one: somewhere that is not the
player's phone, that holds chains from many people and serves a chain bank back to
everyone. Until that exists, a "submitted" chain is a note the player wrote to themselves.

This is worth being blunt about because the client half looks finished. It isn't
half-finished — it is the correct half, shaped so the other half can be bolted on without
redoing it. But nothing reaches you yet.

## What the other half is

It fits the shape already sketched for Sojourner's leaderboard, and stays on Cloudflare.

**1. Storage — D1.** One SQLite database, free at this volume.

    chains(id, author_id, words_json, status, pool, score, verdict, flag,
           created_at, decided_at)
    users(id, name, created_at, strikes, blocked_at)
    notices(id, user_id, body, read_at)
    incidents(id, chain_id, author_id, words_json, reason, detail, at)

`status` is pending / approved / rejected / **blocked**. `pool` is daily / practice.
`flag` carries the safety verdict (clean, or the category that tripped).

`incidents` is the retention table. A chain rejected on content grounds is **not**
deleted: the words, the author and the reason are copied here and kept, so a pattern
across submissions is visible rather than being erased one rejection at a time. It is
also what `users.strikes` counts. That is the whole schema for v1.

**2. Submission — a Pages Function.** `POST /api/chains` takes the chain and the author,
writes a pending row. The client calls it on save instead of only writing localStorage.
About twenty lines.

**3. Assessment — a scheduled Worker.** Cron `0 6 * * *` (2am ET is 06:00 or 07:00 UTC
depending on daylight saving — Cloudflare cron is UTC only, so either accept the one-hour
drift or run two crons and guard inside). It pulls pending rows in batches and asks Claude
to grade each chain on the criteria already in spec-v3 §7: every link a real pair, how
common each is, hub words, sense-shifts.

Every submission is asked two separate questions, and the safety one is asked first.

**Question one — is it safe?** Not "is it a good chain" but: do the words, the pairs
they form, or the chain read end to end carry sexually explicit content, or racist,
antisemitic, homophobic, transphobic, misogynistic or otherwise hateful content —
including where the innocuous-looking words are the point and the slur or the phrase is
what they spell out in sequence. Anything that trips this is **rejected outright**,
never promoted to either pool, and written to `incidents` with the words, the author and
the category. A borderline call goes to you rather than through.

**Question two — is it a good chain?** Only asked of what passed. The criteria already
in spec-v3 §7: every link a real pair, how common each is, hub words, sense-shifts.

| Verdict | Where it goes |
|---|---|
| unsafe | **rejected**, retained in `incidents`, author struck |
| really good | queued for **your** approval → daily pool |
| okay | approved → **practice** pool, automatically |
| anything else | left pending, flagged **for you** |

**Nothing reaches the daily pool without you.** Claude can promote a chain to practice on
its own, and that is the whole of its write authority. "Really good" is a recommendation,
not an approval: it sorts your queue, it does not empty it. A bad daily goes to every
player at once and cannot be taken back once the day starts, so the daily pool has exactly
one gate and you are it.

Cost: about $0.0013 a chain on Haiku 4.5, so a hundred submissions a day is **13 cents**.
The batch API halves that and suits a nightly job perfectly.

**4. Your review — one page.** `/admin`, behind a password or a Cloudflare Access rule.
Three lists: **recommended for daily** (Claude's really-goods, awaiting you), **pending**
(what Claude could not call, with its reasoning), and **incidents** (what was rejected on
content grounds, with the author and the category, so a repeat submitter is visible at a
glance rather than buried in a log). Each chain gets the same buttons — daily, practice,
reject — plus, from the incidents list, **block this author**. You can run a batch on
demand rather than waiting for the cron.

A flagged chain shows its words on that page and nowhere else: it never renders in another
player's client, and it is never used to explain the rejection back to its author. The
author is told only that the chain was not accepted.

**5. Scheduling into the daily.** An approved daily chain gets a date assigned at random
within the next 10 days, from the free slots. The client fetches the bank rather than
carrying it inline, so a new chain reaches everyone without a redeploy.

**6. The byline.** The play screen shows *Created by <name>* when the chain has an author.
Trivial once chains arrive with one attached.

**7. Notices.** On approval, a row in `notices`. The client reads unread notices on open
and shows them. Real push notification is a later, larger question (service worker,
permission prompt, and a reason good enough to justify asking).

## Two decisions worth making before any of it is built

**Accounts.** Following users, notifying authors and crediting reliably all need an
identity that survives a browser wipe. Right now "your name" is a string on one device;
two players could both be "Alex" and neither could be told apart. An email-link sign-in is
the smallest thing that works. This is the decision that gates the most.

**Moderation.** Settled, and built into the table above: safety is judged before quality,
anything unsafe is rejected and retained with its author, and the daily pool is
human-approved without exception. Two pieces of it still need a decision from you.

*What a strike costs.* `users.strikes` counts, but nothing acts on the count yet. The
simplest rule that works: one incident is a note, two blocks the account from submitting
(they can still play), three blocks the account. Silent blocking — the submit button
still works, the chain simply never leaves the queue — wastes less of your time than an
argument, but it is a choice worth making deliberately.

*How long incidents are kept.* Keeping them forever is what makes a pattern visible; it
also means holding onto the content indefinitely. A year is a reasonable middle, with the
author's strike count surviving the purge of the words themselves.

There is also a second line of defence worth having regardless of Claude: a blocklist
checked in the client at save time, so the most obvious cases never make it to a queue at
all. It catches nothing clever and should not be relied on — its value is that it is free
and instant.
