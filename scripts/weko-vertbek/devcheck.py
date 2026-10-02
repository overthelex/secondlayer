import json, glob, collections
H = {(r["version"], r["pid"]): r["label"] for r in json.load(open("/data/ch-corpus/weko-bek/human_labels_2026-10-02.json"))["labels"] if r.get("label")}
def load(d):
    out = {}
    for f in glob.glob(d + "/*.jsonl"):
        n = f.split("/")[-1][:-6]
        out[n] = {(json.loads(l)["version"], json.loads(l)["pid"]): json.loads(l)["label"] for l in open(f)}
    return out
for tag, d in [("v1", "/data/ch-corpus/weko-bek/judges-v1"), ("v2", "/data/ch-corpus/weko-bek/judges")]:
    J = {k: v for k, v in load(d).items() if k in ("claude-opus", "deepseek-v4-pro", "gemini-3.1-pro")}
    per = {n: sum(J[n].get(k) == h for k, h in H.items()) for n in J}
    maj_ok = 0; bin_ok = 0
    for k, h in H.items():
        labs = [J[n].get(k) for n in J]
        top, c = collections.Counter(labs).most_common(1)[0]
        m = top if c >= 2 else None
        maj_ok += m == h
        bin_ok += (m == "supported") == (h == "supported")
    print(f"{tag}: each judge vs human (17): {per} | majority 4-way {maj_ok}/17 | majority supported-or-not {bin_ok}/17")

J = {k: v for k, v in load("/data/ch-corpus/weko-bek/judges").items() if k in ("claude-opus", "deepseek-v4-pro", "gemini-3.1-pro")}
ok = pre = 0
for k, h in H.items():
    c = J["claude-opus"].get(k)
    if c in (J["gemini-3.1-pro"].get(k), J["deepseek-v4-pro"].get(k)):
        pre += 1; ok += c == h
print(f"anchor rule (Claude + one more agree): pre-labelled {pre}/17, correct {ok}/{pre}")
P = [p for p in json.load(open("/data/ch-corpus/weko-bek/packet.json")) if p["kind"] == "sample"]
rest = [(p["version"], p["pid"]) for p in P if (p["version"], p["pid"]) not in H]
a = sum(1 for k in rest if J["claude-opus"].get(k) in (J["gemini-3.1-pro"].get(k), J["deepseek-v4-pro"].get(k)))
m = sum(1 for k in rest if collections.Counter([J[n].get(k) for n in J]).most_common(1)[0][1] >= 2)
print(f"on the {len(rest)} unseen samples: anchor rule pre-labels {a}, disputed {len(rest)-a} | majority pre-labels {m}, disputed {len(rest)-m}")
