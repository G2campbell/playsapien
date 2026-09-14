"""Give every place a representative point that is actually inside it.

group.py averages planar ring centroids in lon/lat. That is fine for a compact
shape in the middle of the map and wrong for anything that straddles the
antimeridian: Kiribati's stored point sat 13,700 km away in the Atlantic, the
Pacific Ocean's in the Caribbean. The reveal draws its arc to that point and
frames the camera on the midpoint, so a press on one of those places sent the
globe spinning to the wrong hemisphere and left the line hanging in open sea.

Here the point is recomputed as a 3D mean over the raster the game actually
picks from -- which has no seam -- and then snapped to a pixel the place really
owns, so the arc can never terminate outside it.
"""
import json, math, collections
from PIL import Image

D = math.pi/180
im = Image.open('idmap.png').convert('RGB'); W,H = im.size; px = im.load()
gd = json.load(open('gamedata.json'))

sx = collections.defaultdict(float); sy = collections.defaultdict(float)
sz = collections.defaultdict(float); n = collections.Counter()
cosw = collections.defaultdict(float)
rows = []
for y in range(H):
    lat = 90-(y+0.5)*180.0/H; cl = math.cos(lat*D); sl = math.sin(lat*D)
    row = []
    for x in range(W):
        r,g,b = px[x,y]; i = r+g*256
        if not i: continue
        lon = (x+0.5)*360.0/W-180.0
        vx = cl*math.cos(lon*D); vz = cl*math.sin(lon*D)
        # an equirectangular raster over-samples the poles, so weight by cos(lat)
        # or the mean drifts north for anything tall
        sx[i]+=vx*cl; sy[i]+=sl*cl; sz[i]+=vz*cl
        cosw[i]+=cl
        n[i]+=1
        row.append((x,i,vx,sl,vz,lon))
    rows.append((lat,row))

mean = {}
for i in n:
    x,y,z = sx[i],sy[i],sz[i]
    L = math.sqrt(x*x+y*y+z*z) or 1.0
    mean[i] = (x/L, y/L, z/L)

# the owned pixel that lies closest to that mean direction
best = {}
for lat,row in rows:
    for x,i,vx,vy,vz,lon in row:
        mx,my,mz = mean[i]
        d = vx*mx+vy*my+vz*mz
        cur = best.get(i)
        if cur is None or d > cur[0]: best[i] = (d, lon, lat)

def gckm(a,b):
    p1,p2 = a[1]*D, b[1]*D; dl = (b[0]-a[0])*D
    v = math.sin(p1)*math.sin(p2)+math.cos(p1)*math.cos(p2)*math.cos(dl)
    return math.degrees(math.acos(max(-1,min(1,v))))*111.32

moved = []
gX,gY = gd['gX'], gd['gY']
for i in n:
    if i >= len(gX): continue
    old = (gX[i]/100.0, gY[i]/100.0)
    _,lon,lat = best[i]
    d = gckm(old,(lon,lat))
    if d > 50: moved.append((d, gd['gL'][i] or gd['admins'][gd['gA'][i]]))
    gX[i] = round(lon*100); gY[i] = round(lat*100)

pmoved = []
for e in gd['pool']:
    ids = [i for i in e['t'] if i in n]
    if not ids: continue
    ax=ay=az=0.0
    for i in ids:
        ax+=sx[i]; ay+=sy[i]; az+=sz[i]
    L = math.sqrt(ax*ax+ay*ay+az*az) or 1.0
    ax,ay,az = ax/L, ay/L, az/L
    pick, bd = None, -2
    for i in ids:
        mx,my,mz = mean[i]
        # score each region by how near its own snapped pixel is to the whole
        d = mx*ax+my*ay+mz*az
        if d > bd: bd, pick = d, i
    _,lon,lat = best[pick]
    old = (e['x']/100.0, e['y']/100.0)
    d = gckm(old,(lon,lat))
    if d > 50: pmoved.append((d, e['n']+', '+e['c']))
    e['x'] = round(lon*100); e['y'] = round(lat*100)

# Every entry also gets an angular radius, taken from the raster it is actually
# picked from. The game uses it to decide when a place is too small to expect an
# exact hit -- until now only the 46 water bodies carried one.
STER = (math.pi/W)*(math.pi/H)*2       # steradians per pixel at the equator
for e in gd['pool']:
    ids = [i for i in e['t'] if i in n]
    if not ids: continue
    area = sum(cosw[i] for i in ids) * STER
    e['rad'] = round(math.sqrt(max(area,1e-12)/math.pi), 5)

moved.sort(reverse=True); pmoved.sort(reverse=True)
print('region points moved more than 50 km:', len(moved))
for d,nm in moved[:12]: print('   %8.0f km  %s' % (d,nm))
print('pool answers moved more than 50 km:', len(pmoved))
for d,nm in pmoved[:12]: print('   %8.0f km  %s' % (d,nm))
json.dump(gd, open('gamedata.json','w'), ensure_ascii=False, separators=(',',':'))
print('gamedata.json rewritten')
