import json, math, collections, unicodedata, re, pickle

SRC='/tmp/ne/geojson/ne_10m_admin_1_states_provinces.geojson'
d=json.load(open(SRC))
fs=[f for f in d['features'] if f.get('geometry')]

# ---- helpers ----
def polys(geom):
    t=geom['type']; c=geom['coordinates']
    if t=='Polygon': return [c]
    if t=='MultiPolygon': return c
    return []

def ring_area(r):  # signed planar area in deg^2 (fine for ordering)
    s=0.0
    for i in range(len(r)-1):
        x1,y1=r[i][0],r[i][1]; x2,y2=r[i+1][0],r[i+1][1]
        s+=x1*y2-x2*y1
    return s/2.0

def sph_area(r):  # steradian-ish, area weight
    s=0.0
    for i in range(len(r)-1):
        x1,y1=math.radians(r[i][0]),math.radians(r[i][1])
        x2,y2=math.radians(r[i+1][0]),math.radians(r[i+1][1])
        s+=(x2-x1)*(2+math.sin(y1)+math.sin(y2))
    return abs(s/2.0)*6371.0088**2

by_admin=collections.defaultdict(list)
for f in fs: by_admin[f['properties']['admin']].append(f)

# country total area
country_area={}
for a,lst in by_admin.items():
    tot=0
    for f in lst:
        for p in polys(f['geometry']): tot+=sph_area(p[0])
    country_area[a]=tot

OVERRIDE_UNUSED={
 'United Kingdom':'geonunit',
 'France':'region','Italy':'region','Spain':'region','Philippines':'region',
 'Portugal':'region','Greece':'region','Netherlands':'name','Denmark':'name',
 'Slovenia':'country','Latvia':'country','Malta':'country','Macedonia':'country',
 'Moldova':'country','Estonia':'country','Lithuania':'country','Albania':'country',
 'Montenegro':'country','Kosovo':'country','Luxembourg':'country','Cyprus':'country',
 'North Macedonia':'country','Bosnia and Herzegovina':'name','Belgium':'region',
 'Ireland':'region','Uganda':'region','Burkina Faso':'region','Azerbaijan':'country',
 'Armenia':'country','Georgia':'name','Lebanon':'country','Israel':'country',
 'Palestine':'country','Qatar':'country','Kuwait':'country','Bahrain':'country',
 'Jamaica':'country','Haiti':'country','Dominican Republic':'country','Trinidad and Tobago':'country',
 'El Salvador':'country','Belize':'country','Costa Rica':'country','Panama':'country',
 'Rwanda':'country','Burundi':'country','Djibouti':'country','Gambia':'country',
 'Eswatini':'country','Swaziland':'country','Lesotho':'country','Togo':'country',
 'Benin':'country','Sierra Leone':'country','Liberia':'country','Guinea-Bissau':'country',
 'Equatorial Guinea':'country','Comoros':'country','Cabo Verde':'country','Mauritius':'country',
 'Seychelles':'country','Sao Tome and Principe':'country','Singapore':'country',
 'Brunei':'country','Bhutan':'country','Nepal':'region','Sri Lanka':'region',
 'Bangladesh':'name','Taiwan':'country','South Korea':'name','North Korea':'name',
 'Switzerland':'name','Austria':'name','Czechia':'name','Slovakia':'name',
 'Croatia':'name','Serbia':'name','Hungary':'name','Romania':'name','Bulgaria':'name',
 'Vanuatu':'country','Fiji':'country','Solomon Islands':'country','Samoa':'country',
 'Tonga':'country','Kiribati':'country','Palau':'country','Nauru':'country','Tuvalu':'country',
 'Marshall Islands':'country','Federated States of Micronesia':'country','Maldives':'country',
 'Andorra':'country','Monaco':'country','San Marino':'country','Liechtenstein':'country',
 'Vatican':'country','Antigua and Barbuda':'country','Barbados':'country','Grenada':'country',
 'Saint Lucia':'country','Saint Vincent and the Grenadines':'country','Dominica':'country',
 'Saint Kitts and Nevis':'country','Bahamas':'country','Timor-Leste':'country','East Timor':'country',
}

