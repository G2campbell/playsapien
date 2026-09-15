#!/bin/sh
# Build ONLY the shell. Run by Cloudflare with Root directory = apps/shell.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/apps/shell"
OUT="$HERE/cfroot"

rm -rf "$OUT"; mkdir -p "$OUT"

cp "$HERE/src/index.html"        "$OUT/index.html"
cp "$ROOT/deploy/sdk.js"         "$OUT/sdk.js"
cp "$ROOT/deploy/tokens.css"     "$OUT/tokens.css"
cp "$ROOT/deploy/theme.js"       "$OUT/theme.js"
cp "$ROOT/apps/legal/legal.css"  "$OUT/legal.css"
for p in about privacy terms; do
  mkdir -p "$OUT/$p"
  cp "$ROOT/apps/legal/$p/index.html" "$OUT/$p/index.html"
done

cp "$ROOT/deploy/_headers"   "$OUT/_headers"
cp "$ROOT/deploy/_redirects" "$OUT/_redirects"

for f in index.html sdk.js tokens.css theme.js legal.css about/index.html; do
  [ -f "$OUT/$f" ] || { echo "FATAL: $f missing"; exit 1; }
done
echo "shell built -> $OUT"
