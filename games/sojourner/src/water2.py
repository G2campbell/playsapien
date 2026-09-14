import pickle, json, numpy as np
from PIL import Image, ImageDraw
D=pickle.load(open('groups.pkl','rb')); meta=D['meta']
I=pickle.load(open('ids.pkl','rb')); kid=I['kid']; keys=I['keys']
water=pickle.load(open('water.pkl','rb'))
W,H=4096,2048
base=np.array(Image.open('idmap.png').convert('RGB'))
cur=base[:,:,0].astype(np.uint32) + base[:,:,1].astype(np.uint32)*256

nxt=len(keys)+1
img=Image.new('I',(W,H),0); dr=ImageDraw.Draw(img)
items=[]
for e in water:
    e['id']=nxt; nxt+=1
    for r in e['rings']:
        lons=[p[0] for p in r]
        items.append((max(lons)-min(lons) if True else 0, e['area'], e['id'], r))
items.sort(key=lambda t:-t[1])          # biggest water body first, small seas on top
LAKE = set(e['id'] for e in water if e['name'].startswith('Lake '))
def topx(r, shift=0.0):
    return [((lo+shift+180.0)/360.0*W, (90.0-la)/180.0*H) for lo,la in r]
for _,_,wid,r in items:
    lons=[p[0] for p in r]
    if max(lons)-min(lons) > 180:
        r2=[((lo+360.0) if lo<0 else lo, la) for lo,la in r]
        dr.polygon(topx(r2), fill=wid); dr.polygon(topx(r2,-360.0), fill=wid)
    else:
        dr.polygon(topx(r), fill=wid)
A=np.array(img, dtype=np.uint32)
# marine areas fill only open water; the Great Lakes sit inside state polygons and
# have to win over them
isLake=np.isin(A, list(LAKE))
merged=np.where(isLake, A, np.where(cur>0, cur, A))
out=np.zeros((H,W,3),np.uint8)
out[:,:,0]=(merged & 255).astype(np.uint8)
out[:,:,1]=((merged>>8)&255).astype(np.uint8)
Image.fromarray(out).save('idmap.png', optimize=True)
import os; print('idmap.png', os.path.getsize('idmap.png')//1024,'KB')

present=set(np.unique(merged).tolist())
gone=[e['name'] for e in water if e['id'] not in present]
print('water bodies with no pixels:', gone)
pickle.dump(water, open('water.pkl','wb'))
# a batch list for the fact research
open('batches/water.txt','w').write('\n'.join('%d\t%s'%(i,e['name']) for i,e in enumerate(water)))
print('total ids now', max(present))
