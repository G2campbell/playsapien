/* Parse tokens.css and prove every text token is legible on the ground it sits
   on. Run after changing any value in tokens.css; it runs in CI too.

       node packages/tokens/check-contrast.mjs

   Exits non-zero on any failure, so it can gate a merge.

   `--accent-soft` is exempt by name: it is a fill (a tinted panel, a progress
   track, a chip), never text. Everything else in the text group must clear
   4.5:1 — WCAG AA for body copy — against both `--bg` and `--bg-raise`, since
   a sheet is where most text actually lives. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'tokens.css'), 'utf8');

/* ---------------------------------------------------------------- colour -- */
const srgb = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function luminance(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c) : h.match(/../g);
  const [r, g, b] = n.map((p) => srgb(parseInt(p, 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------ parse css --- */
/* Strip comments first: a hex inside prose (there are several) is not a token. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

/* Each selector block becomes one theme. Nested @media blocks are flattened by
   matching selector-then-body, which is enough for this file's shape. */
const blocks = [];
const re = /([.#:][^{}]*?)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(bare))) {
  const selector = m[1].trim().replace(/\s+/g, ' ');
  const body = m[2];
  const vars = {};
  for (const d of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[d[1]] = d[2].trim();
  }
  if (Object.keys(vars).length) blocks.push({ selector, vars });
}

/* Collapse into one entry per (surface, theme), light inherited by dark. */
const SURFACES = { '.ps-shell': 'PlaySapien shell', '.sj-game': 'Sojourner', '.wc-game': 'Word Chain' };
const themes = new Map();
for (const { selector, vars } of blocks) {
  for (const [cls, name] of Object.entries(SURFACES)) {
    if (!selector.includes(cls)) continue;
    const dark = selector.includes('dark') || selector.includes(':not([data-theme="light"])');
    const key = `${name}|${dark ? 'dark' : 'light'}`;
    const cur = themes.get(key) || { surface: name, theme: dark ? 'dark' : 'light', vars: {} };
    Object.assign(cur.vars, vars);
    themes.set(key, cur);
  }
}
/* A dark block only overrides; anything it does not mention comes from light. */
for (const [key, t] of themes) {
  if (t.theme !== 'dark') continue;
  const light = themes.get(`${t.surface}|light`);
  if (light) t.vars = { ...light.vars, ...t.vars };
}

/* ------------------------------------------------------------- the rules -- */
const TEXT = ['--fg', '--fg-2', '--fg-3', '--accent', '--good', '--warn'];
const GROUNDS = ['--bg', '--bg-raise'];
const AA = 4.5;
const EXEMPT = new Set(['--accent-soft']);

let failures = 0, checks = 0;
const order = ['PlaySapien shell', 'Sojourner', 'Word Chain'];
const sorted = [...themes.values()].sort(
  (a, b) => order.indexOf(a.surface) - order.indexOf(b.surface) || a.theme.localeCompare(b.theme)
);

for (const t of sorted) {
  console.log(`\n${t.surface} — ${t.theme}   ground ${t.vars['--bg']}  raised ${t.vars['--bg-raise']}`);
  for (const fgName of TEXT) {
    const fg = t.vars[fgName];
    if (!fg || !fg.startsWith('#')) continue;
    for (const bgName of GROUNDS) {
      const bg = t.vars[bgName];
      if (!bg || !bg.startsWith('#')) continue;
      const r = ratio(fg, bg);
      checks++;
      const ok = r >= AA;
      if (!ok) failures++;
      console.log(
        `  ${(fgName + ' on ' + bgName).padEnd(26)} ${fg} / ${bg}  ${r.toFixed(2).padStart(5)}  ${ok ? 'OK' : '*** FAIL (need ' + AA + ') ***'}`
      );
    }
  }
  /* --fg-on-accent is the one pair that is checked against --accent, not a ground. */
  const foa = t.vars['--fg-on-accent'], acc = t.vars['--accent'];
  if (foa && acc && foa.startsWith('#') && acc.startsWith('#')) {
    const r = ratio(foa, acc);
    checks++;
    const ok = r >= AA;
    if (!ok) failures++;
    console.log(`  ${'--fg-on-accent on --accent'.padEnd(26)} ${foa} / ${acc}  ${r.toFixed(2).padStart(5)}  ${ok ? 'OK' : '*** FAIL ***'}`);
  }
  /* Report the fills so a human can eyeball them, but do not gate on them. */
  for (const name of EXEMPT) {
    const v = t.vars[name];
    if (v && v.startsWith('#')) {
      console.log(`  ${(name + ' (fill, not gated)').padEnd(26)} ${v} / ${t.vars['--bg']}  ${ratio(v, t.vars['--bg']).toFixed(2).padStart(5)}`);
    }
  }
}

/* Every surface must define every role, or a component moved between them
   silently loses a colour. */
const REQUIRED = [
  '--bg', '--bg-raise', '--bg-sink', '--bg-edge',
  '--fg', '--fg-2', '--fg-3', '--fg-on-accent',
  '--line', '--line-2',
  '--accent', '--accent-soft', '--good', '--warn',
  '--shadow', '--scrim', '--texture-ink', '--texture-alpha',
];
console.log('\nRole completeness');
for (const t of sorted) {
  const missing = REQUIRED.filter((r) => !(r in t.vars));
  if (missing.length) { failures++; console.log(`  ${t.surface} ${t.theme}: MISSING ${missing.join(', ')}`); }
  else console.log(`  ${t.surface} ${t.theme}: all ${REQUIRED.length} roles present`);
}

console.log(`\n${checks} contrast checks across ${sorted.length} themes — ${failures ? failures + ' FAILURE(S)' : 'all pass'}`);
process.exit(failures ? 1 : 0);
