import json, os, base64, shutil
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
OUT='/tmp/out/dist/assets'
os.makedirs(OUT, exist_ok=True)

# ---------- 1. colour base, two whole-globe levels ----------
src = Image.open('/tmp/build/terrain.jpg').convert('RGB')          # 4096 x 2048
src.resize((2048,1024), Image.LANCZOS).save(OUT+'/terrain-z1.jpg', quality=78, optimize=True)
src.save(OUT+'/terrain-z2.jpg', quality=80, optimize=True)

# ---------- 2. relief detail, tiled ----------
Z, TILE = 3, 512
COLS, ROWS = 1<<(Z+1), 1<<Z          # 16 x 8  ->  8192 x 4096
det = Image.open('/tmp/build/detail.jpg').convert('L')             # 8192 x 4096
assert det.size == (COLS*TILE, ROWS*TILE), det.size
n = 0
for c in range(COLS):
    d = '%s/detail/%d/%d' % (OUT, Z, c)
    os.makedirs(d, exist_ok=True)
    for r in range(ROWS):
        det.crop((c*TILE, r*TILE, (c+1)*TILE, (r+1)*TILE)).save(
            '%s/%d.jpg' % (d, r), quality=82, optimize=True)
        n += 1
print('detail tiles', n)

# ---------- 2b. alternate globe styles ----------
import glob
sd = OUT+'/styles'; os.makedirs(sd, exist_ok=True)
for f in glob.glob('/tmp/build/styles/*-z*.jpg'):
    shutil.copy(f, sd)
print('style files', len(os.listdir(sd)))

# ---------- 2c. flags for expert-mode country questions ----------
fd = OUT+'/flags'; os.makedirs(fd, exist_ok=True)
fm = json.load(open('/tmp/build/flagmap.json'))
fm = dict(fm); fm.update({_c:_a for _a,_c in json.load(open('/tmp/build/adm2cc.json')).items()})
for cc in fm:
    shutil.copy('/tmp/flags/flags/4x3/%s.svg' % cc.lower(), '%s/%s.svg' % (fd, cc.lower()))
import glob as _glob
for _pf in sorted(_glob.glob('/tmp/build/usflags/*.webp')):
    shutil.copy(_pf, fd + '/' + os.path.basename(_pf))
print('flags', len(os.listdir(fd)))

# ---------- 2a. the emblem and the link-preview card ----------
shutil.copy('/tmp/build/emblem.png', OUT+'/emblem.png')
shutil.copy('/tmp/build/og.png', OUT+'/../og.png')

# ---------- 2b. the selection sound ----------
shutil.copy('/tmp/build/select.mp3', OUT+'/select.mp3')

# ---------- 3. picking map ----------
shutil.copy('/tmp/build/idmap.png', OUT+'/idmap.png')

# ---------- 4. borders, as raw bytes ----------
B = json.load(open('/tmp/build/borders.json'))
for k in ('country','admin','coast'):
    open('%s/borders-%s.bin' % (OUT, k), 'wb').write(base64.b64decode(B[k]))

# ---------- 5. game data, split so facts load only when wanted ----------
G = json.load(open('/tmp/build/gamedata.json'))
json.dump({'admins':G['admins'],'flagA':G['flagA'],'gL':G['gL'],'gA':G['gA'],'gX':G['gX'],'gY':G['gY']},
          open(OUT+'/meta.json','w'), ensure_ascii=False, separators=(',',':'))
POOL_KEYS=('r','n','c','a','t','x','y','w','fl','rad')
json.dump([{k:p[k] for k in POOL_KEYS if k in p} for p in G['pool']],
          open(OUT+'/pool.json','w'), ensure_ascii=False, separators=(',',':'))
json.dump([p.get('fs',[]) for p in G['pool']],
          open(OUT+'/facts.json','w'), ensure_ascii=False, separators=(',',':'))

for f in sorted(os.listdir(OUT)):
    p = os.path.join(OUT,f)
    if os.path.isfile(p): print('%-22s %6d KB' % (f, os.path.getsize(p)//1024))
tot = sum(os.path.getsize(os.path.join(dp,f)) for dp,_,fs in os.walk(OUT) for f in fs)
print('total on disk %.1f MB' % (tot/1048576))
