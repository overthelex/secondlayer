"""Which 2002 provisions the 2026 Methodology kept, changed or dropped (PAPER-243, -245).

The 2026 text is a new document, renumbered throughout, so the two cannot be
aligned by number. Every proposition of each text is set against the three
nearest by meaning in the other (bge-m3 cosine), and each candidate pair is
read by two models under link_ua.md, sent verbatim: is B, in the 2026 text,
the rule A states in 2002? A pair the models split on goes to the reader.

A 2002 provision is kept if some 2026 proposition is the same rule, modified
if the nearest it has is a modified one, dropped if all its candidates are
different rules. A 2026 proposition is carried over (same or modified) or new.

    python3 align2026.py pairs --out ../../data/metodyka/align_pairs.json          # on cthulhu (TEI)
    python3 align2026.py judge --provider claude --model opus --pairs align_pairs.json --out align/claude-opus.jsonl
    python3 align2026.py merge --judges ../../data/metodyka/align
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import hashlib
import json
import os
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "metodyka"
for p in (HERE, HERE.parent / "weko-vertbek"):
    sys.path.insert(0, str(p))
ANSWERS = ("same", "modified", "different")
TEI = "http://172.30.0.2:80"
K = 3


def load() -> tuple[list[dict], list[dict]]:
    a = json.loads((DATA / "propositions.json").read_text())
    a = a["propositions"] if isinstance(a, dict) else a
    b = json.loads((DATA / "propositions_2026.json").read_text())["propositions"]
    return a, b


def cmd_pairs(args) -> int:
    import numpy as np
    from retrieve import embed
    old, new = load()
    cache: dict = {}
    A = np.asarray(embed([p["text"] for p in old], TEI, cache), dtype="float32")
    B = np.asarray(embed([p["text"] for p in new], TEI, cache), dtype="float32")
    A /= np.linalg.norm(A, axis=1, keepdims=True); B /= np.linalg.norm(B, axis=1, keepdims=True)
    S = A @ B.T
    want = set()
    for i in range(len(old)):
        want |= {(i, int(j)) for j in np.argsort(-S[i])[:K]}
    for j in range(len(new)):
        want |= {(int(i), j) for i in np.argsort(-S[:, j])[:K]}
    out = [{"id": f"2002:{old[i]['number']}>2026:{new[j]['number']}", "a_pid": old[i]["number"],
            "a_text": old[i]["text"], "b_pid": new[j]["number"], "b_text": new[j]["text"],
            "cosine": round(float(S[i, j]), 3)} for i, j in sorted(want)]
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(old)} x {len(new)} propositions -> {len(out)} candidate pairs")
    return 0


def prompt(protocol: str, p: dict) -> tuple[str, str]:
    system = ("You compare two propositions of a Ukrainian competition-law instrument by the protocol below. "
              "Follow it exactly; do not apply rules of your own.\n\n=== PROTOCOL ===\n" + protocol)
    user = f"A — 2002 text (z0317-02), {p['a_pid']}\n{p['a_text']}\n\nB — 2026 text (z1043-26), {p['b_pid']}\n{p['b_text']}"
    return system, user


def one(p: dict, args, protocol: str) -> dict:
    from judge import JudgeFailed, ask_azure, ask_claude, parse
    system, user = prompt(protocol, p)
    row = {"id": p["id"], "provider": args.provider, "model": args.model,
           "system_sha256": hashlib.sha256(system.encode()).hexdigest()}
    t0 = time.time()
    try:
        if args.provider in ("azure", "vertex"):
            text, _ = ask_azure(args.model, system, user, os.environ.get("AZURE_KEY"), vertex=args.provider == "vertex")
        else:
            text, _ = ask_claude(args.model, system, user)
        ans = parse(text)
        a = str(ans.get("answer", "")).strip().lower()
        if a not in ANSWERS:
            raise ValueError(f"answer {a!r}")
        row.update(answer=a, why=ans.get("why", ""), error=None)
    except (JudgeFailed, ValueError) as e:
        row.update(answer=None, why="", error=str(e))
    row["seconds"] = round(time.time() - t0, 1)
    return row


def cmd_judge(args) -> int:
    protocol = args.protocol.read_text()
    pairs = json.loads(args.pairs.read_text())
    done = set()
    if args.out.exists():
        done = {json.loads(l)["id"] for l in args.out.read_text().splitlines() if json.loads(l).get("answer")}
    todo = [p for p in pairs if p["id"] not in done]
    print(f"{len(pairs)} pairs, {len(todo)} to do", flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(args.workers) as ex, args.out.open("a") as fh:
        for n, row in enumerate(ex.map(lambda p: one(p, args, protocol), todo), 1):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n"); fh.flush()
            if row["error"] or n % 50 == 0:
                print(f"  {n}/{len(todo)} {row['id']} {row['answer']} {row['error'] or ''}", flush=True)
    return 0


def answers(path: pathlib.Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        r = json.loads(line)
        if r.get("answer"):
            out[r["id"]] = r["answer"]
    return out


def cmd_merge(args) -> int:
    """Agreed answers stand; splits go to the reader (human_labels_align.json)."""
    pairs = {p["id"]: p for p in json.loads((DATA / "align_pairs.json").read_text())}
    c, g = answers(args.judges / "claude-opus.jsonl"), answers(args.judges / "gemini-3.1-pro.jsonl")
    hf = DATA / "human_labels_align.json"
    human = {r["id"]: r["answer"] for r in json.loads(hf.read_text())["labels"]} if hf.exists() else {}
    # a split that decides no provision's fate or origin (align_disputes_decisive.json
    # lists the ones that do) takes the lower of the two answers; the result is
    # checked below to be the same with the higher one
    df = DATA / "align_disputes_decisive.json"
    decisive = {d["id"] for d in json.loads(df.read_text())} if df.exists() else set(pairs)
    rank = {"same": 2, "modified": 1, "different": 0}
    final, need, loose = {}, [], {}
    for pid in pairs:
        if pid not in c or pid not in g:
            raise SystemExit(f"{pid} not read by both models")
        if c[pid] == g[pid]:
            final[pid] = c[pid]
        elif pid in human:
            final[pid] = human[pid]
        elif pid not in decisive:
            final[pid] = min(c[pid], g[pid], key=rank.get)
            loose[pid] = max(c[pid], g[pid], key=rank.get)
        else:
            need.append({"id": pid, "claude": c[pid], "gemini": g[pid]})
    if need:
        (DATA / "align_disputes_needed.json").write_text(json.dumps(need, ensure_ascii=False, indent=1))
        print(len(need), "splits for the reader ->", DATA / "align_disputes_needed.json")
        return 1
    old, new = load()

    def resolve(fin):
        fate, origin = {}, {}
        for pid, a in fin.items():
            p = pairs[pid]
            if p["a_pid"] not in fate or rank[a] > rank[fate[p["a_pid"]][0]]:
                fate[p["a_pid"]] = (a, p["b_pid"])
            if p["b_pid"] not in origin or rank[a] > rank[origin[p["b_pid"]][0]]:
                origin[p["b_pid"]] = (a, p["a_pid"])
        return fate, origin
    lo, hi = resolve(final), resolve({**final, **loose})
    assert {k: v[0] for k, v in lo[0].items()} == {k: v[0] for k, v in hi[0].items()}, "a non-decisive split decides a fate"
    assert {k: v[0] for k, v in lo[1].items()} == {k: v[0] for k, v in hi[1].items()}, "a non-decisive split decides an origin"
    fate, origin = lo
    name = {"same": "kept", "modified": "modified", "different": "dropped"}
    rows_old = [{"number": p["number"], "fate": name[fate[p["number"]][0]],
                 "in_2026": fate[p["number"]][1] if fate[p["number"]][0] != "different" else None} for p in old]
    rows_new = [{"number": p["number"], "origin": "new" if origin[p["number"]][0] == "different" else origin[p["number"]][0],
                 "from_2002": origin[p["number"]][1] if origin[p["number"]][0] != "different" else None} for p in new]
    (DATA / "alignment_2002_2026.json").write_text(json.dumps({"old": rows_old, "new": rows_new}, ensure_ascii=False, indent=1))
    print("2002 ->", dict(collections.Counter(r["fate"] for r in rows_old)))
    print("2026 <-", dict(collections.Counter(r["origin"] for r in rows_new)))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pairs"); p.add_argument("--out", type=pathlib.Path, default=DATA / "align_pairs.json")
    j = sub.add_parser("judge")
    j.add_argument("--provider", choices=("claude", "azure", "vertex"), required=True)
    j.add_argument("--model", required=True)
    j.add_argument("--pairs", type=pathlib.Path, required=True)
    j.add_argument("--protocol", type=pathlib.Path, default=HERE / "link_ua.md")
    j.add_argument("--out", type=pathlib.Path, required=True)
    j.add_argument("--workers", type=int, default=4)
    m = sub.add_parser("merge"); m.add_argument("--judges", type=pathlib.Path, default=DATA / "align")
    args = ap.parse_args()
    return {"pairs": cmd_pairs, "judge": cmd_judge, "merge": cmd_merge}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
