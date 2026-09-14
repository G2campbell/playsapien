import pickle, numpy as np, math, os
from PIL import Image, ImageDraw
D=pickle.load(open('/tmp/build/groups.pkl','rb'))
I=pickle.load(open('/tmp/build/ids.pkl','rb'))
groups=D['groups']; meta=D['meta']; kid=I['kid']
W,H=4096,2048
img=Image.new('I',(W,H),0); dr=ImageDraw.Draw(img)

def ringarea(r):
    s=0.0
    for i in range(len(r)-1): s+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]
    return abs(s/2)

items=[]
for k,g in groups.items():
    gid=kid[k]
    for poly in g['polys']:
        items.append((ringarea(poly[0]), gid, poly[0]))
items.sort(key=lambda t:-t[0])
print('polys',len(items))

def topx(ring, shift=0.0):
    return [((lon+shift+180.0)/360.0*W, (90.0-lat)/180.0*H) for lon,lat in ring]

for a,gid,ring in items:
    lons=[p[0] for p in ring]
    span=max(lons)-min(lons)
    if span>180:
        r2=[((lon+360.0) if lon<0 else lon, lat) for lon,lat in ring]
        dr.polygon(topx(r2), fill=gid)
        dr.polygon(topx(r2,-360.0), fill=gid)
    else:
        dr.polygon(topx(ring), fill=gid)

A=np.array(img,dtype=np.uint32)
# ensure every group has at least a few pixels: stamp centroid area if missing
present=set(np.unique(A).tolist())
missing=[k for k in kid if kid[k] not in present]
print('missing groups',len(missing))
for k in missing:
    gid=kid[k]; v=meta[k]
    x=int((v['lon']+180)/360*W); y=int((90-v['lat'])/180*H)
    A[max(0,y-1):y+2, max(0,x-1):x+2]=gid
rgb=np.zeros((H,W,3),np.uint8)
rgb[:,:,0]=(A&255).astype(np.uint8)
rgb[:,:,1]=((A>>8)&255).astype(np.uint8)
Image.fromarray(rgb).save('/tmp/build/idmap.png',optimize=True)
print('idmap.png',os.path.getsize('/tmp/build/idmap.png')//1024,'KB','distinct',len(np.unique(A)))
