# -*- coding: utf-8 -*-
import pickle, unicodedata, re, json, sys, collections
D=pickle.load(open('/tmp/build/groups.pkl','rb'))
meta=D['meta']

def norm(s):
    s=unicodedata.normalize('NFKD',str(s))
    s=''.join(c for c in s if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]','',s.lower())

# index: admin -> {normlabel: key}
idx=collections.defaultdict(dict)
adminmap=collections.defaultdict(list)
for k,v in meta.items():
    idx[norm(v['admin'])][norm(v['label'])]=k
    adminmap[norm(v['admin'])].append(v['label'])

ALIAS={'unitedstates':'unitedstatesofamerica','usa':'unitedstatesofamerica',
 'tanzania':'unitedrepublicoftanzania','drc':'democraticrepublicofthecongo',
 'congodrc':'democraticrepublicofthecongo','congobrazzaville':'republicofcongo',
 'congo':'republicofcongo','ivorycoast':'ivorycoast','czechia':'czechia',
 'southkorea':'southkorea','northkorea':'northkorea',
 'eswatini':'eswatini','myanmar':'myanmar','bosnia':'bosniaandherzegovina',
 'macedonia':'macedonia','northmacedonia':'macedonia','easttimor':'easttimor',
 'timorleste':'easttimor','vatican':'vatican','serbia':'republicofserbia',
 'guineabissau':'guineabissau','saotomeandprincipe':'saotomeandprincipe',
 'gambia':'gambia','bahamas':'thebahamas','micronesia':'federatedstatesofmicronesia',
 'unitedarabemirates':'unitedarabemirates','uae':'unitedarabemirates'}

def find(country, region=None):
    ck=norm(country); ck=ALIAS.get(ck,ck)
    if ck not in idx:
        cand=[a for a in idx if ck in a or a in ck]
        if len(cand)==1: ck=cand[0]
        else: return None,'NOCOUNTRY:%s %s'%(country,cand[:4])
    if region is None:
        # whole-country entry: must be a single 'C' group, else return all keys of that admin
        keys=[k for k,v in meta.items() if norm(v['admin'])==ck]
        return ('COUNTRY',ck,keys),None
    rk=norm(region)
    if rk in idx[ck]: return ('GROUP',idx[ck][rk]),None
    cand=[(l,k) for l,k in idx[ck].items() if rk in l or l in rk]
    if len(cand)==1: return ('GROUP',cand[0][1]),None
    return None,'NOREGION:%s/%s -> %s'%(country,region,sorted(adminmap[ck])[:40])
