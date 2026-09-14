# -*- coding: utf-8 -*-
"""The <head> every PlaySapien surface needs, emitted in the one order that works.

WHY THIS EXISTS

Sojourner's build.py and Word Chain's build.py each hand-wrote their own head.
They emitted almost the same tag set with different gaps -- Sojourner had
`canonical` but no `apple-touch-icon` or `apple-mobile-web-app-capable`, Word
Chain had those but no `canonical` -- and each fixed a real bug the other still
has. `docs/INTEGRATION-AUDIT.md` ("Duplication worth extracting") calls the rest
of the two builds not worth merging and this part worth sharing. One builder
closes both gaps at once, and closes them for the third game too.

THE ORDER IS THE POINT

    charset, viewport, title
    description, robots, theme-color      theme.js rewrites the theme-color tag,
                                          so the tag must already exist
    canonical, og:*, twitter:*
    icon, apple-touch-icon
    <script> theme.js + PSTheme.init()    <-- BEFORE any stylesheet
    preconnect + the union fonts url      <-- render-blocking, third-party
    <style> tokens.css + ui.css + own CSS
    <script> ui.js                        no pre-paint work to do

An inline script after a <link rel=stylesheet> does not execute until that
stylesheet has loaded. Put the theme script below the Google Fonts link and the
page paints in whatever theme the markup happens to carry for as long as
fonts.googleapis.com takes to answer -- which is the flash the whole pre-paint
mechanism exists to prevent. Word Chain's part-a-style.html has them in exactly
that wrong order today; its build.py hoists the block out through `hoist_theme`
below rather than shipping the flash.

THE INLINED BLOCKS

tokens.css / theme.js / ui.css / ui.js are emitted between the same markers
packages/tokens/check-inline.mjs diffs, and read from the canonical files, so a
surface built through here cannot drift. The two existing games carry their
copies inside partA.html / part-a-style.html -- that is where check-inline pins
them -- and pass those through as `extra` with the matching flag turned off.
Nothing here is ever emitted twice.

Standard library only.
"""

import os

from .paths import repo_root, require, MissingInput

__all__ = ['head', 'meta_tags', 'theme_script', 'ui_script', 'fonts_links',
           'style_block', 'inline_block', 'package_file', 'hoist_theme',
           'FONTS_URL', 'DEFAULT_VIEWPORT', 'PLAIN_VIEWPORT', 'MARKER_BEGIN', 'MARKER_END']


# --------------------------------------------------------------------------- #
# constants shared by every surface

# viewport-fit=cover is what lets a game paint under a notch and read the safe-area
# insets; both games size themselves to the visual viewport and both asked for it.
# A page that is only text (the legal pages) passes the plain one.
DEFAULT_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'
PLAIN_VIEWPORT = 'width=device-width, initial-scale=1'

# Audit S10. ONE union url across the shell, Sojourner and Word Chain, so
# navigating between surfaces hits the font cache instead of re-downloading. It
# is a superset of what any one surface paints; it must stay byte-identical
# everywhere or the shared cache entry is lost. Do not trim it.
FONTS_URL = ('https://fonts.googleapis.com/css2?'
             'family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700;9..144,900'
             '&family=Public+Sans:wght@400;500;600'
             '&family=IBM+Plex+Mono:wght@400;500;600'
             '&family=Petit+Formal+Script&display=swap')

# Byte-for-byte what packages/tokens/check-inline.mjs looks for. The dash is an
# em dash (U+2014); a hyphen here silently turns every check into "not adopted".
MARKER_BEGIN = '/* ===== BEGIN %s (inlined verbatim — do not edit here) ===== */\n'
MARKER_END = '/* ===== END %s ===== */\n'

_SHARED = {
    'tokens.css': 'packages/tokens/tokens.css',
    'theme.js': 'packages/tokens/theme.js',
    'ui.css': 'packages/ui/ui.css',
    'ui.js': 'packages/ui/ui.js',
}


# --------------------------------------------------------------------------- #
# reading the canonical shared files

def package_file(name, root=None):
    """Absolute path of a canonical shared file, by short name or repo-relative path."""
    rel = _SHARED.get(name, name)
    root = root or repo_root()
    return require(
        os.path.join(root, rel), rel,
        'this is a checked-in file; if it is absent the checkout is incomplete '
        'or --root points outside it')


