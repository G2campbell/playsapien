"""Adds the new chains to gamedata.json, in calendar order.

    python3 make_bank.py              (run in games/wordchain/src)

gamedata.json "chains" becomes: the original hand-graded chains first (the
"legacy" ones, still made by bank.py + finalize.py), then every chain in
chains-2026-10.jsonl in the order given -- that order IS the daily calendar.

gamedata.json "calendar" = {"start": <UTC day number>, "legacy": <count>}:
  * days before `start` keep the old rotation (day % legacy), so every past
    day still shows the chain it showed at the time;
  * from `start`, day d plays new chain (d - start) % <number of new chains>.

chains-2026-10.jsonl: 390 chains written by Claude on 19-20 Oct 2026, every
link an everyday pair in pairs.json, graded per link (fam 1-5, open/closed,
sense shift, heteronym), and ordered (chains/schedule.py) so that no word pair
comes back within 56 days and none within the same week.
"""
import json, re, datetime
START = datetime.date(2026, 10, 21)          # first day of the new calendar (UTC)
NEW = 'chains-2026-10.jsonl'

data = json.load(open('gamedata.json'))
legacy_n = (data.get('calendar') or {}).get('legacy', len(data['chains']))
legacy = data['chains'][:legacy_n]

STRICT = {("FIRE","WORK"), ("WATER","WORK"), ("GRASS","ROOT"), ("CROSS","HAIR"),
          ("GOOSE","BUMP"), ("HEAD","PHONE"), ("SUN","GLASS"), ("MONKEY","BAR"),
          ("SOUR","GRAPE"), ("ODDS","MAKER")}
def plural(w):
    wl = w.lower()
    if re.search(r"(s|x|z|ch|sh)$", wl): return wl + "es"
    if re.search(r"[^aeiou]y$", wl): return wl[:-1] + "ies"
    return wl + "s"
def singular(w):
    wl = w.lower()
    if wl.endswith("ies"): return wl[:-3] + "y"
    if wl.endswith("es") and re.search(r"(s|x|z|ch|sh)es$", wl): return wl[:-2]
    if wl.endswith("s") and not wl.endswith("ss"): return wl[:-1]
    return None
def band(r):   # spec-v3 7b
    if r["minfam"] >= 4 and r["meanfam"] >= 4.3 and r["shifts"] <= 2 and r["hetero"] == 0: return "easy"
    if r["minfam"] >= 3 and r["meanfam"] >= 3.6 and r["shifts"] <= 4: return "medium"
    return "hard"

new = []
for line in open(NEW):
    if not line.strip(): continue
    src = json.loads(line); w = src['words']; links = []
    for i in range(7):
        g = src['links'][i]; a, b = w[i], w[i + 1]
        sing = singular(b) or b.lower()
        links.append(dict(a=a, b=b, fam=g['fam'], form=g['form'], sense=g['sense'],
                          hetero=g['hetero'], numberStrict=(a, sing.upper()) in STRICT,
                          alt=(plural(sing) if b.lower() == sing else sing).upper()))
    r = dict(words=w, links=links, minfam=min(l['fam'] for l in links),
             meanfam=round(sum(l['fam'] for l in links) / 7, 2),
             shifts=sum(l['sense'] for l in links), hetero=sum(l['hetero'] for l in links),
             opens=sum(l['form'] == 'open' for l in links))
    r['level'] = band(r); new.append(r)

epoch = datetime.date(1970, 1, 1)
data['chains'] = legacy + new
data['calendar'] = {'start': (START - epoch).days, 'startDate': START.isoformat(), 'legacy': len(legacy)}
json.dump(data, open('gamedata.json', 'w'), separators=(',', ':'))
from collections import Counter
print('legacy', len(legacy), '+ new', len(new), '=', len(data['chains']),
      '| levels', dict(Counter(r['level'] for r in new)), '| starts', START)
