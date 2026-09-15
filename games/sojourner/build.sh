#!/bin/sh
# Build ONLY Sojourner. Cloudflare: Root directory = games/sojourner.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/games/sojourner"
OUT="$HERE/cfroot"

# three.js is pinned to r128 and is not committed; fetch it if absent.
THREE="$HERE/data/three/build"
if [ ! -f "$THREE/three.min.js" ]; then
  mkdir -p "$THREE"
  curl -fsSL -o "$THREE/three.min.js" \
    https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js || true
fi

python3 "$HERE/src/build.py"

rm -rf "$OUT"; mkdir -p "$OUT/sojourner"
cp -R "$HERE/dist/." "$OUT/sojourner/"

[ -f "$OUT/sojourner/_headers.fragment" ]   && mv "$OUT/sojourner/_headers.fragment"   "$OUT/_headers"
[ -f "$OUT/sojourner/_redirects.fragment" ] && mv "$OUT/sojourner/_redirects.fragment" "$OUT/_redirects"

# Fail loudly rather than deploying a globe-less page over a working one.
[ -f "$OUT/sojourner/index.html" ]   || { echo "FATAL: sojourner/index.html missing"; exit 1; }
[ -f "$OUT/sojourner/three.min.js" ] || { echo "FATAL: three.min.js missing - Sojourner would load with no globe"; exit 1; }
[ -f "$OUT/sojourner/assets/gamedata.json" ] || [ -f "$OUT/sojourner/assets/facts.json" ] || {
  echo "FATAL: baked globe assets missing - see games/sojourner/README.md"; exit 1; }
echo "sojourner built -> $OUT"
