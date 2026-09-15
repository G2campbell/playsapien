#!/bin/sh
# The build Cloudflare runs. One command, from a clean checkout, to dist/.
#
#   sh deploy/build.sh
#
# Cloudflare's build image ships Python 3.13 and Node 24, so both game builds
# run there unchanged. Everything this script needs beyond the checkout is
# fetched here rather than assumed present.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

echo "--- three.js (not vendored; pinned to the revision the page expects)"
THREE_DIR="$ROOT/games/sojourner/data/three/build"
if [ ! -f "$THREE_DIR/three.min.js" ]; then
  mkdir -p "$THREE_DIR"
  # r128 exactly: Sojourner's globe code is written against that API.
  curl -fsSL -o "$THREE_DIR/three.min.js" \
    https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js \
    || echo "    could not fetch three.js — Sojourner will build without it"
fi

echo "--- word chain"
python3 games/wordchain/src/build.py

echo "--- sojourner"
# --allow-missing: the baked globe (~40 MB) is not in git, so on Cloudflare this
# emits the page, the legal pages and the deploy fragments but not a playable
# globe, and warns instead of failing the whole site's build. Commit the baked
# assets, or deploy /sojourner/ separately, to make this a real build.
python3 games/sojourner/src/build.py --allow-missing

echo "--- assemble"
sh deploy/assemble.sh

echo "--- what got built"
ls -a dist/
for f in index.html sdk.js tokens.css theme.js legal.css _headers _redirects; do
  [ -f "dist/$f" ] || { echo "FATAL: dist/$f missing"; exit 1; }
done
echo "ok"
