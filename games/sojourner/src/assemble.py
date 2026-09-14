import json, pickle, base64, os, glob
D=pickle.load(open('groups.pkl','rb')); meta=D['meta']
I=pickle.load(open('ids.pkl','rb')); kid=I['kid']; keys=I['keys']
pool=json.load(open('pool.json'))

# Facts are matched to places by name, not by position. Position keying broke once
# already when new entries were appended ahead of Palestine; a fact silently moving
# to the wrong country is the worst failure this build has, so it is keyed on the
# thing that identifies the place.
def placename(e): return e['name'] if e['name']==e['country'] else e['name']+', '+e['country']
raw=[]
for f in sorted(glob.glob('facts/b*.json')): raw += json.load(open(f))
raw += json.load(open('facts/palestine.json'))
where={}
for i,e in enumerate(pool): where.setdefault(placename(e), []).append(i)
# a place may hold several stories; the game shows one, chosen per day
facts={}; unmatched=[]; ambiguous=[]
for e in raw:
    hit=where.get(e['place'], [])
    if len(hit)==1: facts.setdefault(hit[0], []).append(e)
    elif not hit: unmatched.append(e['place'])
    else: ambiguous.append(e['place'])
print('facts', sum(len(v) for v in facts.values()), 'on', len(facts), 'places of', len(pool))
_multi=sum(1 for v in facts.values() if len(v)>1)
if _multi: print('  places holding more than one story:', _multi)
if unmatched: print('  !! facts with no place in the pool:', len(unmatched), unmatched[:8])
if ambiguous: print('  !! facts matching more than one place:', len(ambiguous), ambiguous[:8])
missing=[i for i in range(len(pool)) if i not in facts and not pool[i].get('todo')]
print('facts still to research:', sum(1 for i,p in enumerate(pool) if p.get('todo') and i not in facts))
print('unexpectedly missing:', missing[:10], len(missing))

admins=sorted(set(meta[k]['admin'] for k in keys)) + ['Water']
WATER_A=len(admins)-1
aidx={a:i for i,a in enumerate(admins)}
n=len(keys)
gA=[0]*(n+1); gLon=[0]*(n+1); gLat=[0]*(n+1); gL=['']*(n+1)
for k in keys:
    i=kid[k]; v=meta[k]
    gA[i]=aidx[v['admin']]; gLon[i]=round(v['lon']*100); gLat[i]=round(v['lat']*100)
    gL[i]=v['label']

out=[]
for i,e in enumerate(pool):
    fa=facts.get(i,[])
    a0 = gA[kid[tuple(e['keys'][0]) if isinstance(e['keys'][0],list) else e['keys'][0]]]
    row={'r':e['round'],'n':e['name'],'c':e['country'],'a':a0,
        't':[kid[tuple(k) if isinstance(k,list) else k] for k in e['keys']],
        'x':round(e['lon']*100),'y':round(e['lat']*100),
        'fs':[[x.get('fact',''), x.get('source_title',''), x.get('source_url','')]
              + ([x['journey']] if x.get('journey') else []) for x in fa]}
    if e.get('todo') and not fa: row['todo']=1   # researched now, no longer outstanding
    out.append(row)
# ---- water bodies ----
import math, pickle as _p
water=_p.load(open('water.pkl','rb'))
wfacts={int(e['id']):e for e in json.load(open('facts/water.json'))}
flagmap=json.load(open('flagmap.json'))
adm2cc={v:k for k,v in flagmap.items()}
R2E=6371.0088**2
for i,e in enumerate(water):
    wid=e['id']
    while len(gA)<=wid: gA.append(0); gLon.append(0); gLat.append(0); gL.append('')
    gA[wid]=WATER_A; gLon[wid]=round(e['lon']*100); gLat[wid]=round(e['lat']*100); gL[wid]=e['name']
    fa=wfacts.get(i,{})
    th=math.acos(max(-1.0, min(1.0, 1 - e['area']/(2*math.pi*R2E))))
    out.append({'r':e['round'],'n':e['name'],'c':e['name'],'a':WATER_A,'w':1,
                't':[wid],'x':round(e['lon']*100),'y':round(e['lat']*100),
                'rad':round(th,4),
                'fs':[[fa.get('fact',''), fa.get('source_title',''), fa.get('source_url','')]]
                       if fa.get('fact') else []})
# ---- flag codes for whole-country questions in the later rounds ----
adm2cc['West Bank']='PS'
nflag=0  # PS_FIX
for e in out:
    if e.get('w') or e['r']<3 or e['n']!=e['c']: continue
    cc=adm2cc.get(admins[e['a']])
    if cc: e['fl']=cc.lower(); nflag+=1
print('water entries', len(water), '| flagged country entries', nflag)
import collections as _c
print('pool by round', dict(sorted(_c.Counter(p['r'] for p in out).items())))
flagA={}
# every country that appears anywhere in the pool gets a flag, so Flags-only mode
# can ask for Canada or Brazil the same way it asks for Ghana
_full=json.load(open('adm2cc.json'))
for _adm,_cc in _full.items():
    if _adm in aidx: flagA[aidx[_adm]] = _cc.lower()
for _adm,_cc in adm2cc.items():
    if _adm in aidx: flagA[aidx[_adm]] = _cc.lower()
print('admins with a flag:', len(flagA))
data={'admins':admins,'flagA':flagA,'gL':gL,'gA':gA,'gX':gLon,'gY':gLat,'pool':out,
      'borders':json.load(open('borders.json'))}
json.dump(data,open('gamedata.json','w'),ensure_ascii=False,separators=(',',':'))
print('gamedata.json',os.path.getsize('gamedata.json')//1024,'KB')
for f,nm in (('terrain.jpg','terrain'),('idmap.png','idmap')):
    b=base64.b64encode(open(f,'rb').read()).decode()
    open(nm+'.b64','w').write(b); print(nm,len(b)//1024,'KB b64')
