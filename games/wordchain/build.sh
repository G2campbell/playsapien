#!/bin/sh
# Build ONLY Word Chain. Cloudflare: Root directory = games/wordchain.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/games/wordchain"
OUT="$HERE/cfroot"

python3 "$HERE/src/build.py"

rm -rf "$OUT"; mkdir -p "$OUT/wordchain"
cp -R "$HERE/dist/." "$OUT/wordchain/"

# _headers and _redirects are read from the ROOT of the assets directory, and
# their patterns are URL paths — so the file sits at cfroot/_headers while its
# rules still say /wordchain/... This game owns its own rules now; there is no
# shared file to merge into and nothing to keep in step with another game.
[ -f "$OUT/wordchain/_headers.fragment" ]   && mv "$OUT/wordchain/_headers.fragment"   "$OUT/_headers"
[ -f "$OUT/wordchain/_redirects.fragment" ] && mv "$OUT/wordchain/_redirects.fragment" "$OUT/_redirects"

[ -f "$OUT/wordchain/index.html" ] || { echo "FATAL: wordchain/index.html missing"; exit 1; }
echo "word chain built -> $OUT"
