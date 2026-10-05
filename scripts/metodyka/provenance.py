"""Where do the Ukrainian Methodology's rules come from? EU provenance (PAPER-246).

The VertBek audit measured provenance by verbatim 5-grams against the EU
text in force. The Ukrainian texts are in Ukrainian and the Commission's
notices have no official Ukrainian translation, so verbatim n-grams do not
cross. Instead: candidate pairs by bge-m3, which is multilingual (the top 3
EU paragraphs for each Ukrainian proposition and the top 3 propositions for
each EU paragraph), read by two judges under eu_link.md -- "rendered" (a
translation or close paraphrase), "same rule" (the EU's rule, in Ukraine's
own words and particulars), or "different".

Four comparisons:
  2002 text (z0317-02) against the 1997 notice, the one in force when it was written;
  2026 text (z1043-26) against the 2024 notice, likewise;
  2026 text against the 1997 notice, to tell what the 2024 notice brought from
    what the EU had said since 1997;
  2002 text against the 2016 notice on State aid, a control no market-definition
    rule can come from: what the judges say "rendered" or "same rule" to there
    is their false-positive rate.

    python3 provenance.py pairs  --out ../../data/metodyka/eu_pairs.json        (on the box: TEI)
    python3 provenance.py judge  --provider claude --model opus --out ../../data/metodyka/eu/claude-opus.jsonl
    python3 provenance.py merge
    python3 provenance.py cross     (against codify_2026.json, PAPER-244)
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
for p in (HERE, HERE.parent / "weko-vertbek"):
    sys.path.insert(0, str(p))
DATA = HERE.parents[1] / "data" / "metodyka"
TEI = os.environ.get("METODYKA_TEI", "http://172.30.0.2:80")
K = 3
RUNS = (("2002", "1997"), ("2026", "2024"), ("2026", "1997"), ("2002", "stateaid2016"))
TITLE = {"1997": "Commission Notice on the definition of relevant market (OJ C 372, 9.12.1997)",
         "2024": "Commission Notice on the definition of the relevant market (C/2024/1645)",
         "stateaid2016": "Commission Notice on the notion of State aid (OJ C 262, 19.7.2016)"}
ANSWERS = ("rendered", "same rule", "different")
RANK = {"rendered": 2, "same rule": 1, "different": 0}


def ukrainian() -> dict[str, list[dict]]:
    old = json.loads((DATA / "propositions.json").read_text())
    old = old["propositions"] if isinstance(old, dict) else old
    new = json.loads((DATA / "propositions_2026.json").read_text())["propositions"]
    return {"2002": [{"pid": p["number"], "text": p["text"]} for p in old],
            "2026": [{"pid": p["number"], "text": p["text"]} for p in new]}


def eu() -> dict[str, list[dict]]:
    d = json.loads((DATA / "eu_notices.json").read_text())
    return {k: [{"pid": str(p["n"]), "text": p["text"], "section": p["section"]} for p in v["paragraphs"]] for k, v in d.items()}


def cmd_pairs(args) -> int:
    import numpy as np
    from retrieve import embed
    ua, ec = ukrainian(), eu()
    cache: dict = {}
    vec = {}
    for k, ps in list(ua.items()) + list(ec.items()):
        v = np.asarray(embed([p["text"] for p in ps], TEI, cache), dtype="float32")
        vec[k] = v / np.linalg.norm(v, axis=1, keepdims=True)
    out = []
    for u, e in RUNS:
        S = vec[u] @ vec[e].T
        want = set()
        for i in range(S.shape[0]):
            want |= {(i, int(j)) for j in np.argsort(-S[i])[:K]}
        for j in range(S.shape[1]):
            want |= {(int(i), j) for i in np.argsort(-S[:, j])[:K]}
        for i, j in sorted(want):
            out.append({"id": f"{u}:{ua[u][i]['pid']}>{e}:{ec[e][j]['pid']}", "run": f"{u}>{e}",
                        "u_version": u, "u_pid": ua[u][i]["pid"], "u_text": ua[u][i]["text"],
                        "e_notice": e, "e_pid": ec[e][j]["pid"], "e_section": ec[e][j]["section"],
                        "e_text": ec[e][j]["text"], "cosine": round(float(S[i, j]), 3)})
        print(f"  {u} x {e}: {len(ua[u])} x {len(ec[e])} -> {len(want)} pairs, "
              f"median cosine of the pairs {float(np.median([S[i, j] for i, j in want])):.3f}")
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(out)} pairs -> {args.out}")
    return 0


def prompt(protocol: str, p: dict) -> tuple[str, str]:
    system = ("You compare a proposition of a Ukrainian competition-law instrument with a paragraph of an EU "
              "Commission notice by the protocol below. Follow it exactly; do not apply rules of your own.\n\n"
              "=== PROTOCOL ===\n" + protocol)
    user = (f"U — Ukrainian Methodology, {p['u_version']} text, {p['u_pid']}\n{p['u_text']}\n\n"
            f"E — {TITLE[p['e_notice']]}, paragraph {p['e_pid']} ({p['e_section']})\n{p['e_text']}")
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
        a = str(ans.get("answer", "")).strip()
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
            if row["error"] or n % 100 == 0:
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
    """Agreed answers stand; a split that changes a proposition's provenance goes to the reader."""
    pairs = {p["id"]: p for p in json.loads((DATA / "eu_pairs.json").read_text())}
    c, g = answers(DATA / "eu" / "claude-opus.jsonl"), answers(DATA / "eu" / "gemini-3.1-pro.jsonl")
    hf = DATA / "human_labels_eu.json"
    human = {r["id"]: r["answer"] for r in json.loads(hf.read_text())["labels"]} if hf.exists() else {}
    missing = [pid for pid in pairs if pid not in c or pid not in g]
    assert not missing, f"{len(missing)} pairs not read by both models"

    def best(choose):
        out = {}
        for pid, p in pairs.items():
            a = choose(pid)
            k = (p["run"], p["u_pid"])
            if k not in out or RANK[a] > RANK[out[k][0]]:
                out[k] = (a, p["e_pid"])
        return out
    agreed = lambda pid: c[pid] if c[pid] == g[pid] else human.get(pid)
    low = best(lambda pid: agreed(pid) or min(c[pid], g[pid], key=RANK.get))
    high = best(lambda pid: agreed(pid) or max(c[pid], g[pid], key=RANK.get))
    decisive = [pid for pid, p in pairs.items() if c[pid] != g[pid] and pid not in human
                and low[(p["run"], p["u_pid"])][0] != high[(p["run"], p["u_pid"])][0]
                and max(c[pid], g[pid], key=RANK.get) == high[(p["run"], p["u_pid"])][0]]
    print(f"{len(pairs)} pairs; agree on {sum(c[p] == g[p] for p in pairs)}; "
          f"{sum(c[p] != g[p] for p in pairs)} split, {len(decisive)} decide a proposition's provenance")
    if decisive:
        (DATA / "eu_disputes_decisive.json").write_text(json.dumps(
            [{**pairs[pid], "claude": c[pid], "gemini": g[pid]} for pid in decisive], ensure_ascii=False, indent=1))
        print("decisive splits ->", DATA / "eu_disputes_decisive.json")
        return 1
    ua = ukrainian()
    rows = {}
    for u, e in RUNS:
        run = f"{u}>{e}"
        rows[run] = [{"pid": p["pid"], "answer": low.get((run, p["pid"]), ("different", None))[0],
                      "eu_paragraph": low.get((run, p["pid"]), ("different", None))[1]
                      if low.get((run, p["pid"]), ("different", None))[0] != "different" else None}
                     for p in ua[u]]
        print(f"  {run:<20} " + ", ".join(f"{a} {sum(r['answer'] == a for r in rows[run])}" for a in ANSWERS))
    (DATA / "eu_provenance.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


def cmd_cross(args) -> int:
    """The 2026 norms PAPER-244 read, by verdict and by provenance in the 2024 and 1997 notices."""
    pv = json.loads((DATA / "eu_provenance.json").read_text())
    p24 = {r["pid"]: r for r in pv["2026>2024"]}
    p97 = {r["pid"]: r for r in pv["2026>1997"]}
    rows = []
    for r in json.loads((DATA / "codify_2026.json").read_text())["norms"]:
        n = r["number"]
        rows.append({"number": n, "origin": r["origin"], "verdict": r["verdict"],
                     "eu_2024": p24[n]["answer"], "eu_2024_paragraph": p24[n]["eu_paragraph"],
                     "eu_1997": p97[n]["answer"], "eu_1997_paragraph": p97[n]["eu_paragraph"]})
    table = collections.Counter((r["verdict"], r["eu_2024"]) for r in rows)
    out = {"norms": rows, "verdict_by_eu_2024": {f"{v} / {a}": table[(v, a)] for v in ("codifies", "announces") for a in ANSWERS}}
    (DATA / "eu_codify_2026.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for k, v in out["verdict_by_eu_2024"].items():
        print(f"  {k:<26} {v}")
    new_in_2024 = [r["number"] for r in rows if r["eu_2024"] == "rendered" and r["eu_1997"] != "rendered"]
    print(f"  rendered from 2024 and not from 1997: {len(new_in_2024)} {new_in_2024}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pairs"); p.add_argument("--out", type=pathlib.Path, default=DATA / "eu_pairs.json")
    p = sub.add_parser("judge")
    p.add_argument("--provider", choices=("claude", "azure", "vertex"), required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--pairs", type=pathlib.Path, default=DATA / "eu_pairs.json")
    p.add_argument("--protocol", type=pathlib.Path, default=HERE / "eu_link.md")
    p.add_argument("--out", type=pathlib.Path, required=True)
    p.add_argument("--workers", type=int, default=4)
    sub.add_parser("merge")
    sub.add_parser("cross")
    args = ap.parse_args()
    return {"pairs": cmd_pairs, "judge": cmd_judge, "merge": cmd_merge, "cross": cmd_cross}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
