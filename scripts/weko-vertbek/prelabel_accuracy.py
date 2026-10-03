import json, collections
H = {(r["version"], r["pid"]): r["label"] for r in json.load(open("/home/vovkes/SecondLayer-judges/scripts/weko-vertbek/gold_set_2026-10-02.json"))["labels"]}
dev = {(r["version"], r["pid"]) for r in json.load(open("/data/ch-corpus/weko-bek/human_labels_2026-10-02.json"))["labels"]}
J = {n: {(json.loads(l)["version"], json.loads(l)["pid"]): json.loads(l)["label"] for l in open(f"/data/ch-corpus/weko-bek/judges/{n}.jsonl")} for n in ("claude-opus", "gemini-3.1-pro")}
for name, keys in [("test 33", [k for k in H if k not in dev]), ("all 50", list(H))]:
    pre = ok = okb = 0; errs = collections.Counter()
    for k in keys:
        c, g = J["claude-opus"][k], J["gemini-3.1-pro"][k]
        if (c == "supported") == (g == "supported"):
            pre += 1; ok += c == H[k]; okb += (c == "supported") == (H[k] == "supported")
            if c != H[k]: errs[(c, H[k])] += 1
    print(f"{name}: binary-check pre-labels {pre}/{len(keys)}, 4-way right {ok}/{pre} ({ok/pre:.0%}), supported-or-not right {okb}/{pre} ({okb/pre:.0%}); errors (judges->human) {dict(errs)}")
