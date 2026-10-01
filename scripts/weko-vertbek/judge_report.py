"""Which judges to keep: controls, agreement, and what each rule leaves the human."""
import collections
import itertools
import json
import pathlib

J = pathlib.Path("/data/ch-corpus/weko-bek/judges")
P = json.load(open("/data/ch-corpus/weko-bek/packet.json"))
judges = {}
for f in sorted(J.glob("*.jsonl")):
    rows = {}
    for line in f.read_text().splitlines():
        r = json.loads(line)
        if r.get("label") and not r.get("error"):
            rows[(r["version"], r["pid"])] = r
    judges[f.stem] = rows
names = list(judges)

EXPECT = {"negative": {"absent"}, "positive": {"supported"}, "regime": {"absent", "fragment"}}
print("CONTROLS (expected: negative=absent, positive=supported, regime=absent|fragment)")
print(f"{'':12}" + "".join(f"{n[:13]:>15}" for n in names))
score = collections.Counter()
for it in P:
    if it["kind"] == "sample":
        continue
    row = []
    for n in names:
        lab = judges[n].get((it["version"], it["pid"]), {}).get("label")
        ok = lab in EXPECT[it["kind"]]
        score[n] += ok
        row.append(f"{(lab or '-')[:9]}{'' if ok else '✗'}")
    print(f"{it['kind'][:8]:8} {it['pid']:3}" + "".join(f"{x:>15}" for x in row))
print("controls passed (of 8):", {n: score[n] for n in names})

samples = [it for it in P if it["kind"] == "sample"]
keys = [(it["version"], it["pid"]) for it in samples]


def kappa(a, b):
    pairs = [(judges[a][k]["label"], judges[b][k]["label"]) for k in keys if k in judges[a] and k in judges[b]]
    po = sum(x == y for x, y in pairs) / len(pairs)
    ca, cb = collections.Counter(x for x, _ in pairs), collections.Counter(y for _, y in pairs)
    pe = sum(ca[l] * cb[l] for l in ca) / len(pairs) ** 2
    return po, (po - pe) / (1 - pe) if pe < 1 else 0.0


print("\nPAIRWISE on 50 samples: agreement / Cohen kappa")
print(f"{'':16}" + "".join(f"{n[:13]:>15}" for n in names))
for a in names:
    print(f"{a[:15]:16}" + "".join(
        f"{'':>15}" if a == b else f"{kappa(a, b)[0]:>8.2f}/{kappa(a, b)[1]:>5.2f}" for b in names))

print("\nLABEL DISTRIBUTION on samples")
for n in names:
    print(f"  {n:18}", dict(collections.Counter(judges[n][k]["label"] for k in keys if k in judges[n])))


def leftover(panel, need):
    pre = 0
    for k in keys:
        labs = [judges[n][k]["label"] for n in panel if k in judges[n]]
        top = collections.Counter(labs).most_common(1)
        if len(labs) == len(panel) and top and top[0][1] >= need:
            pre += 1
    return pre


print("\nPANELS: items pre-labelled (of 50) / left to the human (before the blind check sample)")
cands = [n for n in names]
for size in (3, 4, 5):
    for panel in itertools.combinations(cands, size):
        if "mistral-large-3" in panel:
            continue
        maj = size // 2 + 1
        pre_m, pre_u = leftover(panel, maj), leftover(panel, size)
        print(f"  {'+'.join(p.split('-')[0] for p in panel):45} majority {maj}/{size}: {pre_m:2} pre, {50 - pre_m:2} human"
              f" | unanimous: {pre_u:2} pre")