def inline_block(name, root=None):
    """The canonical file wrapped in the markers check-inline.mjs diffs."""
    rel = _SHARED.get(name, name)
    with open(package_file(name, root), encoding='utf-8') as f:
        body = f.read()
    return (MARKER_BEGIN % rel) + body + (MARKER_END % rel)


# --------------------------------------------------------------------------- #
# the pieces

def _esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def _meta(name, content):
    return '<meta name="%s" content="%s">\n' % (name, _esc(content))


def _prop(prop, content):
    return '<meta property="%s" content="%s">\n' % (prop, _esc(content))


def theme_script(surface, root=None):
    """theme.js, inlined, plus the init call. Must precede every stylesheet."""
    return ('<script>\n' + inline_block('theme.js', root)
            + "PSTheme.init('%s');\n" % surface + '</script>\n')


def ui_script(root=None):
    """ui.js, inlined. Defines window.PSUI; the game calls PSUI.init() itself."""
    return '<script>\n' + inline_block('ui.js', root) + '</script>\n'


def fonts_links():
    return ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
            '<link rel="stylesheet" href="' + FONTS_URL + '">\n')


def style_block(tokens=True, ui=False, css='', root=None):
    """<style> with the shared token/chrome layers first and the surface's own last."""
    out = '<style>\n'
    if tokens:
        out += inline_block('tokens.css', root)
    if ui:
        out += inline_block('ui.css', root)
    return out + css + '</style>\n'


def meta_tags(site=None, title=None, description=None, robots=None,
              theme_color=None, canonical=True, icon=None, apple_touch_icon=None,
              web_app_capable=False, charset=True, viewport=DEFAULT_VIEWPORT,
              og=True, og_title=None, og_description=None, og_site_name=None,
              og_url=True, og_image=None, og_image_size=(1200, 630),
              og_image_alt=None, og_type='website',
              twitter_card='summary_large_image', twitter_title=None,
              twitter_description=None, twitter_image=None):
    """Every non-script tag, in order. A tag whose value is None is not emitted.

    The social values cascade: og_title falls back to title, twitter_* to the
    matching og_*, og_image_alt to og_title. Passing one explicitly overrides it.
    `canonical=True` and `og_url=True` mean "`site` with a trailing slash".
    `og=False` drops the whole Open Graph / Twitter section -- for a page that is
    not meant to be shared as a card, such as a legal page.
    """
    og_title = og_title if og_title is not None else title
    og_description = og_description if og_description is not None else description
    og_image_alt = og_image_alt if og_image_alt is not None else og_title
    twitter_title = twitter_title if twitter_title is not None else og_title
    twitter_description = (twitter_description if twitter_description is not None
                           else og_description)
    twitter_image = twitter_image if twitter_image is not None else og_image

    if not og:                       # a page that is not shared as a card
        og_type = og_site_name = og_title = og_description = None
        og_url = og_image = None

    if (canonical is True or og_url is True) and not site:
        raise MissingInput('the surface url',
                           'canonical/og:url were asked for but no site url was given',
                           'pass site="https://playsapien.com/<game>" or '
                           'canonical=None, og_url=None')
    home = (site.rstrip('/') + '/') if site else None

    o = []
    if charset:
        o.append('<meta charset="utf-8">\n')
    if viewport:
        o.append('<meta name="viewport" content="%s">\n' % viewport)
    if title is not None:
        o.append('<title>%s</title>\n' % _esc(title))
    if description is not None:
        o.append(_meta('description', description))
    if robots is not None:
        o.append(_meta('robots', robots))
    # theme.js rewrites this tag's content on every theme change and takes the
    # FIRST match, so there is exactly one and no media-scoped variants -- a
    # second one would be left stale and fighting it. The value is the light
    # ground of this surface, which is what "system + light" resolves to.
    if theme_color is not None:
        o.append(_meta('theme-color', theme_color))
    if canonical:
        o.append('<link rel="canonical" href="%s">\n'
                 % _esc(home if canonical is True else canonical))

    # Open Graph / Twitter: what a chat app or a social site shows when the url
    # is pasted. Picture, heading and blurb are one tappable link on the far end.
    if og_type:
        o.append(_prop('og:type', og_type))
    if og_site_name is not None:
        o.append(_prop('og:site_name', og_site_name))
    if og_title is not None:
        o.append(_prop('og:title', og_title))
    if og_description is not None:
        o.append(_prop('og:description', og_description))
    if og_url:
        o.append(_prop('og:url', home if og_url is True else og_url))
    if og_image is not None:
        o.append(_prop('og:image', og_image))
        if og_image_size:
            o.append(_prop('og:image:width', og_image_size[0]))
            o.append(_prop('og:image:height', og_image_size[1]))
        if og_image_alt is not None:
            o.append(_prop('og:image:alt', og_image_alt))
        if twitter_card:
            o.append(_meta('twitter:card', twitter_card))
        if twitter_title is not None:
            o.append(_meta('twitter:title', twitter_title))
        if twitter_description is not None:
            o.append(_meta('twitter:description', twitter_description))
        if twitter_image is not None:
            o.append(_meta('twitter:image', twitter_image))

    if web_app_capable:
        o.append(_meta('apple-mobile-web-app-capable', 'yes'))
    if icon is not None:
        o.append('<link rel="icon" href="%s">\n' % _esc(icon))
    if apple_touch_icon is not None:
        o.append('<link rel="apple-touch-icon" href="%s">\n' % _esc(apple_touch_icon))
    return ''.join(o)


