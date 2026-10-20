/* Sojourner's engine, on the server: the same code the game runs (inlined into
   games/sojourner/src/partD.js), fed the same map data the game loads
   (baked/assets/meta.json + pool.json). The Worker never trusts a score a game
   claims; it replays the moves with this and uses the answer.

   The map is read once and never changes while the Worker runs, so keeping the
   built engine at module level is safe: unlike per-request state, nothing in it
   belongs to any one player.

   If the game's map is ever re-baked, the new meta.json / pool.json ship with
   the game and this Worker has to be redeployed with them. Until it is, results
   from the new game are answered 503 "key_mismatch" (routes/play.js), which the
   game's queue treats as "try again later" rather than as a refusal. */

import Engine from '../../../packages/scoring/sojourner.cjs';
import meta from '../../../games/sojourner/baked/assets/meta.json' with { type: 'json' };
import pool from '../../../games/sojourner/baked/assets/pool.json' with { type: 'json' };

export const MAX_TOTAL = Engine.MAX_TOTAL;

let engine = null;
export function sojournerEngine() {
  if (!engine) engine = Engine.make(Object.assign({}, meta, { pool }));
  return engine;
}
