# Baked globe art

This is Sojourner's finished artwork, committed so the game deploys from a
clean checkout like every other surface.

It is **output**, not source. The pipeline in `../src` turns ~40 MB of raw
elevation and border data into what is here; that raw data stays out of git
(see `.gitignore`) because it is large, public, and re-downloadable. What is
here is small enough to keep — 13 MB across 438 files, largest just over 1 MB,
comfortably inside Cloudflare's 25 MiB per-file limit.

    assets/        terrain and style textures, border geometry, the region id
                   map, facts.json, and the flag SVGs
    three.min.js   three.js r128 exactly — the globe code is written against
                   that API and will break on a newer one

Regenerate only when the globe itself changes. `games/sojourner/README.md` has
the pipeline. After regenerating, copy the new `dist/assets` and
`dist/three.min.js` here and commit.
