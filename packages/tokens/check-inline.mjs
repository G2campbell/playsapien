/* The shell and both games inline tokens.css and theme.js verbatim, because
   each is a standalone file with no shared runtime. That is fine right up until
   a copy drifts, at which point two surfaces disagree about what --accent means
   and nobody notices for a month. This diffs every copy against the canonical
   file and fails if any byte differs.

       node packages/tokens/check-inline.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  'tokens.css': 'packages/tokens/tokens.css',
  'theme.js':   'packages/tokens/theme.js',
  'ui.css':     'packages/ui/ui.css',
  'ui.js':      'packages/ui/ui.js',
};
/* Markup shared verbatim, not CSS or JS, so the markers are HTML comments.
   The bar is the only one so far. It goes into the BODY of each surface, which
   is a different file from the one that holds the styles. */
const HTML_SOURCES = {
  'bar.html': 'packages/ui/bar.html',
};
const HTML_TARGETS = [
  'apps/shell/src/index.html',
  'games/sojourner/src/partB.html',
  'games/wordchain/src/part-b-body.html',
];
const TARGETS = [
  'apps/shell/src/index.html',
  'games/sojourner/src/partA.html',
  'games/wordchain/src/part-a-style.html',
];

let bad = 0, checked = 0;
for (const target of TARGETS) {
  const file = path.join(ROOT, target);
  if (!fs.existsSync(file)) { console.log(`  ${target}: NOT FOUND`); bad++; continue; }
  const html = fs.readFileSync(file, 'utf8');
  for (const [name, rel] of Object.entries(SOURCES)) {
    const canonical = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const begin = `/* ===== BEGIN ${rel} (inlined verbatim — do not edit here) ===== */\n`;
    const end = `/* ===== END ${rel} ===== */`;
    const i = html.indexOf(begin);
    const j = html.indexOf(end);
    if (i < 0 || j < 0) { console.log(`  ${target} :: ${name}  markers missing (not adopted yet)`); continue; }
    const inlined = html.slice(i + begin.length, j);
    checked++;
    if (inlined === canonical) {
      console.log(`  ${target} :: ${name}  identical (${canonical.length} bytes)`);
    } else {
      bad++;
      // say WHERE, so the fix is obvious rather than a hunt
      let k = 0; while (k < Math.min(inlined.length, canonical.length) && inlined[k] === canonical[k]) k++;
      const line = canonical.slice(0, k).split('\n').length;
      console.log(`  ${target} :: ${name}  *** DRIFTED *** first difference at line ${line} ` +
                  `(inlined ${inlined.length} bytes vs canonical ${canonical.length})`);
    }
  }
}

for (const target of HTML_TARGETS) {
  const file = path.join(ROOT, target);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  for (const [name, rel] of Object.entries(HTML_SOURCES)) {
    const canonical = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const begin = `<!-- ===== BEGIN ${rel} (inlined verbatim — do not edit here) ===== -->\n`;
    const end = `<!-- ===== END ${rel} ===== -->`;
    const i = html.indexOf(begin), j = html.indexOf(end);
    if (i < 0 || j < 0) continue;
    checked++;
    const got = html.slice(i + begin.length, j);
    if (got === canonical) { console.log(`  ${target} :: ${name}  identical (${canonical.length} bytes)`); }
    else { bad++; console.log(`  ${target} :: ${name}  *** DRIFTED ***`); }
  }
}

console.log(`\n${checked} inlined copies checked — ${bad ? bad + ' PROBLEM(S)' : 'all in sync'}`);
process.exit(bad ? 1 : 0);
