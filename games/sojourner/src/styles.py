import numpy as np, os
from PIL import Image, ImageFilter
Image.MAX_IMAGE_PIXELS=None
U='/mnt/user-data/uploads/Maps Game App/Globe Textures/_reduced/'
OUT='/tmp/build/styles'; os.makedirs(OUT, exist_ok=True)
W,H = 4096,2048

def save(img, name):
    img.save('%s/%s-z2.jpg'%(OUT,name), quality=82, optimize=True)
    img.resize((2048,1024), Image.LANCZOS).save('%s/%s-z1.jpg'%(OUT,name), quality=80, optimize=True)
    img.resize((768,384)).save('%s/%s-prev.png'%(OUT,name))
    print('%-14s z2 %5dKB  z1 %5dKB' % (name,
        os.path.getsize('%s/%s-z2.jpg'%(OUT,name))//1024,
        os.path.getsize('%s/%s-z1.jpg'%(OUT,name))//1024))

# ---------- NASA mosaics ----------
def mosaic(prefix):
    m = Image.new('RGB',(W,H))
    for ci,c in enumerate('ABCD'):
        for ri,r in enumerate('12'):
            t = Image.open(U+'%s_%s%s.jpg'%(prefix,c,r)).convert('RGB').resize((W//4,H//2), Image.LANCZOS)
            m.paste(t,(ci*(W//4), ri*(H//2)))
    return m
for pre,name in (('may','nasa1'),('aug','nasa2')):
    m = mosaic(pre)
    a = np.asarray(m).astype(np.float32)/255.0
    # Blue Marble is dark and low-contrast on a small sphere: lift midtones a little
    a = np.clip(a**0.90 * 1.06, 0, 1)
    lum = a.mean(axis=2, keepdims=True)
    a = np.clip(lum + (a-lum)*1.10, 0, 1)
    save(Image.fromarray((a*255).astype(np.uint8)), name)

# ---------- Natural Earth II ----------
ne = Image.open(U+'ne2_5400.jpg').convert('RGB').resize((W,H), Image.LANCZOS)
a = np.asarray(ne).astype(np.float32)/255.0
lum = a.mean(axis=2, keepdims=True)
a = np.clip(lum + (a-lum)*1.12, 0, 1)
save(Image.fromarray((np.clip(a,0,1)*255).astype(np.uint8)), 'natural')

# ---------- shared inputs for the flat styles ----------
water = np.asarray(Image.open('/tmp/tg/example/img/earth-water.png').convert('L')
                   .resize((W,H), Image.LANCZOS)).astype(np.float32)/255.0
land = 1.0 - np.clip((water-0.45)/0.35, 0, 1)
topo = np.asarray(Image.open('/tmp/tg/example/img/earth-topology.png').convert('L')
                  .resize((W,H), Image.LANCZOS)).astype(np.float32)/255.0
neL  = Image.open(U+'ne2_5400.jpg').convert('L').resize((W,H), Image.LANCZOS)
Lf   = np.asarray(neL).astype(np.float32)
Lb   = np.asarray(neL.filter(ImageFilter.GaussianBlur(26))).astype(np.float32)
shade = np.clip(Lf/(Lb+1e-3), 0.78, 1.22)          # relative relief only, no landcover colour
prox = np.asarray(Image.fromarray((land*255).astype(np.uint8))
                  .filter(ImageFilter.GaussianBlur(7))).astype(np.float32)/255.0

def flat(name, lo, hi, peak, sea, shore, relief):
    e = np.clip(topo/0.55, 0, 1)[:,:,None]
    base = np.array(lo)[None,None,:]*(1-e) + np.array(hi)[None,None,:]*e
    snow = np.clip((topo-0.62)/0.28, 0, 1)[:,:,None]
    base = base*(1-snow) + np.array(peak)[None,None,:]*snow
    base = np.clip(base * (1.0 + (shade[:,:,None]-1.0)*relief), 0, 1)
    t = np.clip(prox*1.6, 0, 1)[:,:,None]
    sea_c = np.array(sea)[None,None,:]*(1-t) + np.array(shore)[None,None,:]*t
    img = base*land[:,:,None] + sea_c*(1-land[:,:,None])
    save(Image.fromarray((np.clip(img,0,1)*255).astype(np.uint8)), name)

# "Muted green" — WY's light monochrome, warmed toward the park green of Blue Gray
flat('mgreen', lo=(0.906,0.933,0.851), hi=(0.796,0.831,0.729),
     peak=(0.976,0.980,0.969), sea=(0.729,0.796,0.788), shore=(0.784,0.843,0.831),
     relief=1.5)
# "Muted blue" — Blue Gray: near-white land, soft blue water
flat('mblue', lo=(0.945,0.949,0.949), hi=(0.839,0.859,0.878),
     peak=(1.0,1.0,1.0), sea=(0.686,0.784,0.886), shore=(0.760,0.839,0.918),
     relief=1.35)
