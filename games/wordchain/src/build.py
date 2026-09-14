import json, io, os
os.makedirs('dist', exist_ok=True)

# Where the hosted copy will live. Open Graph needs an ABSOLUTE url for the preview
# image, so this has to match the real address. One line to change if it moves.
SITE = 'https://playsapien.com/wordchain'
# The artifact build is reachable at its own address, so it shares that one instead.
ARTIFACT = 'https://claude.ai/code/artifact/f46ebfe8-425c-4f1a-be86-a722137cd265'

data = json.load(open('gamedata.json'))
# trim chain payload to what the page needs
slim = {"lex": data["lex"], "chains": [
    {"level": c["level"], "words": c["words"],
     "links": [{"numberStrict": l["numberStrict"], "alt": l["alt"]} for l in c["links"]]}
    for c in data["chains"]]}
words = open('dict.txt').read().split('\n')
words = [w for w in words if 2 <= len(w) <= 18]

style = io.open('part-a-style.html', encoding='utf-8').read()
body  = io.open('part-b-body.html',  encoding='utf-8').read()
app   = io.open('part-c-app.js',     encoding='utf-8').read()
app  += io.open('composer.js',       encoding='utf-8').read()

# Audit B7. Unwrapped, these two files put ~107 declarations on `window` --
# `$`, `S`, `SET`, `DATA`, `SITE`, `store`, `drop`, `toast`, `save`, `finish`,
# `pick`, `hit` and ninety more -- which collide the moment anything else shares
# the document. They are already concatenated here, so ONE wrapper around the
# concatenation closes the whole category; wrapping each file separately would
# instead break composer.js, which reads part-c-app.js's scope and vice versa.
#
# Two things this wrapper is careful about:
#   * `var C` in composer.js still hoists to the top of the shared closure, so
#     part-c-app.js's `typeof C !== 'undefined'` guards (lines 468, 760) keep
#     working exactly as they did against the global object.
#   * No 'use strict'. The point is the namespace, not a semantics change, and
#     strict mode would turn any latent implicit-global assignment into a throw.
# Nothing in the HTML uses an inline on* handler, so nothing outside this
# closure needs to reach in. Checked before wrapping.
app = '(function(){\n' + app + '\n})();\n'

def boot_for(site):
  return (
 '<script id="wcdict" type="text/plain">' + "\n".join(words) + '</script>\n'
 '<script>\n'
 'window.__WC_SITE__=' + json.dumps(site) + ';\n'
 'window.__WC_DATA__=' + json.dumps(slim, separators=(",", ":")) + ';\n'
 'window.__WC_DICT__=new Set(document.getElementById("wcdict").textContent.split("\\n").map(function(w){return w.toUpperCase();}));\n'
 '</script>\n'
)

_unused = (
 '<script id="wcdict" type="text/plain">' + "\n".join(words) + '</script>\n'
 '<script>\n'
 'window.__WC_DATA__=' + json.dumps(slim, separators=(",", ":")) + ';\n'
 'window.__WC_DICT__=new Set(document.getElementById("wcdict").textContent.split("\\n").map(function(w){return w.toUpperCase();}));\n'
 '</script>\n'
)
inner = style + "\n" + body + "\n" + boot_for(ARTIFACT) + "<script>\n" + app + "\n</script>\n"

io.open('artifact.html', 'w', encoding='utf-8').write(inner)

ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'"
        "%3E%3Crect width='24' height='24' rx='5' fill='%23D4B072'/%3E%3Cg fill='none'"
        " stroke='%231F1A14' stroke-width='1.9' stroke-linecap='round'%3E"
        "%3Cpath d='M10.4 13.6a4.6 4.6 0 0 0 6.94.5l2.76-2.76a4.6 4.6 0 0 0-6.5-6.5l-1.58 1.57'/%3E"
        "%3Cpath d='M13.6 10.4a4.6 4.6 0 0 0-6.94-.5L3.9 12.66a4.6 4.6 0 0 0 6.5 6.5l1.57-1.57'/%3E"
        "%3C/g%3E%3C/svg%3E")

head = (
  '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  '<meta name="description" content="Eight words, every neighbouring pair a compound. '
  'First letters only. The clock is the score.">'
  '<meta name="theme-color" content="#D4B072" media="(prefers-color-scheme: light)">'
  '<meta name="theme-color" content="#0C0B0A" media="(prefers-color-scheme: dark)">'
  '<meta property="og:type" content="website">'
  '<meta property="og:url" content="' + SITE + '/">'
  '<meta property="og:image" content="' + SITE + '/og.png">'
  '<meta property="og:image:width" content="1200">'
  '<meta property="og:image:height" content="630">'
  '<meta property="og:image:alt" content="Word Chain">'
  '<meta property="og:site_name" content="Word Chain">'
  '<meta name="twitter:card" content="summary_large_image">'
  '<meta name="twitter:title" content="Word Chain">'
  '<meta name="twitter:description" content="Eight words, every neighbouring pair a compound. '
  'First letters only. The clock is the score.">'
  '<meta name="twitter:image" content="' + SITE + '/og.png">'
  '<meta property="og:title" content="Word Chain">'
  '<meta property="og:description" content="Eight words, every neighbouring pair a compound. '
  'First letters only. The clock is the score.">'
  '<meta name="apple-mobile-web-app-capable" content="yes">'
  '<link rel="icon" href="' + ICON + '">'
  '<link rel="apple-touch-icon" href="icon-512.png">'
  + style + '</head><body style="margin:0">')

full = head + body + "\n" + boot_for(SITE) + "<script>\n" + app + "\n</script></body></html>"

io.open('wordchain.html', 'w', encoding='utf-8').write(full)

io.open('dist/index.html', 'w', encoding='utf-8').write(full)

for f in ('artifact.html', 'wordchain.html', 'dist/index.html'):
    print(f, round(os.path.getsize(f)/1024, 1), 'KB')