# --------------------------------------------------------------------------- #
# the whole thing

def head(surface, theme_js=True, fonts=True, tokens_css=True, ui_css=False,
         ui_js=False, css='', extra='', wrap=False, root=None, **meta):
    """A complete, correct <head> for one surface.

    With the block flags left alone this emits everything a new game needs and
    nothing has to be remembered. A surface that already carries a block inside
    its own markup turns that flag off and passes the markup as `extra`.

    `wrap=True` adds the <head> ... </head> tags; both games splice the result
    into a head they open themselves, so it defaults off.
    """
    o = [meta_tags(**meta)]
    if theme_js:
        if not surface:
            raise MissingInput('the surface class',
                               'theme_js=True needs one of ps-shell / sj-game / wc-game',
                               'pass surface=..., or theme_js=False if the markup '
                               'already carries the script')
        o.append(theme_script(surface, root))
    if fonts:
        o.append(fonts_links())
    if tokens_css or ui_css or css:
        o.append(style_block(tokens_css, ui_css, css, root))
    if ui_js:
        o.append(ui_script(root))
    o.append(extra)
    body = ''.join(o)
    return '<head>\n' + body + '</head>\n' if wrap else body


# --------------------------------------------------------------------------- #
# lifting an already-inlined theme block out of a surface's markup

def hoist_theme(html, surface):
    """Cut the <script> holding the inlined theme.js out of `html`.

    Returns (html_without_it, True) or (html, False).

    Word Chain's part-a-style.html has the font stylesheet ABOVE the theme
    script, so on a cold cache the theme is decided only once a third-party
    request finishes. The file is also the canonical home of that inlined copy
    (check-inline.mjs diffs it there) and is edited by hand, so the fix is to
    hoist at build time rather than to move it and have the two disagree.

    Deliberately total: if the markers are not where this expects -- the file
    was restructured, the block was renamed -- it changes nothing and says so,
    and the caller keeps the old order. Never a half-removal, never a crash.
    """
    begin = MARKER_BEGIN % _SHARED['theme.js']
    end = MARKER_END % _SHARED['theme.js']
    i, j = html.find(begin), html.find(end)
    if i < 0 or j < 0:
        return html, False
    start = html.rfind('<script>', 0, i)
    stop = html.find('</script>', j)
    if start < 0 or stop < 0:
        return html, False
    stop += len('</script>')
    chunk = html[start:stop]
    if "PSTheme.init('%s')" % surface not in chunk:
        return html, False
    # nothing but the block and its own comments may be inside that script
    if '</script>' in chunk[:-len('</script>')]:
        return html, False
    rest = html[:start] + html[stop:]
    if begin in rest:                      # a second copy: leave well alone
        return html, False
    return rest, True
