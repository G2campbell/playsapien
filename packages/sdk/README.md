# @playsapien/sdk

The one client the two games and the shell all talk to. Dependency-free ES
module, no build step, no framework. Wraps the API in
[`docs/BACKEND-SPEC.md` §4](../../docs/BACKEND-SPEC.md).

The governing rule is that **the games work today with no server and must keep
working**. Nothing in here throws into game code, nothing blocks a render, and a
player who is not signed in cannot tell whether the backend exists.

## Integrating a game

Five lines, at the top of the game's own script:

```js
import PS from '/sdk/index.js';          // or bundle it; it is plain ESM

PS.init({ baseUrl: '/api', enabled: true });

const day = PS.dayKey();                                     // '2025-06-01', UTC
// ...play...
PS.saveResult({ game: 'sojourner', day, score: 812, maxScore: 978,
                detail: { rounds: [...] }, durationMs: 240000 });
```

That is the whole integration for a game that only needs to record results.
`saveResult` is not awaited on purpose: the localStorage write has already
happened by the time it returns, and the network attempt is nobody's business.

Sign-in, if the game offers it, is two more calls:

```js
await PS.signInEmail('ama@example.com');     // { sent: true } either way — no enumeration
await PS.verifyEmail('ama@example.com', '481923');   // sets the cookie, claims this device
```

## When the backend is absent

Which is the normal case until it is deployed, and the permanent case for a
player on a plane, behind a corporate filter, or in a browser that blocks
storage.

| Situation | What happens |
|---|---|
| `PS.init({ enabled: false })` | Not one byte leaves the device. Local writes still happen, so the game is unchanged. |
| `fetch` rejects (no network, no server) | Every call resolves. Reads return the last good response, then a correctly-shaped empty value. |
| API returns 500 | Same as offline. `ok:false`, never a throw. |
| API returns 409 on a result | First-write-wins (spec §5). Dropped silently — the server already has that day. |
| `localStorage` throws (private mode, blocked site data) | Every access is wrapped; the SDK degrades to in-flight-only and the game still runs. |
| A write did not reach the server | Queued in `ps:queue` and retried on the next `PS.init()`. Not lost. |

Every method resolves to an object carrying `ok` (did we reach the server) and
`source` (`'network'` | `'cache'` | `'local'` | `'offline'`), so a UI can show
"last synced" honestly rather than guessing.

## Surface

```
PS.init(opts)            baseUrl='/api', enabled=true, timeoutMs=6000,
                         pruneDays=90, autoFlush=true, storage?, fetch?
PS.dayKey(when?)         'YYYY-MM-DD' in UTC. The only day function. See below.
PS.prevDay(key)
PS.deviceId()            the UUIDv4 in ps:device, minted on first use

PS.session()             -> { ok, source, user }
PS.signInEmail(email)    -> { ok, sent }          six-digit code is mailed
PS.verifyEmail(email, c) -> { ok, user }          sets the cookie, claims the device
PS.signOut()             -> { ok }                clears locally regardless
PS.claim(extraIds?)      -> { ok, claimed }       merge this device's history

PS.me()                  -> { ok, source, user, streaks }
PS.notices()             -> { ok, source, notices }
PS.readNotices(ids)      -> { ok }

PS.friends()             -> { ok, source, friends, pending, code }
PS.addFriend(code)       -> { ok, state }

PS.saveResult({ game, day, mode, score, maxScore, detail, durationMs })
                         -> { ok, source, synced, queued, result }
PS.today(day?)           -> { ok, source, day, results }
PS.leaderboard(g, day?)  -> { ok, source, game, day, entries }   friends-only
PS.standings()           -> { ok, source, standings }            rolling 30 days

PS.flush()               retry the queue now
PS.queue()               inspect it
PS.localResult(g,day)    what this device recorded, server or no server
PS.prune()               force the 90-day pass
```

## Storage, and what this SDK does and does not touch

Audit §S3: cross-game platform state gets a third, game-neutral prefix. Per-game
progress keeps its existing prefix and is **not** migrated.

| Key | Owner |
|---|---|
| `ps:device` | SDK — the UUIDv4 device id |
| `ps:queue` | SDK — unsent writes |
| `ps:cache:*` | SDK — last good response per endpoint |
| `ps:result:<game>:<day>:<mode>` | SDK — the local copy of a result |
| `ps:pruned` | SDK — the day the last prune ran |
| `sojourner:*`, `wordchain:*` | the games. Read-only to the SDK, except the prune below. |

### The 90-day prune (audit §S2)

Two unbounded per-day key series now share one 5 MB keyspace. On `init` the SDK
drops keys whose date part is more than 90 days old, at most once per day:

- `sojourner:YYYY-MM-DD`
- `wordchain:daily:YYYY-MM-DD`
- `ps:result:<game>:YYYY-MM-DD:<mode>`

Only keys that genuinely **end** in a real date match. `sojourner:settings`,
`sojourner:seen`, `wordchain:set`, `wordchain:history` and
`wordchain:game:daily` are structurally unmatchable, and a key like
`sojourner:2025-02-30` fails the date round-trip and is left alone rather than
guessed at. There is a test for each of those.

### One `dayKey()`, and it is UTC

Audit §S1 found Sojourner deriving the day from UTC and Word Chain from local
time — ten hours a day where the two games disagreed about what "today" was.
Spec §5 settles it: **days are UTC everywhere**, and the server accepts nothing
else. `PS.dayKey()` is that function.

Word Chain adopting it shifts which chain it serves at the boundary. Either
migrate the existing `wordchain:daily:*` keys or accept one odd day; the audit
says as much.

## Tests

```
node --test test/*.test.js        # 36 tests, no dependencies
```

They cover the offline path, the retry queue (including drop-on-409 and
keep-on-503), the 90-day prune and its exemptions, the UTC day boundary, a
`localStorage` that throws on every call, and that a 500 from every endpoint
resolves rather than throws.
