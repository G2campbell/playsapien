# Design tokens

One language for three surfaces. `tokens.css` is the source of truth for every
colour; `theme.js` is the source of truth for how the theme is chosen and
applied. Both are **inlined verbatim** into the shell and both games, because
each is a standalone single file with no shared runtime.

| File | What it is |
|---|---|
| `tokens.css` | The role names, and each surface's palette in light and dark. Read its header before changing anything. |
| `theme.js` | Reads `ps:theme`, stamps `data-theme`, keeps `theme-color` in step, follows the OS live. ES5, dependency-free, pre-paint. |
| `paper-tile.png` | 192px seamless cold-press paper grain, cut from a photograph and high-passed so its lighting does not repeat. Inlined as a data URI in the shell. |
| `check-contrast.mjs` | Proves every text token clears 4.5:1 on both grounds, in all six themes. |
| `check-inline.mjs` | Proves every inlined copy still matches the canonical file. |

## After changing a colour

```sh
node packages/tokens/check-contrast.mjs   # 4.5:1 on every ground
python3 - <<'PY'                          # re-sync the three inlined copies
# see the resync snippet in check-inline.mjs's header, or edit by hand
PY
node packages/tokens/check-inline.mjs     # prove the copies match
```

Both run in CI. A drifted copy fails the build, which is the point: without it
two surfaces quietly disagree about what `--accent` means and nobody notices
for a month.

## The one thing to get right

`--ink` and `--paper` are legacy names still used inside the games, and they
mean **opposite things** in the two:

| | Sojourner | Word Chain |
|---|---|---|
| `--ink` | the background | the text |
| `--paper` | the text | the background |

That is why the shared language uses `--bg` and `--fg` instead. Copying an
alias line from one game into the other inverts it.
