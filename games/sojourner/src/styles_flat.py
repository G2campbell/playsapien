# ---------- shared inputs for the flat styles ----------
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
    snow = np.clip((topo-0.70)/0.26, 0, 1)[:,:,None]*0.7
    base = base*(1-snow) + np.array(peak)[None,None,:]*snow
    base = np.clip(base * (1.0 + (shade[:,:,None]-1.0)*relief), 0, 1)
    t = np.clip(prox*2.2, 0, 1)[:,:,None]
    sea_c = np.array(sea)[None,None,:]*(1-t) + np.array(shore)[None,None,:]*t
    img = base*land[:,:,None] + sea_c*(1-land[:,:,None])
    save(Image.fromarray((np.clip(img,0,1)*255).astype(np.uint8)), name)

# "Muted green" — WY's light monochrome, warmed toward the park green of Blue Gray
flat('mgreen', lo=(0.863,0.894,0.808), hi=(0.706,0.753,0.627),
     peak=(0.949,0.957,0.937), sea=(0.435,0.553,0.541), shore=(0.545,0.655,0.639),
     relief=1.75)
# "Muted blue" — Blue Gray: near-white land, soft blue water
flat('mblue', lo=(0.933,0.941,0.949), hi=(0.749,0.784,0.827),
     peak=(0.988,0.992,1.0), sea=(0.412,0.545,0.686), shore=(0.545,0.667,0.792),
     relief=1.55)