FORCE_REGION={'France','Italy','Spain','Philippines','Portugal','Belgium','Ireland'}
FORCE_COUNTRY={
 # under 150,000 km2 - the whole country is the sensible unit
 'Lesotho','Guinea Bissau','Taiwan','Bhutan','Dominican Republic','Costa Rica',
 'Togo','Sierra Leone','Panama','Liberia','Benin','Malawi','Eritrea','Suriname',
 # first-level units Natural Earth itself ranks as low-prominence, and tiny with it
 'Guinea','Burkina Faso','Ivory Coast','Tunisia','Senegal','Guyana',
 'Slovenia','Latvia','Malta','Macedonia','Moldova','Azerbaijan','Armenia',
 'Republic of Serbia','Croatia','Bosnia and Herzegovina','Sri Lanka','Nepal','Estonia',
 'Lithuania','Albania','Montenegro','Kosovo','Northern Cyprus','Somaliland','West Bank',
 'Gaza Strip','Aland','Antarctica'}
def policy(admin):
    lst=by_admin[admin]
    if admin=='United Kingdom': return 'geonunit'
    if admin in FORCE_REGION: return 'region'
    if admin in FORCE_COUNTRY: return 'country'
    n=len(lst)
    if n==1: return 'country'
    area=country_area[admin]
    if area < 30000: return 'country'
    if n>35 and area/n < 2200: return 'country'
    return 'name'

groups=collections.defaultdict(lambda: {'polys':[], 'names':[], 'admin':None, 'iso':None})
for admin,lst in by_admin.items():
    pol=policy(admin)
    for f in lst:
        p=f['properties']
        if pol=='country': key=('C',admin)
        elif pol=='region':
            r=p.get('region') or p.get('name')
            key=('R',admin,str(r))
        elif pol=='geonunit':
            key=('G',admin,str(p.get('geonunit') or p.get('name')))
        else: key=('N',admin,str(p.get('name') or p.get('iso_3166_2') or p.get('adm1_code')))
        g=groups[key]
        g['admin']=admin
        g['names'].append(p.get('name'))
        g['iso']=g['iso'] or p.get('iso_3166_2')
        for pp in polys(f['geometry']): g['polys'].append(pp)

out={}
for key,g in groups.items():
    kind=key[0]
    label = key[1] if kind=='C' else key[2]
    tot=0.0; cx=0.0; cy=0.0
    for pp in g['polys']:
        a=sph_area(pp[0])
        r=pp[0]
        # ring centroid (planar, ok)
        A=ring_area(r)
        if abs(A)<1e-12:
            mx=sum(q[0] for q in r)/len(r); my=sum(q[1] for q in r)/len(r)
        else:
            sx=sy=0.0
            for i in range(len(r)-1):
                x1,y1=r[i][0],r[i][1]; x2,y2=r[i+1][0],r[i+1][1]
                cr=x1*y2-x2*y1; sx+=(x1+x2)*cr; sy+=(y1+y2)*cr
            mx=sx/(6*A); my=sy/(6*A)
        tot+=a; cx+=mx*a; cy+=my*a
    if tot<=0: tot=1e-9
    out[key]={'label':label,'admin':g['admin'],'kind':kind,'area':tot,
              'lon':cx/tot,'lat':cy/tot,'npoly':len(g['polys']),'iso':g['iso']}

pickle.dump({'groups':dict(groups),'meta':out}, open('/tmp/build/groups.pkl','wb'))
print('groups:',len(out))
pols=collections.Counter(policy(a) for a in by_admin)
print(pols)
byadm=collections.Counter(v['admin'] for v in out.values())
print('top:',byadm.most_common(20))
print('num admins:',len(byadm))
