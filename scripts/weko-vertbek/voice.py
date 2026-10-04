"""Voice and statute of every norm (PAPER-235 b, e).

Schrepel and Jenny's legitimacy point: a guidance text that announces policy
in the voice of practice claims an authority it does not have. Measurement 1
says whether practice came first; this asks how the text speaks -- does it
report practice ("describes") or state a criterion in its own voice
("prescribes") -- and whether the rule only restates the Cartel Act. The
judges read each norm as first stated (with the opening of its sentence for
a lettered point) under voice.md, sent verbatim every time.

    python3 voice.py packet --out /data/ch-corpus/weko-bek/packet_voice.json
    python3 voice.py judge --provider claude --model opus --packet ... --out voice/claude-opus.jsonl
    python3 voice.py merge
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

VOICES = ("describes", "prescribes")
STATUTE = ("restates", "adds")
DATA = HERE.parents[1] / "data" / "weko-vertbek"
DIR = pathlib.Path("/data/ch-corpus/weko-bek")


def prompt(protocol: str, item: dict) -> tuple[str, str]:
    system = ("You classify how one rule of a Swiss competition-law notice is stated by the protocol "
              "below. Follow it exactly; do not apply rules of your own.\n\n=== PROTOCOL ===\n"
              + protocol)
    user = f"Version: {item['version']}\nProposition {item['pid']}"
    if item.get("heading"):
        user += f" (heading: {item['heading']})"
    user += "\n\n"
    if item.get("lead"):
        user += f"[opening of the sentence, for context only:] {item['lead']}\n\n"
    user += item["text"]
    return system, user


def one(item: dict, args, protocol: str) -> dict:
    system, user = prompt(protocol, item)
    t0 = time.time()
    row = {"version": item["version"], "pid": item["pid"], "provider": args.provider, "model": args.model,
           "system_sha256": hashlib.sha256(system.encode()).hexdigest()}
    try:
        if args.provider in ("azure", "vertex"):
            text, usage = ask_azure(args.model, system, user, os.environ.get("AZURE_KEY"),
                                    vertex=args.provider == "vertex")
        else:
            text, usage = ask_claude(args.model, system, user)
        ans = parse(text)
        v = str(ans.get("voice", "")).strip().lower()
        s = str(ans.get("statute", "")).strip().lower()
        if v not in VOICES or s not in STATUTE:
            raise ValueError(f"voice {v!r} statute {s!r}")
        row.update(voice=v, statute=s, why=ans.get("why", ""), error=None)
    except (JudgeFailed, ValueError) as e:
        row.update(voice=None, statute=None, why="", error=str(e))
    row["seconds"] = round(time.time() - t0, 1)
    return row


def cmd_packet(args) -> int:
    full = {(p["version"], p["pid"]): p for p in json.loads((DIR / "packet_full_v3.json").read_text())}
    items = []
    for t in json.loads((DATA / "measure1_final_v8.json").read_text()):
        if t["type"] != "norm":
            continue
        v = t["first_version"]; p = full[(v, t["versions"][v]["pid"])]
        items.append({**{k: p.get(k) for k in ("version", "pid", "part", "heading", "lead", "text")}, "track": t["track"]})
    args.out.write_text(json.dumps(items, ensure_ascii=False, indent=1))
    print(len(items), "norms ->", args.out)
    return 0


def cmd_judge(args) -> int:
    protocol = args.protocol.read_text()
    items = json.loads(args.packet.read_text())
    done = set()
    if args.out.exists():
        for line in args.out.read_text().splitlines():
            r = json.loads(line)
            if r.get("voice"):
                done.add((r["version"], r["pid"]))
    todo = [p for p in items if (p["version"], p["pid"]) not in done]
    print(f"{len(items)} norms, {len(todo)} to do", flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(args.workers) as ex, args.out.open("a") as fh:
        for n, row in enumerate(ex.map(lambda p: one(p, args, protocol), todo), 1):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            if row["error"] or n % 20 == 0:
                print(f"  {n}/{len(todo)} {row['version']} {row['pid']} {row['voice']} {row['statute']} {row['error'] or ''}", flush=True)
    return 0


def latest(path: pathlib.Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        r = json.loads(line)
        if r.get("voice"):
            out[(r["version"], r["pid"])] = r
    return out


def cmd_merge(args) -> int:
    """Agreed answers stand; a split goes to the reader (human_labels_voice.json)."""
    c, g = latest(args.judges / "claude-opus.jsonl"), latest(args.judges / "gemini-3.1-pro.jsonl")
    hf = DATA / "human_labels_voice.json"
    human = {(r["version"], r["pid"]): r for r in json.loads(hf.read_text())["labels"]} if hf.exists() else {}
    m1 = {(t["first_version"], t["versions"][t["first_version"]]["pid"]): t
          for t in json.loads((DATA / "measure1_final_v8.json").read_text()) if t["type"] == "norm"}
    rows, need = [], []
    for k, t in m1.items():
        a, b = c.get(k), g.get(k)
        if not a or not b:
            raise SystemExit(f"{k} not read by both judges")
        row = {"track": t["track"], "version": k[0], "pid": k[1], "class": t["final_class"]}
        for q in ("voice", "statute"):
            if a[q] == b[q]:
                row[q], row[q + "_by"] = a[q], "judges"
            elif k in human and human[k].get(q):
                row[q], row[q + "_by"] = human[k][q], "reader"
            else:
                need.append((k, q, a[q], b[q]))
        rows.append(row)
    if need:
        (DIR / "voice_disputes_needed.json").write_text(json.dumps(need, ensure_ascii=False))
        print(len(need), "splits for the reader:", need)
        return 1
    (DATA / "voice.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    import collections
    print(len(rows), "norms")
    print(" voice x class:", dict(collections.Counter((r["voice"], r["class"]) for r in rows)))
    print(" statute x class:", dict(collections.Counter((r["statute"], r["class"]) for r in rows)))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("packet")
    p.add_argument("--out", type=pathlib.Path, default=DIR / "packet_voice.json")
    j = sub.add_parser("judge")
    j.add_argument("--provider", choices=("claude", "azure", "vertex"), required=True)
    j.add_argument("--model", required=True)
    j.add_argument("--packet", type=pathlib.Path, required=True)
    j.add_argument("--protocol", type=pathlib.Path, default=HERE / "voice.md")
    j.add_argument("--out", type=pathlib.Path, required=True)
    j.add_argument("--workers", type=int, default=4)
    m = sub.add_parser("merge")
    m.add_argument("--judges", type=pathlib.Path, default=DATA / "voice")
    args = ap.parse_args()
    return {"packet": cmd_packet, "judge": cmd_judge, "merge": cmd_merge}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
