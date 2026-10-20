"""Check a file of Word Chain chains (JSON Lines). Usage: python3 check_chains.py FILE
Each line: {"words":[8 UPPERCASE words],"links":[7 x {"fam":1-5,"sense":bool,"hetero":bool,"form":"open"|"closed"}]}
Prints every problem, then a summary. Exit code 1 if any chain fails."""
import json, sys, collections
from wordfreq import zipf_frequency as z
P = json.load(open('pairs.json'))
STRONG = {h: set(v.split('|')[0].split()) for h, v in P.items()}
D = set(w.strip().upper() for w in open('dict.txt') if w.strip())
OLD = set(json.load(open('old_pairs.json')))
ROUND2 = '--round2' in sys.argv
if ROUND2:
    USED = json.load(open('used_pairs.json')); BAD = set(json.load(open('bad_pairs.json')))
def comp(a, b):   # other everyday answers for this head with the same first letter
    return sorted(x for x in STRONG.get(a, ()) if x[0] == b[0] and x != b)
bad = 0; pairs = collections.Counter(); wordc = collections.Counter(); seen = set()
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
for n, r in enumerate(rows, 1):
    w = r.get('words', []); L = r.get('links', []); errs = []
    if len(w) != 8: errs.append('needs 8 words')
    if len(L) != 7: errs.append('needs 7 links')
    if len(set(w)) != len(w): errs.append('a word repeats')
    if tuple(w) in seen: errs.append('duplicate chain')
    seen.add(tuple(w))
    for x in w:
        if x not in D: errs.append(x + ' not in dictionary')
        elif z(x.lower(), 'en') < 3.0: errs.append(x + ' too unfamiliar a word (zipf %.1f < 3.0)' % z(x.lower(), 'en'))
    for i in range(min(7, len(w) - 1)):
        a, b = w[i], w[i + 1]
        if b not in STRONG.get(a, ()): errs.append('%s %s is not an everyday pair in pairs.json' % (a, b))
        if a + ' ' + b in OLD: errs.append('%s %s was used in the old 34 chains' % (a, b))
        pairs[a + ' ' + b] += 1
        if ROUND2:
            if a + ' ' + b in BAD: errs.append('%s %s is on the banned list (bad_pairs.json)' % (a, b))
            if USED.get(a + ' ' + b, 0) >= 2: errs.append('%s %s is already used twice in the kept chains' % (a, b))
        if i < len(L):
            k = L[i]
            if k.get('fam') not in (1, 2, 3, 4, 5) or k.get('form') not in ('open', 'closed') \
               or not isinstance(k.get('sense'), bool) or not isinstance(k.get('hetero'), bool):
                errs.append('link %d (%s %s) needs fam 1-5, form open/closed, sense/hetero true/false' % (i + 1, a, b))
    if ROUND2 and len(w) == 8:
        fresh = sum(1 for i in range(7) if (w[i] + ' ' + w[i + 1]) not in USED)
        if fresh < 5: errs.append('only %d of 7 links are new (need 5+; see used_pairs.json)' % fresh)
        if L and min(k.get('fam', 0) for k in L) < 3: errs.append('a link graded below 3')
    for x in set(w): wordc[x] += 1
    if errs:
        bad += 1; print('#%d %s\n   - %s' % (n, ' '.join(w), '\n   - '.join(errs)))
rep = [p for p, c in pairs.items() if c > 1]
if rep: bad += 1; print('PAIRS USED MORE THAN ONCE IN THIS FILE:', rep)
hub = [(x, c) for x, c in wordc.items() if c > 6]
if hub: bad += 1; print('WORDS IN MORE THAN 6 CHAINS:', hub)
print('\n%d chains, %d failing.' % (len(rows), bad if not rep and not hub else bad))
if '--ambiguity' in sys.argv:
    for r in rows:
        w = r['words']; print(' '.join(w)); 
        for i in range(7): print('   %s %s  (other everyday %s… answers: %d)' % (w[i], w[i+1], w[i+1][0], len(comp(w[i], w[i+1]))))
sys.exit(1 if bad else 0)
