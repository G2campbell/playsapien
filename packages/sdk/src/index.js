/* PlaySapien SDK — the one client both games and the shell talk to.
   Dependency-free ES module. See README.md for the five-line integration. */

export { createClient } from './client.js';
export { dayKey, dayMs, daysSince, prevDay } from './daykey.js';
export { makeStore, pruneOldDays, dayPartOf, KEYS, PS_PREFIX } from './storage.js';

import { createClient } from './client.js';

/** The shared instance. One per document; call PS.init() once, early. */
export const PS = createClient();
export default PS;
