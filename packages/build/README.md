# packages/build

The small part of the two game builds that is genuinely shared.

Both games are built by a Python script that concatenates hand-written parts
into one HTML file. The two scripts are **not** merged and should not be:
Sojourner's fingerprints its assets, base64-inlines five globe textures and
~250 flag SVGs and cuts detail tiles; Word Chain's inlines one file and wraps
two scripts in a closure. `docs/INTEGRATION-AUDIT.md` ("Duplication worth
extracting") looked at them and concluded the overlap is about four lines.

What *is* shared is everything above the surface's own markup:

| Module | What it owns |
|---|---|
| `head.py` | The `<head>`. The union meta/OG/Twitter/icon tag set, the pre-paint theme script, the union Google Fonts url, and the inlined `tokens.css` / `ui.css` / `ui.js` blocks — **in the one order that does not flash**. |
| `paths.py` | Repo-root discovery, `--src` / `--build` / `--dist` resolution, and the "this input is not in git, here is where to get it" failure. |

## The order, and why it is the whole point

```
<meta charset> <meta viewport> <title>       nothing blocks
<meta description/robots/theme-color>        theme.js needs the theme-color tag to exist
<link canonical> <meta og:*> <meta twitter:*>
<link icon> <link apple-touch-icon>
<script> theme.js + PSTheme.init(surface)    ← BEFORE any stylesheet
<link preconnect> <link fonts stylesheet>    ← render-blocking
<style> tokens.css + ui.css + the surface's own CSS </style>
<script> ui.js </script>                     no pre-paint work
```

An inline script placed *after* a `<link rel=stylesheet>` does not run until
that stylesheet has loaded, and the Google Fonts stylesheet is a third-party
request. Put `theme.js` below it and the page paints in the wrong theme for as
long as fonts.googleapis.com takes to answer. That is the flash the whole
pre-paint mechanism exists to avoid, and it is why this order is a function in
a shared file rather than a convention three surfaces are asked to remember.

## The inlined blocks

`tokens.css`, `theme.js`, `ui.css` and `ui.js` are emitted between the same
`/* ===== BEGIN <path> (inlined verbatim — do not edit here) ===== */` markers
that `packages/tokens/check-inline.mjs` diffs. Emitting them from here means a
new surface gets the canonical bytes by construction; the two existing games
carry their copies inside `partA.html` / `part-a-style.html` (that is where
check-inline pins them) and pass them through as `extra`.

## Using it

```python
import sys, os
sys.path.insert(0, os.path.join(REPO, 'packages'))
from build import head, paths
```

`head.head(...)` with every block enabled emits a complete, correct `<head>`
for a brand-new surface. A surface that already carries some of it turns those
blocks off; `head.py` never emits a tag twice.
