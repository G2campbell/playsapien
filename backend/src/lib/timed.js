/* The rules for a timed friend challenge, with no database in them.

   Two players get the same chain and play it separately; the faster time wins. Each time is
   the game's own clock (playing time, stopped while paused or away, so a phone call never
   costs anyone anything) plus the Lifeline penalty the server worked out itself from how the
   chain was solved -- the same arrangement as the daily (lib/wordchain.js).

   The server's part is to keep that clock honest, with the moment each player first opened
   the chain:
     - a player cannot have played for LONGER than the time that passed since they opened it
       (a claim above that is brought down to it);
     - and not for under ten seconds, which seven words cannot be typed in (refused);
     - nor more than two hours of actual play (refused).
   Like the daily, it cannot catch a player who claims LESS than they played: the chain is
   in front of them, and the other player is a friend. That is a choice, not an oversight. */

export const MIN_MS = 10_000;
export const MAX_PLAY_MS = 2 * 3600 * 1000;

/* Who was faster. Times that read the same to the second -- which is all a player is shown --
   are a draw. Returns 'a', 'b' or 'draw'. */
export function judge(aMs, bMs) {
  const a = Math.floor(aMs / 1000), b = Math.floor(bMs / 1000);
  return a === b ? 'draw' : a < b ? 'a' : 'b';
}

/* The playing time to use, or { error }. `baseMs` is what the game's clock showed (penalty
   not included); `startedSec` when the player first opened the chain; `nowSec` is now. */
export function checkPlay({ baseMs, startedSec, nowSec }) {
  const wall = (nowSec - startedSec) * 1000;
  if (wall < MIN_MS || baseMs < MIN_MS) return { error: 'too_fast' };
  if (baseMs > MAX_PLAY_MS) return { error: 'too_long' };
  return { baseMs: Math.min(baseMs, wall) };
}
