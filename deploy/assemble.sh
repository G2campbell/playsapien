#!/bin/sh
# Assemble the deployable root for playsapien.com.
#
#   playsapien.com/            apps/shell
#   playsapien.com/about/      apps/legal/about        (audit B5)
#   playsapien.com/privacy/    apps/legal/privacy
#   playsapien.com/terms/      apps/legal/terms
#   playsapien.com/sojourner/  games/sojourner dist
#   playsapien.com/wordchain/  games/wordchain dist
#
# The per-game builds emit _headers.fragment / _redirects.fragment already
# prefixed with their own path (audit B2); this script concatenates them onto
# the platform rules in deploy/_headers and deploy/_redirects, because
# Cloudflare Pages honours exactly one of each and only at the root.
#
# Audit S8 is closed: both builds run from the checkout and write into
# games/<game>/dist. Build them first --
#
#   python3 games/wordchain/src/build.py
#   python3 games/sojourner/src/build.py        # needs the baked globe; see its README
#
# SOJOURNER_DIST / WORDCHAIN_DIST still override, for a dist built elsewhere.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-"$ROOT/dist"}
SOJOURNER_DIST=${SOJOURNER_DIST:-"$ROOT/games/sojourner/dist"}
WORDCHAIN_DIST=${WORDCHAIN_DIST:-"$ROOT/games/wordchain/dist"}

rm -rf "$OUT"; mkdir -p "$OUT"

cp "$ROOT/apps/shell/src/index.html" "$OUT/index.html"

# The three files every surface loads from the platform root. The shell asks
# for /sdk.js as a module; the legal pages link /tokens.css and /theme.js.
# Leaving these out is silent: the site builds, deploys, and then 404s on all
# three, which renders the legal pages unstyled and the account layer inert.
cp "$ROOT/deploy/sdk.js"            "$OUT/sdk.js"
cp "$ROOT/deploy/tokens.css"        "$OUT/tokens.css"
cp "$ROOT/deploy/theme.js"          "$OUT/theme.js"

cp "$ROOT/apps/legal/legal.css" "$OUT/legal.css"
for p in about privacy terms; do
  mkdir -p "$OUT/$p"
  cp "$ROOT/apps/legal/$p/index.html" "$OUT/$p/index.html"
done

[ -d "$SOJOURNER_DIST" ] && cp -R "$SOJOURNER_DIST" "$OUT/sojourner"
[ -d "$WORDCHAIN_DIST" ] && cp -R "$WORDCHAIN_DIST" "$OUT/wordchain"

# one _headers and one _redirects, at the root, or they do nothing at all
cp "$ROOT/deploy/_headers"   "$OUT/_headers"
cp "$ROOT/deploy/_redirects" "$OUT/_redirects"
for g in sojourner wordchain; do
  if [ -f "$OUT/$g/_headers.fragment" ]; then
    printf '\n' >> "$OUT/_headers"; cat "$OUT/$g/_headers.fragment" >> "$OUT/_headers"
    rm -f "$OUT/$g/_headers.fragment"
  fi
  if [ -f "$OUT/$g/_redirects.fragment" ]; then
    printf '\n' >> "$OUT/_redirects"; cat "$OUT/$g/_redirects.fragment" >> "$OUT/_redirects"
    rm -f "$OUT/$g/_redirects.fragment"
  fi
done

echo "assembled $OUT"
echo "verify after deploy:  curl -I https://playsapien.com/sojourner   # must be 301"
