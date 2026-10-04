"""Check the links between versions (PAPER-239).

Chains of a rule across versions decide its first date, and so whether it
codified or announced. align_global links propositions on word overlap or
bge-m3 cosine; a link the wording alone does not carry, and every rule that
leaves a chain, is read by the judges under link_check.md, sent verbatim:
is B, in the next version, the same rule as A?

    python3 link_check.py pairs --step1 measure1_step1_v4.json --packet packet_full_v3.json --out link_pairs.json
    python3 link_check.py judge --provider claude --model opus --pairs link_pairs.json --out links/claude-opus.jsonl
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import pathlib
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from judge import JudgeFailed, ask_azure, ask_claude, parse  # noqa: E402

ANSWERS = ("same", "modified", "different")
CHAINS = {"Bekanntmachung": ["2002-02-18", "2007-07-02", "2010-06-28", "2017-05-22", "2022-12-12"],
          "Erläuterungen": ["2019-04-09", "2022-12-12-erl"]}


def pairs(step1: list[dict], packet: dict, drops: list[dict]) -> list[dict]:
    """Every link that is not word-for-word (status reworded), and every rule
    that leaves its chain against its three nearest propositions in the next
    version (drops_candidates.json)."""
    out = []
    for t in step1:
        if t.get("type") != "norm":          # only a norm's chain decides measurement 1
            continue
        chain = next(c for c in CHAINS.values() if t["first_version"] in c)
        present = [v for v in chain if v in t["versions"]]
        for a, b in zip(present, present[1:]):
            if t["versions"][b]["status"] != "reworded":
                continue
            A, B = packet[(a, t["versions"][a]["pid"])], packet[(b, t["versions"][b]["pid"])]
            out.append({"kind": "link", "track": t["track"], "a_version": a, "a_pid": A["pid"], "a_text": A["text"],
                        "a_lead": A.get("lead", ""), "b_version": b, "b_pid": B["pid"], "b_text": B["text"],
                        "b_lead": B.get("lead", ""), "cosine": t["versions"][b].get("cosine")})
    for d in drops:
        for c in d["candidates"]:
            out.append({"kind": "drop", "track": d["track"], "a_version": d["from"], "a_pid": d["pid"],
                        "a_text": d["text"], "a_lead": d.get("lead", ""), "b_version": d["next"], "b_pid": c["pid"],
                        "b_text": c["text"], "b_lead": c.get("lead", ""), "cosine": c["cos"]})
    for n, p in enumerate(out):
        p["id"] = f"{p['a_version']}:{p['a_pid']}>{p['b_version']}:{p['b_pid']}"
    seen, uniq = set(), []
    for p in out:
        if p["id"] not in seen:
            seen.add(p["id"]); uniq.append(p)
    return uniq


def prompt(protocol: str, p: dict) -> tuple[str, str]:
    system = ("You compare two propositions of a Swiss competition-law notice by the protocol below. "
              "Follow it exactly; do not apply rules of your own.\n\n=== PROTOCOL ===\n" + protocol)
    def side(tag, v, pid, lead, text):
        s = f"{tag} — version {v[:10]}{' (Erläuterungen)' if v.endswith('erl') or v.startswith('2019') else ''}, {pid}\n"
        if lead:
            s += f"[opening of the sentence, for context only:] {lead}\n"
        return s + text
    return system, side("A", p["a_version"], p["a_pid"], p["a_lead"], p["a_text"]) + "\n\n" + \
        side("B", p["b_version"], p["b_pid"], p["b_lead"], p["b_text"])


def one(p: dict, args, protocol: str) -> dict:
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("pairs")
    a.add_argument("--step1", type=pathlib.Path, required=True)
    a.add_argument("--packet", type=pathlib.Path, required=True)
    a.add_argument("--drops", type=pathlib.Path, required=True)
    a.add_argument("--out", type=pathlib.Path, required=True)
    j = sub.add_parser("judge")
    j.add_argument("--provider", choices=("claude", "azure", "vertex"), required=True)
    j.add_argument("--model", required=True)
    j.add_argument("--pairs", type=pathlib.Path, required=True)
    j.add_argument("--protocol", type=pathlib.Path, default=HERE / "link_check.md")
    j.add_argument("--out", type=pathlib.Path, required=True)
    j.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()
    if args.cmd == "pairs":
        packet = {(p["version"], p["pid"]): p for p in json.loads(args.packet.read_text()) if p["version"] != "control"}
        out = pairs(json.loads(args.step1.read_text()), packet, json.loads(args.drops.read_text()))
        args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1))
        print(len(out), "pairs:", sum(p["kind"] == "link" for p in out), "links,", sum(p["kind"] == "drop" for p in out), "drop candidates")
        return 0
    protocol = args.protocol.read_text()
    todo = json.loads(args.pairs.read_text())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(args.workers) as ex, args.out.open("w") as fh:
        for row in ex.map(lambda p: one(p, args, protocol), todo):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
    print("done", len(todo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
