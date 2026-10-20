> Copied from the claude.ai "PlaySapien" project on 20 Oct 2026 for the move to Claude Code.
> Dated notes: where this disagrees with CLAUDE.md, CLAUDE.md wins.

# Accounts, tiers and admin — the model and what is still open

Last updated: 20 October 2026. Supersedes the account and leaderboard
notes in `platform-state.md`, which predate all of this.

## The three tiers (built)

| | No account | Free | Sapien |
|---|---|---|---|
| Daily puzzles (today) | yes | yes | yes |
| **Past daily puzzles (last 30 days)** | gate → sign in | → upgrade card | **yes** |
| Past days shown | no (kept on device, not shown) | yes | yes |
| Daily result ranked against other players | no | **yes** | yes |
| Analytics | gate → sign in | Daily only | Daily, Last dozen, Lifetime |
| Friends | gate → sign in | yes; join groups, not create | yes; create groups |
| Friend challenges | gate → sign in | **join and play** | **start and play** |
| Make puzzles (game Add) | gate → sign in | → upgrade card | yes |

**Every account keeps every result.** The tier decides how much of the record is
shown back, never how much is kept. Signed-out history is hidden, not deleted —
it is claimed into the account at sign-up.

Enforced in one place: a capture-phase click guard in `packages/ui/ui.js`
(`data-gate="account"|"sapien"`, `data-gate-label`). Presentation only — the API
refuses the calls regardless.

## Friends — one card everywhere (built 19 Oct, migration 0005)

- Shared card in `packages/ui` (bar.html `#friendsSheet`, ui.js
  wireFriends/loadFriends/paintFriends), on the home page and both games.
  `PSUI.openFriends(code)` opens it pre-filled (home page `?f=CODE`);
  `?invited=1` (link in invitation emails) opens sign-in / Friends.
- **Invite box takes an email or a code.** By email (`POST
  /api/player/friends/invite`): always answers "Sent." — an address with an
  account gets the invite in the game and NO email; one without gets ONE
  invitation email per 30 days (any inviter), the invite kept as an HMAC of the
  address in `email_invites` and turned into a friend request if they join with
  it (claimEmailInvites, on account creation, verified address only). Email has
  a "stop invitation emails" link → `email_optouts`.
