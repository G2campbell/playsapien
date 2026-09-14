import numpy as np, os
from PIL import Image, ImageFilter
Image.MAX_IMAGE_PIXELS = None
SRC='/tmp/bm/data/basemap_data/src/mpl_toolkits/basemap_data/shadedrelief.jpg'

# ---------- 1. colour base (4096 x 2048) ----------
CW,CH=4096,2048
base = Image.open(SRC).convert('RGB').resize((CW,CH), Image.LANCZOS)
B = np.asarray(base).astype(np.float32)/255.0
water = Image.open('/tmp/tg/example/img/earth-water.png').convert('L').resize((CW,CH), Image.LANCZOS)
Wm = np.asarray(water).astype(np.float32)/255.0
land = 1.0 - np.clip((Wm-0.45)/0.35, 0, 1)

# grade the land a little: lift saturation and contrast so it reads at small sizes
lum = B.mean(axis=2, keepdims=True)
land_col = np.clip(lum + (B-lum)*1.22, 0, 1)
land_col = np.clip((land_col-0.5)*1.06 + 0.5 + 0.012, 0, 1)
land_col = np.clip(land_col*np.array([1.045,1.012,0.93])[None,None,:], 0, 1)   # warm the greens off mint

# our own ocean, matching the app's ink palette
lat = np.linspace(90,-90,CH)[:,None]
deep = np.array([0.208,0.325,0.443]); shallow = np.array([0.325,0.478,0.596])
prox = np.asarray(Image.fromarray((land*255).astype(np.uint8))
                  .filter(ImageFilter.GaussianBlur(9))).astype(np.float32)/255.0
t = np.clip(prox*1.5, 0, 1)[:,:,None]
ocean = deep[None,None,:]*(1-t) + shallow[None,None,:]*t
ocean = ocean*(1.0 - 0.06*np.abs(lat/90.0))[:,:,None]

img = land_col*land[:,:,None] + ocean*(1-land[:,:,None])
ice = np.clip((np.abs(lat)-74)/10, 0, 1)*land
img = img*(1-ice[:,:,None]*0.55) + np.array([0.95,0.96,0.965])[None,None,:]*(ice[:,:,None]*0.55)
Image.fromarray((np.clip(img,0,1)*255).astype(np.uint8)).save('/tmp/build/terrain.jpg',
                                                              quality=80, optimize=True)
Image.fromarray((np.clip(img,0,1)*255).astype(np.uint8)).resize((1024,512)).save('/tmp/build/terrain_preview.png')
print('terrain.jpg', os.path.getsize('/tmp/build/terrain.jpg')//1024, 'KB')
del B, base, land_col, ocean, img

# ---------- 2. high-frequency relief detail (8192 x 4096, greyscale) ----------
DW,DH=8192,4096
L = Image.open(SRC).convert('L').resize((DW,DH), Image.LANCZOS)
Lf = np.asarray(L).astype(np.float32)
blur = np.asarray(L.filter(ImageFilter.GaussianBlur(2.6))).astype(np.float32)
res = (Lf - blur)                        # high-pass: ridges, valleys, coastal texture
print('residual std %.2f  p99 %.1f' % (res.std(), np.percentile(np.abs(res),99)))
d = np.clip(0.5 + res*(0.9/255.0), 0, 1)
Image.fromarray((d*255).astype(np.uint8)).save('/tmp/build/detail.jpg', quality=82, optimize=True)
print('detail.jpg', os.path.getsize('/tmp/build/detail.jpg')//1024, 'KB')
