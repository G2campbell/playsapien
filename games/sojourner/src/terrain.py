import numpy as np
from PIL import Image, ImageFilter
W,H=4096,2048
topo=Image.open('/tmp/tg/example/img/earth-topology.png').convert('L').resize((W,H),Image.LANCZOS)
water=Image.open('/tmp/tg/example/img/earth-water.png').convert('L').resize((W,H),Image.LANCZOS)
bm=Image.open('/tmp/tg/example/img/earth-blue-marble.jpg').convert('RGB').resize((W,H),Image.LANCZOS)
T=np.asarray(topo).astype(np.float32)/255.0
Wm=np.asarray(water).astype(np.float32)/255.0
B=np.asarray(bm).astype(np.float32)/255.0
land=1.0-np.clip((Wm-0.45)/0.35,0,1)          # 1 on land, 0 on ocean

# --- hypsometric ramp (Google-terrain-ish, muted) ---
stops=[(0.00,(0.839,0.878,0.800)),   # lowland pale green-grey
       (0.06,(0.804,0.851,0.741)),
       (0.14,(0.847,0.859,0.718)),   # yellow-green
       (0.26,(0.886,0.855,0.702)),   # tan
       (0.42,(0.859,0.784,0.647)),   # darker tan
       (0.60,(0.788,0.706,0.596)),   # brown
       (0.78,(0.855,0.827,0.804)),   # rock grey
       (1.00,(0.976,0.976,0.976))]   # snow
e=np.clip(T/0.72,0,1)
e=e**0.85
base=np.zeros((H,W,3),np.float32)
for i in range(len(stops)-1):
    a,ca=stops[i]; b,cb=stops[i+1]
    m=(e>=a)&(e<=b)
    t=((e-a)/(b-a))[m][:,None]
    base[m]=np.array(ca)*(1-t)+np.array(cb)*t

# --- blend a little real land-cover colour for variety ---
bmL=B.mean(axis=2,keepdims=True)+1e-6
bmc=np.clip(B/bmL,0,2.0)                       # chromaticity only
base=np.clip(base*(0.72+0.28*bmc),0,1)

# --- hillshade ---
Ts=np.asarray(topo.filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32)/255.0
gy,gx=np.gradient(Ts*38.0)
az,alt=np.radians(315.0),np.radians(45.0)
slope=np.arctan(np.sqrt(gx*gx+gy*gy))
aspect=np.arctan2(-gy,gx)
hs=np.sin(alt)*np.cos(slope)+np.cos(alt)*np.sin(slope)*np.cos(az-aspect)
hs=np.clip(hs,0,1); hs=0.62+0.58*hs
base=np.clip(base*hs[:,:,None],0,1)

# --- ocean ---
lat=np.linspace(90,-90,H)[:,None]
deep=np.array([0.208,0.325,0.443]); shallow=np.array([0.325,0.478,0.596])
prox=np.asarray(Image.fromarray((land*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(9))).astype(np.float32)/255.0
ocean=deep[None,None,:]*(1-prox[:,:,None]*1.5).clip(0,1)+shallow[None,None,:]*(prox[:,:,None]*1.5).clip(0,1)
ocean=ocean*(1.0-0.06*np.abs(lat/90.0))[:,:,None]

img=base*land[:,:,None]+ocean*(1-land[:,:,None])
# polar ice
ice=np.clip((np.abs(lat)-72)/12,0,1)*np.clip(1-Wm*0.0,0,1)
img=img*(1-ice[:,:,None]*0.75)+np.array([0.94,0.95,0.96])[None,None,:]*(ice[:,:,None]*0.75)
img=np.clip(img,0,1)
out=Image.fromarray((img*255).astype(np.uint8))
out.save('/tmp/build/terrain.jpg',quality=78,optimize=True,progressive=False)
out.resize((1024,512)).save('/tmp/build/terrain_preview.png')
import os; print('terrain.jpg',os.path.getsize('/tmp/build/terrain.jpg')//1024,'KB')
