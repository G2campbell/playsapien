#!/bin/sh
# Build ONLY Sojourner. Cloudflare: Root directory = games/sojourner.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/games/sojourner"
OUT="$HERE/cfroot"

# build.py turns source into index.html, app.js and the legal pages. The
# artwork it would normally bake needs ~40 MB of raw data that is not in git,
# so --allow-missing lets it emit everything else and we overlay the finished
# art from baked/ below. That is why this builds from a clean checkout at all.
python3 "$HERE/src/build.py" --allow-missing

rm -rf "$OUT"; mkdir -p "$OUT/sojourner"
cp -R "$HERE/dist/." "$OUT/sojourner/"

# The committed artwork. Overlaid after the build so a real bake, when the raw
# data IS present, wins over it rather than being overwritten by it.
if [ -d "$HERE/baked/assets" ] && [ ! -d "$HERE/dist/assets" ]; then
  cp -R "$HERE/baked/assets" "$OUT/sojourner/assets"
fi
if [ -f "$HERE/baked/three.min.js" ] && [ ! -f "$OUT/sojourner/three.min.js" ]; then
  cp "$HERE/baked/three.min.js" "$OUT/sojourner/three.min.js"
fi

[ -f "$OUT/sojourner/_headers.fragment" ]   && mv "$OUT/sojourner/_headers.fragment"   "$OUT/_headers"
[ -f "$OUT/sojourner/_redirects.fragment" ] && mv "$OUT/sojourner/_redirects.fragment" "$OUT/_redirects"

# Fail loudly rather than deploying a globe-less page over a working one.
[ -f "$OUT/sojourner/index.html" ]   || { echo "FATAL: sojourner/index.html missing"; exit 1; }
[ -f "$OUT/sojourner/three.min.js" ] || { echo "FATAL: three.min.js missing - Sojourner would load with no globe"; exit 1; }
[ -f "$OUT/sojourner/assets/gamedata.json" ] || [ -f "$OUT/sojourner/assets/facts.json" ] || {
  echo "FATAL: baked globe assets missing - see games/sojourner/README.md"; exit 1; }
echo "sojourner built -> $OUT"
