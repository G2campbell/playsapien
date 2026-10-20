"""Builds pairs.json: for each head word, the words that can follow it.

    python3 make_pairs.py          (run in games/wordchain/src)

Inputs:
  pairs-graded.jsonl    one line per head word: {"h":HEAD,"s":[strong],"w":[weak]}.
                        Graded by Claude (19 Oct 2026): 1,888 heads, every word
                        that can follow each one, swept A-Z, WordNet as hints.
  pairs-additions.txt   pairs added by hand ("HEAD TAIL" or "HEAD TAIL weak").
  pairs-extra-words.txt  words a pair needs that were not in dict.txt; they
                        have been added to dict.txt (re-add them if finalize.py
                        ever regenerates it).
  gamedata.json lex     the old list; its chain links are always strong, and
                        its auto-split compounds (WAR+RANT) are kept as weak.
  graph.py OPEN         the curated open phrases, always strong.

Strong = a pair anyone would know (FIRE ALARM). Weak = real but marginal (FIRE
OPAL). Output format: {"FIRE":"ALARM ARM ...|OPAL BLIGHT ..."}; "~" before a partial head's list."""
import json,glob
src=open('graph.py').read()
OPEN=src.split('OPEN = """')[1].split('"""')[0]
openp={tuple(e.upper().split(':')) for e in OPEN.split() if ':' in e}
D=set(w.strip().upper() for w in open('dict.txt') if w.strip())
ADD=open('pairs-extra-words.txt').read().split()
D2=D|set(ADD)
d=json.load(open('gamedata.json')); lex=d['lex']
bank={(l['a'],l['b']) for c in d['chains'] for l in c['links']}
out={}
for f in ['pairs-graded.jsonl']:
    for line in open(f):
        if not line.strip(): continue
        o=json.loads(line); h=o['h']
        s=[x for x in dict.fromkeys(o['s']) if x in D2 and len(x)>=2]
        w=[x for x in dict.fromkeys(o['w']) if x in D2 and len(x)>=2 and x not in s]
        out[h]=[s,w]
for h,v in lex.items():
    s,w=out.setdefault(h,[[],[]])
    for b in v:
        if (h,b) in bank or (h,b) in openp:
            if b in w: w.remove(b)
            if b not in s: s.append(b)
        elif b not in s and b not in w and (h+b) in D:
            w.append(b)
# hand additions (pairs-additions.txt): "HEAD TAIL" or "HEAD TAIL weak"
for line in open('pairs-additions.txt'):
    line=line.split('#')[0].split()
    if len(line)<2: continue
    h,b=line[0].upper(),line[1].upper(); weak=len(line)>2
    assert b in D2, b+' is not in dict.txt'
    s,w=out.setdefault(h,[[],[]])
    if weak:
        if b not in s and b not in w: w.append(b)
    else:
        if b in w: w.remove(b)
        if b not in s: s.append(b)
# A head that was never graded A-Z (it exists only through the hand additions)
# is PARTIAL: "~" in front tells the game that a pair missing from it is
# unknown, not wrong.
graded={json.loads(l)['h'] for l in open('pairs-graded.jsonl') if l.strip()}
enc={h:('' if h in graded or h in lex else '~')+' '.join(sorted(s))+('|'+' '.join(sorted(w)) if w else '') for h,(s,w) in sorted(out.items()) if s or w}
json.dump(enc,open('pairs.json','w'),separators=(',',':'),sort_keys=True)
for a,b in bank: assert b in out[a][0], (a,b)
print('heads',len(enc),'strong',sum(len(v[0]) for v in out.values()),'weak',sum(len(v[1]) for v in out.values()))
