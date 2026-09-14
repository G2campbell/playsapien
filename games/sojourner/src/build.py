#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build Sojourner: the hosted dist/, the legal pages, and the single-file preview.

    python3 games/sojourner/src/build.py           # -> games/sojourner/dist/
    python3 games/sojourner/src/build.py --check   # validate, write nothing

Audit S8. Every path in here used to be an absolute /tmp constant, so the build
ran on exactly one machine and could not be put in CI. They are now repo-relative
defaults, each overridable:

    --src DIR   / $SRC     hand-written sources        (default: beside this file)
    --build DIR / $BUILD   generated/downloaded inputs (default: games/sojourner/data)
    --dist DIR  / $DIST    hosted output               (default: games/sojourner/dist)
    --single DIR/ $SINGLE  one-file builds             (default: games/sojourner/preview)
    --flags DIR / $FLAGS   country flag SVGs           (default: <build>/flags)
    --three F   / $THREE   three.min.js                (default: <build>/three/build/three.min.js)

WHAT IS AND IS NOT IN GIT

The sources, the legal page bodies and the shared packages are checked in, so
the hosted index.html, the legal pages and the deploy fragments always build.

The baked globe -- terrain, the region id map, the detail layer, five alternate
styles, ~250 flag SVGs, the emblem and the select sound -- is about 40 MB of
generated binary and is NOT in git (see .gitignore). Nor is three.js. Without
them the single-file preview cannot be made and dist/ has no playable globe in
it; this script says exactly which input is missing and where it comes from,
builds everything that does not depend on it, and exits 2. It does not
traceback and it does not silently emit a broken page.
"""

import argparse
import base64
import glob
import hashlib
import json
import os
import re
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _find_repo(d):
    while True:
        if os.path.exists(os.path.join(d, 'packages', 'tokens', 'tokens.css')):
            return d
        p = os.path.dirname(d)
        if p == d:
            sys.exit('build.py: not inside a PlaySapien checkout (looked up from %s)' % _HERE)
        d = p


REPO = _find_repo(_HERE)
sys.path.insert(0, os.path.join(REPO, 'packages'))
from build import head as psh          # noqa: E402
from build import paths as pspaths     # noqa: E402


# --------------------------------------------------------------------------- #
# what the page says about itself

SITE_DEFAULT = 'https://playsapien.com/sojourner'
TITLE = 'Sojourner \u2014 a game of geography'
BLURB = ('Five places a day. Find them on a bare globe, '
         'then read the story that place has to tell.')
DESCRIPTION = ('A daily geography game. Five places, a bare globe, '
               'and a story for every place you find.')

CDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>\n'

STYLE_IDS = ('nasa1', 'nasa2', 'mgreen', 'mblue', 'natural')

# Where the inputs that cannot live in git come from. Named in the failure, so
# nobody has to read this file to find out.
GLOBE_HINT = (
    'the baked globe is generated, not committed (~40 MB). Regenerate it with the '
    'pipeline in this directory -- terrain.py, raster.py, geo.py, assemble.py, pack.py '
    '-- which needs Natural Earth 10m admin-1 (github.com/nvkelso/natural-earth-vector) '
    'and the elevation/water textures from github.com/vasturiano/three-globe. See '
    'games/sojourner/README.md. Point --build at wherever it was written.')
THREE_HINT = (
    'three.js r128, the build the page is pinned to. Download '
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js, or unpack a '
    'three.js r128 release so that <dir>/build/three.min.js exists, and pass --three '
    '(or $THREE).')
FLAGS_HINT = (
    'the 4x3 country flag SVGs (github.com/hjnilsson/country-flags). Unpack them so '
    'that <dir>/4x3/<cc>.svg exists and pass --flags (or $FLAGS).')


# --------------------------------------------------------------------------- #

def read(path, what, hint=None):
    pspaths.require(path, what, hint)
    return open(path, encoding='utf-8').read()


def flag_dir(flags):
    """Accept either <flags>/4x3 or the <flags>/flags/4x3 an unzip tends to produce."""
    for d in (flags + '4x3', flags + 'flags' + os.sep + '4x3'):
        if os.path.isdir(d):
            return d + os.sep
    raise pspaths.MissingInput('the flag SVGs', 'neither %s4x3 nor %sflags/4x3 exists'
                               % (flags, flags), FLAGS_HINT)


# --------------------------------------------------------------------------- #
# 1. the single file (the shareable preview)

def single_file(src, build, flags, three, A, B, C, D, url, site_js):
    """Everything baked into one HTML file. Needs every generated input there is."""
    b = lambda n: build + n                                          # noqa: E731
    for need in ('gamedata.json', 'terrain.b64', 'idmap.b64', 'detail.b64',
                 'select.mp3', 'emblem.png', 'flagmap.json', 'adm2cc.json'):
        pspaths.require(b(need), 'the baked globe (%s)' % need, GLOBE_HINT)
    for sid in STYLE_IDS:
        pspaths.require(b('styles/%s-z1.jpg' % sid),
                        'the alternate globe styles (%s-z1.jpg)' % sid, GLOBE_HINT)
    f4x3 = flag_dir(flags)

    Ci = C
    Di = D.replace('https://claude.ai/code/artifact/PLACEHOLDER', url)
    data = read(b('gamedata.json'), 'gamedata.json', GLOBE_HINT)
    data = data.replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    b64 = {n: open(b(n + '.b64')).read() for n in ('terrain', 'idmap', 'detail')}

    # the single-file preview carries the alternate styles at half resolution only
    _st = {}
    for sid in STYLE_IDS:
        _st[sid] = ('data:image/jpeg;base64,'
                    + base64.b64encode(open(b('styles/%s-z1.jpg' % sid), 'rb').read()).decode())
    STYLES_JS = 'window.__STYLES__=' + json.dumps(_st) + ';'

    _fl = {}
    _ccs = set(json.load(open(b('flagmap.json'))).keys()) | set(json.load(open(b('adm2cc.json'))).values())
    for _cc in sorted(_ccs):
        _p2 = pspaths.require(f4x3 + '%s.svg' % _cc.lower(),
                              'the flag for %s' % _cc.upper(), FLAGS_HINT)
        _fl[_cc.lower()] = ('data:image/svg+xml;base64,'
                            + base64.b64encode(open(_p2, 'rb').read()).decode())
    for _pf in sorted(glob.glob(b('usflags/*.webp'))):
        _k = os.path.basename(_pf)[:-5]
        _fl[_k] = 'data:image/webp;base64,' + base64.b64encode(open(_pf, 'rb').read()).decode()
    STYLES_JS += 'window.__FLAGS__=' + json.dumps(_fl) + ';'
    STYLES_JS += ('window.__SELECT_SND__="data:audio/mpeg;base64,'
                  + base64.b64encode(open(b('select.mp3'), 'rb').read()).decode() + '";')
    STYLES_JS += ('window.__EMBLEM__="data:image/png;base64,'
                  + base64.b64encode(open(b('emblem.png'), 'rb').read()).decode() + '";')

    single = (A + B + CDN + site_js
              + '<script id="gamedata" type="application/json">' + data + '</script>\n'
              + '<script>window.__TERRAIN__="data:image/jpeg;base64,' + b64['terrain'] + '";'
              + 'window.__IDMAP__="data:image/png;base64,' + b64['idmap'] + '";'
              + 'window.__DETAIL__="data:image/jpeg;base64,' + b64['detail'] + '";'
              + STYLES_JS + '</script>\n'
              + '<script>\n' + Ci + '\n' + Di + '\n</script>\n')

    # local test copy with three.js inlined and no webfonts
    three_js = read(three, 'three.min.js', THREE_HINT)
    loc = single.replace(CDN, '<script>' + three_js + '</script>\n')
    loc = re.sub(r'<link rel="(stylesheet|preconnect)"[^>]*>', '', loc)
    return single, loc


# --------------------------------------------------------------------------- #
# 2. the hosted build

def fingerprint(dist):
    """A hash over everything dist/ serves that is not the pages themselves.

    So a redeploy is never served from a stale browser cache. The pages are
    excluded because they embed the hash; the legal pages and the deploy
    fragments are excluded so that a rebuild over an existing dist/ produces the
    same version as a build into an empty one.
    """
    skip = {'index.html', 'privacy.html', 'terms.html', '_headers',
            '_headers.fragment', '_redirects.fragment'}
    h = hashlib.md5()
    for root, dirs, fs in os.walk(dist):
        dirs.sort()
        for f in sorted(fs):
            if f in skip:
                continue
            fp = os.path.join(root, f)
            h.update(os.path.relpath(fp, dist).replace(os.sep, '/').encode())
            h.update(open(fp, 'rb').read())
    return h.hexdigest()[:10]


def hosted_page(A, B, site_js, V, url):
    page = (A + B + site_js
            + '<script>window.SOJOURNER_V="' + V + '";</script>\n'
            + '<script defer src="three.min.js"></script>\n'
            + '<script defer src="app.js?v=' + V + '"></script>\n')
    # class="sj-game" here, not only from PSTheme.init: tokens.css scopes every
    # role to a surface class, so if scripting is off or the inline script is
    # blocked by a policy, an unclassed <html> leaves --bg and friends undefined and
    # the page renders unstyled. PSTheme.init adds the class too and checks first,
    # so the two cannot fight. The single-file build gets its <html> from the
    # artifact host and relies on the script alone; that build is a preview.
    head_open = '<!doctype html>\n<html lang="en" class="sj-game">\n<head>\n'

    # HEAD. Shared with Word Chain through packages/build/head.py: one tag set,
    # one order, so a gap in one is a gap in neither. Every block flag is off --
    # partA.html already carries <title>, theme-color, the icon, the pre-paint
    # theme script, ui.js and the font links, and it carries them in the right
    # order, so there is nothing here to hoist. What this build gains from the
    # move is apple-mobile-web-app-capable, which Word Chain had and it did not.
    META = psh.head(
        'sj-game',
        site=url, description=DESCRIPTION,
        og_title=TITLE, og_description=BLURB, og_site_name='Sojourner',
        og_image=url.rstrip('/') + '/og.png', og_image_alt=TITLE,
        web_app_capable=True,
        charset=False, viewport=None, title=None, theme_color=None, icon=None,
        theme_js=False, fonts=False, tokens_css=False, ui_css=False, ui_js=False)

    # the artifact host supplies the skeleton; a plain web page needs its own
    m = re.search(r'^(.*?)(<style>)', page, re.S)
    if not m:
        raise pspaths.MissingInput('the head/body split marker',
                                   'no opening style tag found in partA.html + partB.html',
                                   'build.py splits partA on the FIRST literal opening '
                                   'style tag; see the warning at the top of partA.html')
    headbits, rest = m.group(1), page[m.start(2):]
    close = rest.index('</style>') + 8
    return (head_open + headbits.strip() + '\n' + META + rest[:close]
            + '\n</head>\n<body>\n' + rest[close:] + '\n</body>\n</html>\n')


# --------------------------------------------------------------------------- #
# 3. the legal pages
#
# Standalone pages, not text inside a modal: Google's OAuth screen and Stripe both
# need a public URL they can fetch, and so does anyone who wants to link to one.
#
# They are opened from a dark game in a new tab. Without the pre-paint script they
# would paint the light base first and correct themselves, which is the same flash
# the game's own <head> exists to prevent -- so they get the identical treatment,
# and now they get it from the same place the game does: head.py emits theme.js
# ahead of everything, then the fonts, then tokens.css ahead of _legal.css. There
# is no longer a second, trimmed font url here to drift from the union one.

LEGAL_PAGES = (('privacy', 'Privacy'), ('terms', 'Terms of use'))


def legal_page(src, slug, title):
    body = read(src + 'pages/%s.body.html' % slug, 'pages/%s.body.html' % slug)
    legal_css = read(src + 'pages/_legal.css', 'pages/_legal.css')
    return ('<!doctype html>\n<html lang="en" class="sj-game">\n'
            + psh.head('sj-game',
                       title='%s \u00b7 Sojourner' % title, robots='index,follow',
                       viewport=psh.PLAIN_VIEWPORT, canonical=None, og=False,
                       css=legal_css, wrap=True)
            + '<body>\n' + body + '\n</body>\n</html>\n')


# --------------------------------------------------------------------------- #
# 4. deploy fragments (audit B2)
#
# Cloudflare Pages honours exactly one _headers and one _redirects, both at the
# DEPLOYED ROOT. Under the unified site this directory is /sojourner/, so a
# _headers written here would be inert AND publicly fetchable, and every pattern
# in it would be wrong by one path segment.
#
# So: emit FRAGMENTS, prefixed with /sojourner/, for the platform deploy to
# concatenate into deploy/_headers and deploy/_redirects. The .fragment suffix
# is deliberate -- it keeps Pages from mistaking either for the real thing if
# this directory is ever deployed on its own, and makes an accidentally-served
# copy obviously not a config file.

HEADERS_FRAGMENT = (
    "# fragment: merge into the platform root _headers (see deploy/_headers)\n"
    "/sojourner/assets/detail/*\n  Cache-Control: public, max-age=2592000\n"
    "/sojourner/assets/*\n  Cache-Control: public, max-age=604800\n"
    "/sojourner/three.min.js\n  Cache-Control: public, max-age=2592000\n"
    "/sojourner/app.js\n  Cache-Control: public, max-age=3600\n"
    "/sojourner/og.png\n  Cache-Control: public, max-age=86400\n")
# Audit B3: the asset base is './assets/', so /sojourner WITHOUT the slash
# resolves every asset against the platform root and the globe never loads.
REDIRECTS_FRAGMENT = (
    "# fragment: merge into the platform root _redirects (see deploy/_redirects)\n"
    "/sojourner   /sojourner/   301\n")


# --------------------------------------------------------------------------- #
# --check

def audit(html, src):
    bad = []
    markup = re.sub(r'<script\b.*?</script>', '', html, flags=re.S)
    markup = re.sub(r'<style\b.*?</style>', '', markup, flags=re.S)
    markup = re.sub(r'<!--.*?-->', '', markup, flags=re.S)

    def want(needle, why, where=None):
        if needle not in (html if where is None else where):
            bad.append('%s missing from the page (%s)' % (needle, why))

    def once(needle, why, where=None):
        n = (markup if where is None else where).count(needle)
        if n != 1:
            bad.append('%s appears %d times, expected once (%s)' % (needle, n, why))

    once('<!doctype html>', 'one document')
    once('<head>', 'one head'); once('</head>', 'one head')
    once('<body>', 'one body'); once('</body>', 'one body')
    once('<meta charset="utf-8">', 'a second charset is ignored and confusing')
    once('<meta name="theme-color"', 'PSTheme takes the first match; a second goes stale')
    once('<title>', 'one title')
    for rel in ('packages/tokens/theme.js', 'packages/tokens/tokens.css',
                'packages/ui/ui.css', 'packages/ui/ui.js'):
        once(psh.MARKER_BEGIN % rel, '%s inlined exactly once' % rel, html)
    want('<link rel="canonical"', 'audit S8/head union')
    want('<meta property="og:image"', 'the share card')
    want('<meta name="apple-mobile-web-app-capable"', 'audit S8/head union')
    want('<link rel="icon"', 'audit S11: no icon means a 404 on /favicon.ico')
    want(psh.FONTS_URL, 'audit S10: the union font url, byte-identical everywhere')
    want("PSTheme.init('sj-game')", 'the theme would never be applied')
    want('PSUI.init', 'the sheets would never open')

    t = html.find("PSTheme.init('sj-game')")
    for stylesheet in ('<link rel="stylesheet"', '<style>'):
        s = html.find(stylesheet)
        if 0 <= s < t:
            bad.append('%s at %d comes BEFORE the theme script at %d -- the page will '
                       'paint in the wrong theme' % (stylesheet, s, t))

    for name, rel in (('theme.js', 'packages/tokens/theme.js'),
                      ('tokens.css', 'packages/tokens/tokens.css'),
                      ('ui.css', 'packages/ui/ui.css'),
                      ('ui.js', 'packages/ui/ui.js')):
        b, e = psh.MARKER_BEGIN % rel, psh.MARKER_END % rel
        i, j = html.find(b), html.find(e)
        if i < 0 or j < 0:
            continue
        if html[i + len(b):j] != open(psh.package_file(name), encoding='utf-8').read():
            bad.append('the inlined copy of %s has drifted from the canonical file' % rel)
    return bad


# --------------------------------------------------------------------------- #

def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    pspaths.add_path_args(p)
    p.add_argument('--single', metavar='DIR', help='one-file builds (default: '
                   'games/sojourner/preview; $SINGLE)')
    p.add_argument('--flags', metavar='DIR', help='country flag SVGs (default: <build>/flags; $FLAGS)')
    p.add_argument('--three', metavar='FILE', help='three.min.js (default: '
                   '<build>/three/build/three.min.js; $THREE)')
    p.add_argument('--site', metavar='URL', help='hosted address; overrides src/url.txt')
    # For CI. The baked globe and three.js are not in git, so a checkout can only
    # ever build the pages -- which is exactly the part worth checking cheaply on
    # every push. With this flag their absence is reported and not counted as a
    # failure; without it the build exits 2, because a dist/ with no globe in it
    # must not be mistaken for a deployable one.
    p.add_argument('--allow-missing', action='store_true',
                   help='do not fail when an input that cannot live in git is absent')
    a = p.parse_args(argv)

    game = os.path.dirname(_HERE)
    src = pspaths.resolve(_HERE, a.src, 'SRC')
    build = pspaths.resolve(os.path.join(game, 'data'), a.build, 'BUILD')
    dist = pspaths.resolve(os.path.join(game, 'dist'), a.dist, 'DIST')
    single_dir = pspaths.resolve(os.path.join(game, 'preview'), a.single, 'SINGLE')
    flags = pspaths.resolve(build + 'flags', a.flags, 'FLAGS')
    three = (a.three or os.environ.get('THREE')
             or os.path.join(build + 'three', 'build', 'three.min.js'))
    say = (lambda *m: None) if a.quiet else (lambda *m: print(*m))

    # Audit S4. One source for the address, injected as window.SOJOURNER_SITE so the
    # share link and the domain painted on the share card cannot drift apart.
    url = (a.site or os.environ.get('SITE')
           or (open(src + 'url.txt').read().strip() if os.path.exists(src + 'url.txt')
               else SITE_DEFAULT)).rstrip('/')
    site_js = '<script>window.SOJOURNER_SITE=' + json.dumps(url) + ';</script>\n'

    A = read(src + 'partA.html', 'partA.html')
    B = read(src + 'partB.html', 'partB.html')
    C = read(src + 'partC.js', 'partC.js')
    D = read(src + 'partD.js', 'partD.js')

    # ---------------- what can be built at all ----------------
    deferred = []      # (what, message) for inputs that are not in git
    try:
        single, local = single_file(src, build, flags, three, A, B, C, D, url, site_js)
    except pspaths.MissingInput as e:
        single = local = None
        deferred.append(('the single-file preview', e))

    have_three = os.path.exists(three)
    if not have_three:
        deferred.append(('three.min.js in dist/',
                         pspaths.MissingInput('three.min.js', 'not found at %s' % three, THREE_HINT)))

    # ---------------- validate before writing anything ----------------
    Dh = D.replace('https://claude.ai/code/artifact/PLACEHOLDER', url)
    problems = audit(hosted_page(A, B, site_js, '0' * 10, url), src)
    for slug, title in LEGAL_PAGES:
        legal_page(src, slug, title)          # raises if a body or _legal.css is gone

    if a.check:
        if single:
            say('  single-file preview  %.2f MB' % (len(single.encode()) / 1048576))
        for what, e in deferred:
            say('  SKIP %s -- %s' % (what, e))
        for b in problems:
            print('  PROBLEM: ' + b)
        print('sojourner --check: %s%s'
              % ('FAILED' if problems else 'ok',
                 '' if not deferred else ' (%d part(s) not buildable here)' % len(deferred)))
        return 1 if problems else (0 if a.allow_missing or not deferred else 2)
    if problems:
        for b in problems:
            sys.stderr.write('  PROBLEM: %s\n' % b)
        sys.stderr.write('build.py: refusing to write a page with %d problem(s)\n' % len(problems))
        return 1

    # ---------------- 1. single file ----------------
    if single:
        os.makedirs(single_dir, exist_ok=True)
        open(single_dir + 'sojourner.html', 'w', encoding='utf-8').write(single)
        open(single_dir + 'local.html', 'w', encoding='utf-8').write(local)
        say('  single file  %.2f MB' % (len(single.encode()) / 1048576))

    # ---------------- 2. hosted ----------------
    os.makedirs(dist, exist_ok=True)
    if have_three:
        if os.path.exists(dist + 'three.min.js'):
            os.remove(dist + 'three.min.js')
        shutil.copy(three, dist + 'three.min.js')
        os.chmod(dist + 'three.min.js', 0o644)
    open(dist + 'app.js', 'w', encoding='utf-8').write(C + '\n' + Dh + '\n')
    # fingerprint so a redeploy is never served from a stale browser cache
    V = fingerprint(dist)
    say('  asset version', V)
    open(dist + 'index.html', 'w', encoding='utf-8').write(hosted_page(A, B, site_js, V, url))

    # ---------------- 3. legal pages ----------------
    for slug, title in LEGAL_PAGES:
        open(dist + slug + '.html', 'w', encoding='utf-8').write(legal_page(src, slug, title))

    # ---------------- 4. deploy fragments ----------------
    open(dist + '_headers.fragment', 'w').write(HEADERS_FRAGMENT)
    open(dist + '_redirects.fragment', 'w').write(REDIRECTS_FRAGMENT)

    tot = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(dist) for f in fs)
    n = sum(len(fs) for _, _, fs in os.walk(dist))
    say('hosted build %.2f MB across %d files -> %s'
        % (tot / 1048576, n, os.path.relpath(dist, REPO)))

    if deferred:
        sys.stderr.write('\n%d build input(s) are not in git, so this dist/ is not '
                         'playable:\n' % len(deferred))
        for what, e in deferred:
            sys.stderr.write('  %s\n    %s\n' % (what, str(e).replace('\n', '\n  ')))
        sys.stderr.write('Everything that does not depend on them was built.\n')
        return 0 if a.allow_missing else 2
    return 0


if __name__ == '__main__':
    sys.exit(pspaths.run(main))
