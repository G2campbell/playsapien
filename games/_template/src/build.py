#!/usr/bin/env python3
"""Build the template game.

Copy this file with the rest of src/ when you start a new game; the only lines
that change are the constants at the top. Everything about the <head> -- the
meta and OG tags, the pre-paint theme script, the union fonts url, and the
inlined tokens.css / ui.css / theme.js / ui.js -- comes from packages/build.

    python3 games/_template/src/build.py            # -> games/_template/dist/
    python3 games/_template/src/build.py --check    # validate, write nothing
"""
import argparse, os, shutil, sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))
from packages.build import head as H
from packages.build import paths as P

# --------------------------------------------------------------------------- #
# the only lines a new game changes
SLUG    = 'template'
SURFACE = 'tp-game'                       # the class in packages/tokens/tokens.css
TITLE   = 'New Game'
DESC    = 'One line that says what the player does.'
SITE    = 'https://playsapien.com/' + SLUG
# --------------------------------------------------------------------------- #


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    P.add_path_args(ap, build=False)   # gives --src/--dist/--check and their env vars
    ap.add_argument('--site', default=os.environ.get('SITE', SITE))
    a = ap.parse_args(argv)

    here = os.path.dirname(os.path.abspath(__file__))
    src  = P.resolve(here, a.src, 'SRC')
    dist = P.resolve(os.path.join(here, '..', 'dist'), a.dist, 'DIST')

    partA = P.require(os.path.join(src, 'partA.html'), "the game's CSS")
    partB = P.require(os.path.join(src, 'partB.html'), "the game's markup")
    appjs = P.require(os.path.join(src, 'app.js'),     "the game's logic")

    css = open(partA, encoding='utf-8').read()
    # partA carries its own <style> wrapper so it is readable on its own; the
    # head builder emits one <style> for everything, so unwrap it here.
    if '<style>' in css:
        css = css[css.index('<style>') + 7: css.rindex('</style>')]

    page = (
        '<!doctype html>\n<html lang="en" class="' + SURFACE + '">\n'
        + H.head(SURFACE, site=a.site, title=TITLE, description=DESC,
                 ui_css=True, ui_js=True, css=css, wrap=True)
        + '<body>\n'
        + open(partB, encoding='utf-8').read()
        + '\n<script type="module">\n' + open(appjs, encoding='utf-8').read() + '</script>\n'
        + '</body>\n</html>\n'
    )

    if a.check:
        assert '<html' in page and '</html>' in page
        assert page.index('PSTheme.init') < page.index('fonts.googleapis.com'), \
            'the theme script must come before the font stylesheet or the page flashes'
        print('template: ok, %d KB would be written' % (len(page.encode()) // 1024))
        return 0

    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, 'index.html')
    open(out, 'w', encoding='utf-8').write(page)
    print('template -> %s (%d KB)' % (out, os.path.getsize(out) // 1024))
    return 0


if __name__ == '__main__':
    P.run(main)
