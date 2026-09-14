import re, os, shutil, base64, hashlib, json
SRC='/tmp/out/'; BUILD='/tmp/build/'; DIST='/tmp/out/dist/'
A=open(SRC+'partA.html',encoding='utf-8').read()
B=open(SRC+'partB.html',encoding='utf-8').read()
C=open(SRC+'partC.js',encoding='utf-8').read()
D=open(SRC+'partD.js',encoding='utf-8').read()
# Audit S4. One source for the address, injected as window.SOJOURNER_SITE so the
# share link and the domain painted on the share card cannot drift apart.
url=open(SRC+'url.txt').read().strip() if os.path.exists(SRC+'url.txt') else 'https://playsapien.com/sojourner'
SITE_JS='<script>window.SOJOURNER_SITE=' + json.dumps(url) + ';</script>\n'
CDN='<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>\n'

# ---------- 1. single file (the shareable preview) ----------
Ci=C; Di=D.replace('https://claude.ai/code/artifact/PLACEHOLDER', url)
data=open(BUILD+'gamedata.json',encoding='utf-8').read()
data=data.replace('<','\\u003c').replace('\u2028','\\u2028').replace('\u2029','\\u2029')
b64={n:open(BUILD+n+'.b64').read() for n in ('terrain','idmap','detail')}
# the single-file preview carries the alternate styles at half resolution only
import base64 as _b64, json as _json
_st={}
for sid in ('nasa1','nasa2','mgreen','mblue','natural'):
    p = BUILD+'styles/%s-z1.jpg' % sid
    _st[sid] = 'data:image/jpeg;base64,' + _b64.b64encode(open(p,'rb').read()).decode()
STYLES_JS = 'window.__STYLES__=' + _json.dumps(_st) + ';'
_fl={}
_ccs = set(_json.load(open(BUILD+'flagmap.json')).keys()) | set(_json.load(open(BUILD+'adm2cc.json')).values())
for _cc in sorted(_ccs):
    _p2 = '/tmp/flags/flags/4x3/%s.svg' % _cc.lower()
    _fl[_cc.lower()] = 'data:image/svg+xml;base64,' + _b64.b64encode(open(_p2,'rb').read()).decode()
import glob as _glob
for _pf in sorted(_glob.glob(BUILD+'usflags/*.webp')):
    _k = os.path.basename(_pf)[:-5]
    _fl[_k] = 'data:image/webp;base64,' + _b64.b64encode(open(_pf,'rb').read()).decode()
STYLES_JS += 'window.__FLAGS__=' + _json.dumps(_fl) + ';'
STYLES_JS += ('window.__SELECT_SND__="data:audio/mpeg;base64,'
              + _b64.b64encode(open(BUILD+'select.mp3','rb').read()).decode() + '";')
STYLES_JS += ('window.__EMBLEM__="data:image/png;base64,'
              + _b64.b64encode(open(BUILD+'emblem.png','rb').read()).decode() + '";')
single=(A+B+CDN+SITE_JS
  +'<script id="gamedata" type="application/json">'+data+'</script>\n'
  +'<script>window.__TERRAIN__="data:image/jpeg;base64,'+b64['terrain']+'";'
  +'window.__IDMAP__="data:image/png;base64,'+b64['idmap']+'";'
  +'window.__DETAIL__="data:image/jpeg;base64,'+b64['detail']+'";'+STYLES_JS+'</script>\n'
  +'<script>\n'+Ci+'\n'+Di+'\n</script>\n')
open(SRC+'sojourner.html','w',encoding='utf-8').write(single)
print('single file  %.2f MB' % (len(single.encode())/1048576))

# local test copy with three.js inlined and no webfonts
three=open('/tmp/three/build/three.min.js',encoding='utf-8').read()
loc=single.replace(CDN,'<script>'+three+'</script>\n')
loc=re.sub(r'<link rel="(stylesheet|preconnect)"[^>]*>','',loc)
open(SRC+'local.html','w',encoding='utf-8').write(loc)