- **Limits (Kai):** typed addresses 20/day, 50/month (counted the same whether
  delivered in-game or by email, so the limit can't leak membership); codes
  40/day, 100/month.
- **Queue:** 30 invites shown, oldest first; more wait unseen until there is
  room. Actions: Accept, Later (`later_at`, stays queued), Reject (deletes +
  `friend_rejections`), Block. **Rejections pause the sender:** 3 in 7 days or
  5 in 30 days.
- **Blocks:** `friendships.blocked_by`; only the blocker sees the block (in a
  "Blocked" list) and can Unblock; the blocked player is never told and their
  invites report "Sent." but go nowhere. Pre-0005 blocks (NULL blocked_by) stay
  blocked for both.
- Nightly: email invites expire after 90 days; rejections after 30.
- Privacy page Friends section and retention list updated.
- Family sign-ups work under the one-email rule: every inviter's invite to an
  address is kept (even when no second email goes out) and all of them become
  friend requests when that person joins.
- **Not built yet:** sending a made Word Chain puzzle to friends (composer
  still uses a local placeholder list).

## Free trial — two days, once per email for ever (built 19 Oct, migration 0004)

- `POST /api/player/trial`: Sapien for 2 days, no payment details; offered on
  the upgrade card when `trial_available`.
- `trial_claims(email_key)`: HMAC (LOGIN_CODE_PEPPER, or TRIAL_KEY_SECRET if
  set) of the normalised address; survives account deletion. **Do not rotate
  LOGIN_CODE_PEPPER without setting TRIAL_KEY_SECRET to the old value** (also
  affects email_invites / email_optouts keys).
- A promotion code also uses up the trial.

## Display names are unique (built 19 Oct)

Case-insensitive check in `PATCH /api/player/me` → 409 `name_taken` (red note
under the field). A Google name already taken gets a random tag ("John Smith
39K", `lib/names.js`).

**Chosen at first sign-in (built 19 Oct, migration 0006, commit 908f117).** A
new account gets a proposed name: email part before "@" (no +tag) plus a tag
("kai 39K"), or the Google name. `users.name_chosen_at` is NULL until the
player saves a name; `/auth/session` and `/player/me` return `name_needed`. The
shared `#nameSheet` (bar.html / ui.js askName) opens once per visit until they
save; "Not now" keeps the proposal. A daily chain's public byline shows only a
confirmed name.

## Word Chain made puzzles: spell check (built 19 Oct)

Composer marks words not in the 66k dictionary and asks before saving; such
chains can go to friends but `POST /api/wordchain/chains` (general pool) refuses
them (`not_a_word`). Worker copy of the list: `src/lib/wordlist.js`, generated
by `scripts/make-wordlist.mjs`; a test fails if it drifts from dict.txt. Two-
letter words allowed.

## Profile card — one card on every surface (built 19 Oct)

- `packages/ui`; the shell calls `PSUI.setUser(user)` and listens for `ps:user`.
- Who-strip on Analytics, Friends, Settings, Profile.
- Account Type: "Sapien since: <date> (N months)" / "Free since: <date>"
  (`plan_started`), Upgrade / Downgrade (stacked cards).
- Avatar and Display Name: draft until Save; Icons, Monsters, Robots, Animals,
  Your Image.

## Avatars (built 19 Oct)

- `packages/avatars/<set>/*.webp`, served at `/avatars/` by the shell build;
  sources in Kai's OneDrive `Game Apps/Avatars/`.
- Tokens: `ps-01..08` (6 offered: 01, 02, 05–08), `monster-NN`, `robot-NN` /
  `robot-NNb` (head close-up), `animal-NNx` (group letter a–f).
- **Each player sees 12 per picture set**, seeded by account id (Robots 6
  close-up + 6 whole; Animals one per group + 6 more). Re-deal everyone by
  changing `DEAL` in ui.js (`'deal-1'`); `DEAL_SIZE = 12`.

## Payments (researched 19 Oct; Paddle account being set up)

- Annual $24 far cheaper than $2 × 12. **Paddle** (merchant of record).
- Site prepared for Paddle's review: /sapien/ and /refunds/ pages, Terms Sapien
  section, Privacy lists Paddle. Payouts: bank transfer, USD, $100 threshold.
- Refund rule: whole unused months, a month begun ≤ 2 days ago not counted.
  Paddle partial refunds via `POST /adjustments`.
- To build: checkout button, Paddle webhook → `plan_until` +12 months, refund
  calculator on the Admin page.

## Past daily challenges (built 19 Oct, both games)

Day row: TODAY then 30 earlier days (Sapien). Past games count for own record
only.

## Sapien grants (migration 0003)

`users.plan_until`, read-time `effectivePlan`. A launch promotion code (see the `promo_codes` table)
through 1 Nov 2026 UTC.

## Decided 19 October

1. Offline vs real scores: option D; offline play built.
2. Word Chain time offline counts for own record; ranks only online.
3. Last dozen / Lifetime = daily puzzles only; past-day plays don't count.
4. Leaderboards public by default, verified scores only (Terms updated).
5. Percentiles; fewer than 20 players in a group → rank; provisional until
   midnight UTC.
6. Intellisense categories: WORLD, VERBAL, LOGIC, SPACE, SOCIAL.
7. Legal: PlaySapien; Georgia, USA; Terms in effect 1 Oct 2026. Kai wants his
   personal name kept off everything — keep "PlaySapien" (sole trader brand
   now; LLC via a registered agent later, then "PlaySapien LLC").
8. Past daily challenges are Sapien. One free 2-day trial per email, for ever.

## Still open

- **LLC** (in progress); then Terms/Privacy → "PlaySapien LLC", Paddle details.
- **Payment build** (above).
- **Word Chain pairs (done 19 Oct, 2f4a227):** `games/wordchain/src/pairs.json`
  judges wrong guesses (1,953 heads; `make_pairs.py` from `pairs-graded.jsonl` +
  `pairs-additions.txt`; "~" = partial head → neutral reply).
- **Word Chain calendar (done 20 Oct, 1843b2b):** 390 new chains
  (`chains-2026-10.jsonl`, calendar order) after the 34 originals; from
  21 Oct 2026 one new chain a day, wraps after 390 days; closest repeated pair
  56 days apart. Practice only serves already-played chains. Tools and briefs
  in `games/wordchain/chain-tools/`. **finalize.py overwrites gamedata.json —
  rerun make_bank.py after it.**
- **Friend challenges (timed / 1v1) are not built** — no server side; the
  "New challenge" buttons now say "coming soon". Kai to decide whether to build.
- **Friend groups (built 20 Oct, f40799a, migration 0007):** private lists
  owned by one player (friends not told). Making/adding = Sapien; remove/delete
  = anyone. `routes/groups.js`; `/api/player/friends` returns `groups`. Friends
  card rebuilt: invites-for-you on top; Invite a friend (sent invites fold
  under it); Share your code (navigator.share, else copy); Friends: ALL
  (Block|Remove|Add) → groups A–Z (trash + confirm sheet `#grpDelSheet`) →
  Blocked. Analytics picker lists the groups (numbers still not built).
- Home page had no toast element (all pop-up messages silently dropped); ui.js
  now creates one (20 Oct).
- **The privacy date** (still 19 Sept).
- Some Monster and Animal pictures look close to well-known characters.
