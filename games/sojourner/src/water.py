import json, math, pickle, collections
from PIL import Image, ImageDraw
import numpy as np

MAR='/tmp/ne/geojson/ne_10m_geography_marine_polys.geojson'
LAK='/tmp/ne/geojson/ne_10m_lakes.geojson'

# name in the data -> (display name, round).  Oceans are stored split; both halves
# become one answer.
R1 = [('Lake Superior','Lake Superior'),('Lake Michigan','Lake Michigan'),
      ('Lake Huron','Lake Huron'),('Lake Erie','Lake Erie'),('Lake Ontario','Lake Ontario'),
      (['North Pacific Ocean','South Pacific Ocean'],'Pacific Ocean'),
      (['North Atlantic Ocean','South Atlantic Ocean'],'Atlantic Ocean'),
      ('Gulf of Mexico','Gulf of Mexico')]
R2 = [('Mediterranean Sea','Mediterranean Sea'),('Caribbean Sea','Caribbean Sea'),
      ('Red Sea','Red Sea'),('Black Sea','Black Sea'),('Persian Gulf','Persian Gulf'),
      ('South China Sea','South China Sea'),('INDIAN OCEAN','Indian Ocean'),
      ('Arctic Ocean','Arctic Ocean'),('North Sea','North Sea'),('Baltic Sea','Baltic Sea'),
      ('English Channel','English Channel'),('Bay of Bengal','Bay of Bengal'),
      ('Arabian Sea','Arabian Sea'),('Sea of Japan','Sea of Japan'),
      ('Gulf of Aden','Gulf of Aden'),('Yellow Sea','Yellow Sea')]
R3 = [('Aegean Sea','Aegean Sea'),('Adriatic Sea','Adriatic Sea'),('Coral Sea','Coral Sea'),
      ('Tasman Sea','Tasman Sea'),('Andaman Sea','Andaman Sea'),('Sea of Okhotsk','Sea of Okhotsk'),
      ('Barents Sea','Barents Sea'),('Hudson Bay','Hudson Bay'),('Philippine Sea','Philippine Sea'),
      ('Java Sea','Java Sea'),('Labrador Sea','Labrador Sea'),('Beaufort Sea','Beaufort Sea'),
      ('Bering Sea','Bering Sea'),('Gulf of Guinea','Gulf of Guinea'),
      ('East China Sea','East China Sea'),('Norwegian Sea','Norwegian Sea'),
      ('Bay of Biscay','Bay of Biscay'),('Gulf of Thailand','Gulf of Thailand'),
      ('Mozambique Channel','Mozambique Channel'),('Tyrrhenian Sea','Tyrrhenian Sea'),
      ('Arafura Sea','Arafura Sea'),('Gulf of Alaska','Gulf of Alaska')]

feats = collections.defaultdict(list)
for path in (MAR, LAK):
    for f in json.load(open(path))['features']:
        n = f['properties'].get('name')
        if n and f.get('geometry'): feats[n].append(f)

def polys(g):
    return g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
def sph_area(r):
    s=0.0
    for i in range(len(r)-1):
        x1,y1=math.radians(r[i][0]),math.radians(r[i][1])
        x2,y2=math.radians(r[i+1][0]),math.radians(r[i+1][1])
        s+=(x2-x1)*(2+math.sin(y1)+math.sin(y2))
    return abs(s/2.0)*6371.0088**2
def ring_area(r):
    s=0.0
    for i in range(len(r)-1): s+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]
    return abs(s/2)

entries=[]; missing=[]
for rnd, lst in ((1,R1),(2,R2),(3,R3)):
    for src, disp in lst:
        keys = src if isinstance(src, list) else [src]
        got = [f for k in keys for f in feats.get(k, [])]
        if not got: missing.append(disp); continue
        rings=[]; tot=0.0; cx=cy=0.0
        for f in got:
            for p in polys(f['geometry']):
                rings.append(p[0])
                a=sph_area(p[0]); A=ring_area(p[0])
                r=p[0]
                if A<1e-9:
                    mx=sum(q[0] for q in r)/len(r); my=sum(q[1] for q in r)/len(r)
                else:
                    sx=sy=0.0
                    for i in range(len(r)-1):
                        x1,y1=r[i][0],r[i][1]; x2,y2=r[i+1][0],r[i+1][1]
                        cr=x1*y2-x2*y1; sx+=(x1+x2)*cr; sy+=(y1+y2)*cr
                    signed=0.0
                    for i in range(len(r)-1): signed+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]
                    signed/=2
                    mx=sx/(6*signed); my=sy/(6*signed)
                tot+=a; cx+=mx*a; cy+=my*a
        entries.append({'name':disp,'round':rnd,'rings':rings,'area':tot,
                        'lon':cx/tot,'lat':cy/tot})
print('water entries', len(entries), 'missing', missing)
pickle.dump(entries, open('/tmp/build/water.pkl','wb'))
for e in entries[:4]: print('  %-20s r%d  %8.0f km2  (%.1f, %.1f)' % (e['name'],e['round'],e['area'],e['lon'],e['lat']))
