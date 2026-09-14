# Sojourner

A daily five-round geography game on an unlabelled terrain globe.

Live: https://claude.ai/code/artifact/3fc8f180-3ad1-4369-8fc5-6e493ed47d39

## Files

- `sojourner-cloudflare.zip` — the website, split into small files that load on demand.
  This is what you upload to Cloudflare Pages. See DEPLOY.md.
- `sojourner.html` — the older all-in-one version. One self-contained file: terrain texture, region ID
  map, all borders and all 322 facts are embedded. Double-click to play offline; the only
  external request is three.js from cdnjs (and Google Fonts). Host it anywhere static.
- `sojourner-source.zip` — the build pipeline and data.

## Inside the zip

`src/`
- `group.py` — reads Natural Earth 10m admin-1, dissolves over-granular countries
  (UK to its four nations, France to régions, Italy to regioni, and so on) into 2,617
  selectable regions.
- `pooldef.py` / `buildpool.py` — the 322-location pool and its round tiers.
  Edit `pooldef.py` to change which places appear or how countries are ranked.
- `geo.py` — border vectors. Quantises to 0.01°, dedupes shared edges so each border
  is drawn once, tags every line with the two regions it separates, simplifies, encodes.
- `raster.py` — the 4096×2048 region-ID map used for hit-testing and region fills.
- `terrain.py` — the terrain texture: hypsometric tint plus hillshade, over a water mask.
- `assemble.py` — merges geometry, pool and facts into `gamedata.json`.
- `partA.html` (styles), `partB.html` (markup), `partC.js` (globe + picking),
  `partD.js` (game logic), `build.py` — concatenates them into `meridian.html`.

`data/`
- `gamedata.json`, `pool.json`, `terrain.jpg`, `idmap.png`, `facts/*.json`

## The name

Named for Sojourner Truth, who was born Isabella Baumfree and renamed herself in 1843 —
Sojourner because she was to travel up and down the land, Truth because she was to declare
it (Library of Congress: loc.gov/exhibits/odyssey/educate/truth.html). NASA's 1997 Mars
rover carried the same name, chosen through a student essay contest. An about page giving
her more than one line is still to be written.

## How the hosted build loads

The page appears in about 5 KB. It then pulls, in order: the app and three.js, the region
list, country borders and a 2048px globe (about 420 KB gzipped, at which point you can
play), then a 4096px globe, the province and coast borders and the picking map in the
background. High-resolution relief is cut into 128 tiles; only the ~16 under your view are
fetched, and only once you zoom in. The five stories are a separate 56 KB file that is
fetched only if you open them.

`src/pack.py` generates the tiles and split data; `src/build.py` emits both the hosted
build (`dist/`) and the single-file version.

## Rebuilding

    python3 src/build.py

Regenerating the geometry needs Natural Earth's `ne_10m_admin_1_states_provinces.geojson`
(github.com/nvkelso/natural-earth-vector) and the elevation/water textures from
github.com/vasturiano/three-globe.

## Rules as built

- Round 1: a U.S. state. Rounds 2–4: a province or region, drawn from 81 countries tiered
  by prominence. Round 5: an African country or a very small country.
- Each round has a shape: circle, square, diamond, hexagon, star — and a multiplier of
  1, 1.5, 2, 2.5, 3. Max 1000. The shape row and running total sit in the top bar.
- Score = 100 if you pick the right region or land within 150 km, otherwise
  `100 · e^-(d-150)/1600` where d is the distance, times the round multiplier.
- A guess inside the right country has its distance beyond 150 km discounted by 30%
  before scoring. Same distance always beats an out-of-country guess (by 1–14 points,
  most around 1,000–3,000 km); an out-of-country guess must be roughly 30% closer to
  match. Constants live at the top of the scoring block in `src/partD.js`.
- Distance is measured centroid-to-centroid, so the same guess always scores the same.
- The daily set is seeded from the UTC date. Practice mode reshuffles and is not saved.
- After the fifth round, "Visit the five places" flies the globe to each location in turn
  and shows its sourced story beneath it.
