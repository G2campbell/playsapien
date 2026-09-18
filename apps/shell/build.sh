#!/bin/sh
# Build ONLY the shell. Run by Cloudflare with Root directory = apps/shell.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/apps/shell"
OUT="$HERE/cfroot"

rm -rf "$OUT"; mkdir -p "$OUT"

cp "$HERE/src/index.html"        "$OUT/index.html"
cp "$ROOT/deploy/sdk.js"         "$OUT/sdk.js"
# tokens.css and theme.js come from packages/tokens, NOT from deploy/. The copies
# in deploy/ went stale twice -- silently, because nothing compares them -- and
# the legal pages link these, so they drifted from the rest of the site. One
# source, no copy to forget.
cp "$ROOT/packages/tokens/tokens.css" "$OUT/tokens.css"
cp "$ROOT/packages/tokens/theme.js"   "$OUT/theme.js"
# The mark. Two variants because the emboss ring is paper-coloured: kept on
# the light ground where it reads as depth, dropped on the dark one where it
# would read as a halo. CSS picks by theme.
# The link-preview card, 1200x630. Served from the site root because og:image
# names it absolutely at https://playsapien.com/og.png -- move the file and the
# card silently loses its picture in every chat app, with nothing on the site
# itself looking any different.
cp "$HERE/src/og.png"            "$OUT/og.png"
cp "$HERE/src/makers.jpg"        "$OUT/makers.jpg"
cp "$HERE/src/mark-light.png"    "$OUT/mark-light.png"
cp "$HERE/src/mark-dark.png"     "$OUT/mark-dark.png"

cp "$ROOT/apps/legal/legal.css"  "$OUT/legal.css"
for p in about privacy terms; do
  mkdir -p "$OUT/$p"
  cp "$ROOT/apps/legal/$p/index.html" "$OUT/$p/index.html"
done

cp "$ROOT/deploy/_headers"   "$OUT/_headers"
cp "$ROOT/deploy/_redirects" "$OUT/_redirects"

for f in index.html sdk.js tokens.css theme.js legal.css og.png makers.jpg mark-light.png mark-dark.png about/index.html; do
  [ -f "$OUT/$f" ] || { echo "FATAL: $f missing"; exit 1; }
done
echo "shell built -> $OUT"
