"""Order the chains into a daily calendar (a cycle) so that a repeated pair,
and as far as possible a repeated word, comes back as late as possible.
Simulated annealing over swaps, with an incremental cost."""
import json, random, collections, math, bisect
keep = json.load(open('all.json.final')); N = len(keep)
items = []
for r in keep:
    w = r['words']
    items.append([('p', a + '_' + b) for a, b in zip(w, w[1:])] + [('w', x) for x in w])
def icost(kind, ts):
    if len(ts) < 2: return 0
    s = 0
    for a, b in zip(ts, ts[1:] + [ts[0] + N]):
        g = b - a
        s += (max(0, 130 - g) ** 2) * 10 if kind == 'p' else max(0, 6 - g) ** 2
    return s
random.seed(5)
order = list(range(N)); random.shuffle(order)
pos = collections.defaultdict(list)
for t, i in enumerate(order):
    for it in items[i]: pos[it].append(t)
for k in pos: pos[k].sort()
total = sum(icost(k[0], v) for k, v in pos.items())
T0, steps = 20000.0, 2500000
for s in range(steps):
    T = T0 * (1 - s / steps) + 1e-3
    a, b = random.randrange(N), random.randrange(N)
    if a == b: continue
    ia, ib = order[a], order[b]
    touched = set(items[ia]) ^ set(items[ib])   # shared items don't change
    before = sum(icost(k[0], pos[k]) for k in touched)
    new = {}
    for k in touched:
        ts = list(pos[k])
        if k in items[ia]: ts.remove(a); bisect.insort(ts, b)
        else: ts.remove(b); bisect.insort(ts, a)
        new[k] = ts
    after = sum(icost(k[0], v) for k, v in new.items())
    d = after - before
    if d <= 0 or random.random() < math.exp(-d / T):
        order[a], order[b] = ib, ia
        pos.update(new); total += d
def gaps(kind):
    out = []
    for k, ts in pos.items():
        if k[0] == kind and len(ts) > 1:
            out += [b - a for a, b in zip(ts, ts[1:] + [ts[0] + N])]
    return out
gp, gw = gaps('p'), gaps('w')
print('chains', N, '| closest pair repeat', min(gp), 'days; pair repeats < 90 days:', sum(g < 90 for g in gp),
      '; < 60:', sum(g < 60 for g in gp), '| closest word repeat', min(gw), 'days; word back within 3 days:', sum(g <= 3 for g in gw))
cal = [keep[i] for i in order]
json.dump(cal, open('calendar.json', 'w'))
