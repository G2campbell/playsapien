from wordfreq import top_n_list, zipf_frequency as z
import json, re

TOP = top_n_list('en', 80000)
words = [w for w in TOP if re.fullmatch(r"[a-z]+", w)]
wset = set(words)

SUFFIX = set("""ing ed er est ly ion ent ant ness able ible ous ive ful less ment tion sion
ties ties ies ance ence ism ist ity ive ize ise age ate ary ory ual ial ian ern ard art
ter ren ugh ver ting led son vice king ends ate ese ette""".split())
PREFIX = set("""un re pre dis mis non anti auto co de en em ex in im ir il inter intra micro
mid multi peri post pro semi sub super trans tri ultra uni bi""".split())

def is_inflection(w):
    for suf, bases in ((("ing",), (3,)), (("ed",), (2,)), (("s",), (1,)), (("es",), (2,)), (("er",), (2,)), (("ly",), (2,))):
        for s in suf:
            if w.endswith(s):
                stem = w[:-len(s)]
                if stem in wset or (stem + "e") in wset or (len(stem)>2 and stem[-1]==stem[-2] and stem[:-1] in wset):
                    return True
    return False

parts = {w for w in words if len(w) >= 3 and z(w,'en') >= 3.6 and w not in SUFFIX}

compounds = {}
for w in words:
    if len(w) < 6: continue
    if z(w,'en') < 2.5: continue
    if is_inflection(w): continue
    for i in range(3, len(w)-2):
        a, b = w[:i], w[i:]
        if a in parts and b in parts and b not in SUFFIX and a not in PREFIX:
            if is_inflection(b) and b not in ("works","glasses","phones","stairs","hairs","bumps","roots","grapes","pants","bars"):
                continue
            compounds.setdefault(w, []).append((a,b))

print("compounds:", len(compounds))
import random
random.seed(3)
for k in random.sample(list(compounds), 40):
    print(f"{z(k,'en'):.1f}", k, compounds[k])