# ---------- 2. hosted build ----------
Dh=D.replace('https://claude.ai/code/artifact/PLACEHOLDER', url)
shutil.copy('/tmp/three/build/three.min.js', DIST+'three.min.js')
open(DIST+'app.js','w',encoding='utf-8').write(C+'\n'+Dh+'\n')
# fingerprint so a redeploy is never served from a stale browser cache
h=hashlib.md5()
for root, dirs, fs in os.walk(DIST):
    dirs.sort()
    for f in sorted(fs):
        if f in ('index.html','_headers','_headers.fragment','_redirects.fragment'): continue
        fp=os.path.join(root,f)
        h.update(os.path.relpath(fp,DIST).replace(os.sep,'/').encode())
        h.update(open(fp,'rb').read())
V=h.hexdigest()[:10]
page=(A+B+SITE_JS
  +'<script>window.SOJOURNER_V="'+V+'";</script>\n'
  +'<script defer src="three.min.js"></script>\n'
  +'<script defer src="app.js?v='+V+'"></script>\n')
print('asset version', V)
# class="sj-game" here, not only from PSTheme.init: tokens.css scopes every
# role to a surface class, so if scripting is off or the inline script is
# blocked by a policy, an unclassed <html> leaves --bg and friends undefined and
# the page renders unstyled. PSTheme.init adds the class too and checks first,
# so the two cannot fight. The single-file build gets its <html> from the
# artifact host and relies on the script alone; that build is a preview.
head='<!doctype html>\n<html lang="en" class="sj-game">\n<head>\n'
# Open Graph / Twitter card: what a chat app or social site shows when the URL is pasted.
# The picture, the heading and the blurb are all one tappable link on the other end.
OG = ('<meta property="og:type" content="website">\n'
      '<meta property="og:site_name" content="Sojourner">\n'
      '<meta property="og:title" content="Sojourner \u2014 a game of geography">\n'
      '<meta property="og:description" content="Five places a day. Find them on a bare globe, '
      'then read the story that place has to tell.">\n'
      '<meta property="og:url" content="' + url + '/">\n'
      '<meta property="og:image" content="' + url + '/og.png">\n'
      '<meta property="og:image:width" content="1200">\n'
      '<meta property="og:image:height" content="630">\n'
      '<meta property="og:image:alt" content="Sojourner \u2014 a game of geography">\n'
      '<meta name="twitter:card" content="summary_large_image">\n'
      '<meta name="twitter:title" content="Sojourner \u2014 a game of geography">\n'
      '<meta name="twitter:description" content="Five places a day. Find them on a bare globe, '
      'then read the story that place has to tell.">\n'
      '<meta name="twitter:image" content="' + url + '/og.png">\n'
      '<meta name="description" content="A daily geography game. Five places, a bare globe, '
      'and a story for every place you find.">\n'
      '<link rel="canonical" href="' + url + '/">\n')
# the artifact host supplies the skeleton; a plain web page needs its own
m=re.search(r'^(.*?)(<style>)', page, re.S)
headbits, rest = m.group(1), page[m.start(2):]
open(DIST+'index.html','w',encoding='utf-8').write(
  head + headbits.strip() + '\n' + OG + rest[:rest.index('</style>')+8] +
  '\n</head>\n<body>\n' + rest[rest.index('</style>')+8:] + '\n</body>\n</html>\n')
