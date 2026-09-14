import json, random
from collections import defaultdict
from wordfreq import zipf_frequency as z

P = json.load(open('pairs.json'))
BADNODE = set("""comp any ver ter led son vice king ends ate ese ette rice send ship
sonian corporal logical ability ace sur surf subs pace neo para onto marc ella don
con rec eng dad ish gether howe loo fri uni ted sup ser cal differ import follow
some every with out up down side line back over under off""".split())
# the last row are HUBS: allowed, but heavily penalised below (not removed)
HUBS = set("some every with out up down side line back over under off in on set stand".split())
BADNODE -= HUBS

edges = defaultdict(list); score = {}
for k,(form,zf,disp) in P.items():
    a,b = k.split('|')
    if a in BADNODE or b in BADNODE: continue
    if z(a,'en') < 3.4 or z(b,'en') < 3.4: continue
    s = zf if form=='closed' else max(zf, 3.1)
    if s < 2.5: continue
    edges[a].append(b); score[(a,b)] = s

# ambiguity: given prev word and the revealed first letter, how many decent rivals?
def rivals(prev, letter, floor=2.7):
    return sum(1 for w in edges.get(prev,()) if w[0]==letter and score[(prev,w)]>=floor)

best = []
seen = set()
def dfs(path, mn, tot, maxamb):
    if len(path)==8:
        key = tuple(path)
        if key in seen: return
        seen.add(key)
        best.append((round(mn,2), round(tot/7,2), maxamb, list(path)))
        return
    if len(best) > 120000: return
    last = path[-1]
    for nxt in edges.get(last, ()):
        if nxt in path: continue
        s = score[(last,nxt)]
        if s < 2.7: continue
        amb = rivals(last, nxt[0])
        if amb > 4: continue                      # cap ambiguity per step
        hubpen = 1 if nxt in HUBS else 0
        if sum(1 for w in path if w in HUBS) + hubpen > 2: continue   # at most 2 hub words
        dfs(path+[nxt], min(mn,s), tot+s, max(maxamb, amb))

order = sorted(edges, key=lambda w: -z(w,'en'))
for start in order:
    dfs([start], 9.9, 0.0, 0)
    if len(best) > 120000: break

print("chains:", len(best))
best.sort(key=lambda r: (r[2], -r[0], -r[1]))
for mn, mean, amb, p in best[:30]:
    print(f"amb{amb} min{mn} mean{mean}  " + " · ".join(w.upper() for w in p))
json.dump(best, open('chains2.json','w'))
