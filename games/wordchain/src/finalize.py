# -*- coding: utf-8 -*-
import json, re
from wordfreq import zipf_frequency as z, top_n_list

rows = json.load(open("bank.json"))

# de-duplicate, and thin out the Easy clique so the tier isn't four variants of one chain
seen, out = set(), []
sigcount = {}
for r in rows:
    key = tuple(r["words"])
    if key in seen: continue
    seen.add(key)
    # signature = the middle run, to catch near-identical chains
    sig = tuple(r["words"][2:6])
    if r["level"] == "easy":
        tail = tuple(r["words"][3:7])
        sigcount[tail] = sigcount.get(tail, 0) + 1
        if sigcount[tail] > 1: continue
    out.append(r)

def plural(w):
    wl = w.lower()
    if re.search(r"(s|x|z|ch|sh)$", wl): return wl+"es"
    if re.search(r"[^aeiou]y$", wl): return wl[:-1]+"ies"
    return wl+"s"

def singular(w):
    wl = w.lower()
    if wl.endswith("ies"): return wl[:-3]+"y"
    if wl.endswith("es") and re.search(r"(s|x|z|ch|sh)es$", wl): return wl[:-2]
    if wl.endswith("s") and not wl.endswith("ss"): return wl[:-1]
    return None

# numberStrict is HAND-flagged: it applies only where the singular and the plural
# are DIFFERENT established compounds (FIREWORK the object vs FIREWORKS the display),
# not where they are merely the two numbers of one word (ARMCHAIR / ARMCHAIRS).
# Auto-detection by corpus frequency does not work - it flags every regular plural.
STRICT = {("FIRE","WORK"), ("WATER","WORK"), ("GRASS","ROOT"), ("CROSS","HAIR"),
          ("GOOSE","BUMP"), ("HEAD","PHONE"), ("SUN","GLASS"), ("MONKEY","BAR"),
          ("SOUR","GRAPE"), ("ODDS","MAKER")}
for r in out:
    for l in r["links"]:
        b = l["b"].lower()
        sing = singular(b) or b
        l["numberStrict"] = (l["a"], sing.upper()) in STRICT
        l["alt"] = (plural(sing) if b == sing else sing).upper()

strict = [(l["a"], l["b"], l["alt"]) for r in out for l in r["links"] if l["numberStrict"]]
print("number-strict links:", strict)

from collections import Counter
print(Counter(r["level"] for r in out), "total", len(out))
for lv in ("easy","medium","hard"):
    for r in [x for x in out if x["level"]==lv]:
        print(f"  {lv[:4]:<5}" + " · ".join(r["words"]))

# ---- dictionary for the NOT A WORD check ----
words = [w for w in top_n_list("en", 70000) if re.fullmatch(r"[a-z]{2,}", w)]
DICT = sorted(set(words))
print("dict size:", len(DICT))

# ---- offline compound lexicon (fallback when the model can't be reached) ----
P = json.load(open("pairs.json"))
lex = {}
for k,(form,zf,disp) in P.items():
    a,b = k.split("|")
    s = zf if form=="closed" else max(zf,3.1)
    if s < 2.5: continue
    lex.setdefault(a.upper(), []).append(b.upper())
# every authored link is in the lexicon by definition
for r in out:
    for l in r["links"]:
        lex.setdefault(l["a"], [])
        if l["b"] not in lex[l["a"]]: lex[l["a"]].append(l["b"])
print("lexicon heads:", len(lex), "entries:", sum(len(v) for v in lex.values()))

json.dump({"chains": out, "lex": lex}, open("gamedata.json","w"), separators=(",",":"))
open("dict.txt","w").write("\n".join(DICT))
import os
print("gamedata", os.path.getsize("gamedata.json"), "dict", os.path.getsize("dict.txt"))
