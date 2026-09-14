import pickle, json, math, collections, base64, struct, time
D=pickle.load(open('/tmp/build/groups.pkl','rb'))
groups=D['groups']; meta=D['meta']
keys=sorted(groups.keys(), key=lambda k:(-meta[k]['area']))
kid={k:i+1 for i,k in enumerate(keys)}   # 1-based ids
print('groups',len(keys))

Q=100.0  # 0.01 deg
def qz(pt):
    return (int(round(pt[0]*Q)), int(round(pt[1]*Q)))

t0=time.time()
seg=collections.defaultdict(list)   # (a,b) -> [gid,...]
segn=collections.Counter()          # (a,b) -> how many rings walked it
ringq={}   # (key, idx) -> quantized ring
for k in keys:
    gid=kid[k]
    for pi,poly in enumerate(groups[k]['polys']):
        for ri,ring in enumerate(poly):
            q=[]
            last=None
            for pt in ring:
                p=qz(pt)
                if p!=last: q.append(p); last=p
            if len(q)<3: continue
            if q[0]!=q[-1]: q.append(q[0])
            ringq[(k,pi,ri)]=q
            for i in range(len(q)-1):
                a,b=q[i],q[i+1]
                key=(a,b) if a<b else (b,a)
                segn[key]+=1
                o=seg[key]
                if gid not in o: o.append(gid)
print('segments',len(seg),'%.1fs'%(time.time()-t0))

# An edge with one owner is either true coastline (walked by one ring) or an edge
# between two pieces of the same group. The second kind is a border we deliberately
# dissolved -- a county line inside England, a departement inside a French region --
# so it is dropped outright: not drawn on the map, and invisible to the highlighter.
interior={k for k,o in seg.items() if len(o)==1 and segn[k]>=2}
print('interior edges inside a dissolved group:', len(interior))

# classify
admin_of={kid[k]:meta[k]['admin'] for k in keys}
cls={}
for s,ow in seg.items():
    if len(ow)==1:
        if s in interior: continue
        cls[s]=0
    elif len(ow)>=2:
        if ow[0]==ow[1]: continue
        cls[s]= 2 if admin_of[ow[0]]!=admin_of[ow[1]] else 1
print('classified',len(cls))

# chain into polylines per (class, owner-pair)
def chain(segs):
    adj=collections.defaultdict(list)
    for i,(a,b) in enumerate(segs): adj[a].append(i); adj[b].append(i)
    used=[False]*len(segs); out=[]
    def walk(start,si):
        line=[start]; cur=start; idx=si
        while True:
            used[idx]=True
            a,b=segs[idx]
            nxt = b if a==cur else a
            line.append(nxt); cur=nxt
            cand=[j for j in adj[cur] if not used[j]]
            if len(cand)!=1: break
            idx=cand[0]
        return line
    # start from endpoints with degree != 2
    for node,ids in adj.items():
        if len(ids)!=2:
            for i in ids:
                if not used[i]: out.append(walk(node,i))
    for i in range(len(segs)):
        if not used[i]:
            out.append(walk(segs[i][0],i))
    return out

def dp(pts,tol):
    if len(pts)<3: return pts
    keep=[False]*len(pts); keep[0]=keep[-1]=True
    stack=[(0,len(pts)-1)]
    while stack:
        i,j=stack.pop()
        if j<=i+1: continue
        x1,y1=pts[i]; x2,y2=pts[j]
        dx,dy=x2-x1,y2-y1; d2=dx*dx+dy*dy
        best=-1.0; bi=-1
        for m in range(i+1,j):
            x,y=pts[m]
            if d2==0: dd=(x-x1)**2+(y-y1)**2
            else:
                t=((x-x1)*dx+(y-y1)*dy)/d2
                t=0 if t<0 else (1 if t>1 else t)
                px,py=x1+t*dx,y1+t*dy
                dd=(x-px)**2+(y-py)**2
            if dd>best: best=dd; bi=m
        if best>tol*tol:
            keep[bi]=True; stack.append((i,bi)); stack.append((bi,j))
    return [p for p,kp in zip(pts,keep) if kp]

TOL={0:0.9,1:1.1,2:0.9}
buckets=collections.defaultdict(list)
for s_,cc in cls.items():
    ow=sorted(seg[s_])
    buckets[(cc,tuple(ow))].append(s_)
lines_by_class={0:[],1:[],2:[]}
for (cc,ow),segs in buckets.items():
    for l in chain(segs):
        l=dp(l,TOL[cc])
        if len(l)>=2:
            lines_by_class[cc].append((l,ow[0],ow[1] if len(ow)>1 else 0))
for c in (0,1,2):
    print('class',c,'lines',len(lines_by_class[c]),'pts',sum(len(l[0]) for l in lines_by_class[c]))

def enc(lines):
    out=bytearray()
    def put(v):
        v=(v<<1)^(v>>63) if v<0 else (v<<1)
        while True:
            b=v&0x7f; v>>=7
            if v: out.append(b|0x80)
            else: out.append(b); break
    put(len(lines))
    for l,o1,o2 in lines:
        put(len(l)); put(o1); put(o2); px=py=0
        for x,y in l:
            put(x-px); put(y-py); px,py=x,y
    return base64.b64encode(bytes(out)).decode()

payload={'q':Q,'coast':enc(lines_by_class[0]),'admin':enc(lines_by_class[1]),'country':enc(lines_by_class[2])}
json.dump(payload,open('/tmp/build/borders.json','w'))
import os
for c in ('coast','admin','country'): print(c, len(payload[c])//1024,'KB')
pickle.dump({'keys':keys,'kid':kid},open('/tmp/build/ids.pkl','wb'))