# ---------- 3. the legal pages ----------
# Standalone pages, not text inside a modal: Google's OAuth screen and Stripe both
# need a public URL they can fetch, and so does anyone who wants to link to one.
LEGAL_CSS = open(SRC+'pages/_legal.css',encoding='utf-8').read()
# These pages are opened from a dark game in a new tab. Without the pre-paint
# script they would paint the light base first and correct themselves, which is
# the same flash the game's own <head> exists to prevent -- so they get the
# identical treatment: theme.js inlined ahead of everything, then tokens.css
# inlined ahead of _legal.css. Both are read from packages/tokens at build time
# rather than copied into this directory, so there is only ever one source.
# Audit S8: this script still runs out of /tmp, so the repo may or may not be
# beside it. Look in the repo position first, then next to the sources, and say
# plainly which paths were tried if neither is there -- a silent fallback to a
# stale copy is exactly how an inlined file drifts from its canonical one.
_HERE = os.path.dirname(os.path.abspath(__file__))
def _tokens(name):
    for d in (os.path.join(_HERE,'..','..','..','packages','tokens'),
              os.path.join(SRC,'..','..','..','packages','tokens'),
              os.path.join(SRC,'tokens')):
        p = os.path.normpath(os.path.join(d,name))
        if os.path.exists(p): return open(p,encoding='utf-8').read()
    raise SystemExit('build.py: cannot find packages/tokens/%s (tried beside %s and %s)'
                     % (name, _HERE, SRC))
LEGAL_TOKENS = _tokens('tokens.css')
LEGAL_THEME  = _tokens('theme.js')
LEGAL_HEAD_JS = ('<script>\n'
  '/* ===== BEGIN packages/tokens/theme.js (inlined verbatim \u2014 do not edit here) ===== */\n'
  + LEGAL_THEME +
  '/* ===== END packages/tokens/theme.js ===== */\n'
  "PSTheme.init('sj-game');\n</script>\n")
LEGAL_STYLE = ('<style>\n'
  '/* ===== BEGIN packages/tokens/tokens.css (inlined verbatim \u2014 do not edit here) ===== */\n'
  + LEGAL_TOKENS +
  '/* ===== END packages/tokens/tokens.css ===== */\n'
  + LEGAL_CSS + '</style>\n')
LEGAL_FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
  'family=Fraunces:opsz,wght@9..144,600&family=Public+Sans:wght@400;600'
  '&family=IBM+Plex+Mono:wght@400;500&display=swap">\n')
for _slug,_title in (('privacy','Privacy'),('terms','Terms of use')):
    _body = open(SRC+'pages/%s.body.html' % _slug,encoding='utf-8').read()
    open(DIST+_slug+'.html','w',encoding='utf-8').write(
      '<!doctype html>\n<html lang="en" class="sj-game">\n<head>\n<meta charset="utf-8">\n'
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
      '<title>' + _title + ' \u00b7 Sojourner</title>\n'
      '<meta name="robots" content="index,follow">\n'
      + LEGAL_HEAD_JS + LEGAL_FONTS + LEGAL_STYLE + '</head>\n<body>\n'
      + _body + '\n</body>\n</html>\n')

# ---------- 4. deploy fragments (audit B2) ----------
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
open(DIST+'_headers.fragment','w').write(
"# fragment: merge into the platform root _headers (see deploy/_headers)\n"
"/sojourner/assets/detail/*\n  Cache-Control: public, max-age=2592000\n"
"/sojourner/assets/*\n  Cache-Control: public, max-age=604800\n"
"/sojourner/three.min.js\n  Cache-Control: public, max-age=2592000\n"
"/sojourner/app.js\n  Cache-Control: public, max-age=3600\n"
"/sojourner/og.png\n  Cache-Control: public, max-age=86400\n")
# Audit B3: the asset base is './assets/', so /sojourner WITHOUT the slash
# resolves every asset against the platform root and the globe never loads.
open(DIST+'_redirects.fragment','w').write(
"# fragment: merge into the platform root _redirects (see deploy/_redirects)\n"
"/sojourner   /sojourner/   301\n")
tot=sum(os.path.getsize(os.path.join(dp,f)) for dp,_,fs in os.walk(DIST) for f in fs)
n=sum(len(fs) for _,_,fs in os.walk(DIST))
print('hosted build %.2f MB across %d files' % (tot/1048576, n))
