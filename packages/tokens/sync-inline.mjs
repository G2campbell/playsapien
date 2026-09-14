/* Re-inline the canonical shared files into every surface. Run after editing
   anything in packages/tokens/ or packages/ui/, then run check-inline.mjs.
   A surface that has not adopted a file yet (no markers) is skipped. */
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
const TARGETS = [
  'apps/shell/src/index.html',
  'games/sojourner/src/partA.html',
  'games/wordchain/src/part-a-style.html',
];

for (const target of TARGETS) {
  const file = path.join(ROOT, target);
  if (!fs.existsSync(file)) continue;
  let html = fs.readFileSync(file, 'utf8');
  const done = [];
  for (const [name, rel] of Object.entries(SOURCES)) {
    const canonical = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const begin = `/* ===== BEGIN ${rel} (inlined verbatim — do not edit here) ===== */\n`;
    const end = `/* ===== END ${rel} ===== */`;
    const i = html.indexOf(begin), j = html.indexOf(end);
    if (i < 0 || j < 0) continue;
    if (html.slice(i + begin.length, j) !== canonical) {
      html = html.slice(0, i + begin.length) + canonical + html.slice(j);
      done.push(name);
    }
  }
  if (done.length) { fs.writeFileSync(file, html); console.log(`  ${target}: re-synced ${done.join(', ')}`); }
  else console.log(`  ${target}: already in sync`);
}
