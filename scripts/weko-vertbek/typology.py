"""Type every proposition: norm, definition, scope, rationale, housekeeping.

Measurement 1 asks whether a rule was codified or announced. That question
has an answer only for a norm: an entry-into-force clause or a statement that
the notice binds no court has nothing to codify, yet the first run classed
such propositions as announcements. The judges read the proposition alone
(with the opening of its sentence for a lettered point) under typology.md,
sent verbatim every time.

    python3 typology.py --provider claude --model opus --packet packet.json --out typology/claude-opus.jsonl
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

TYPES = ("norm", "definition", "scope", "rationale", "housekeeping")


def prompt(protocol: str, item: dict) -> tuple[str, str]:
    system = ("You classify one proposition of a Swiss competition-law notice by the protocol "
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
        t = str(ans.get("type", "")).strip().lower()
        if t not in TYPES:
            raise ValueError(f"type {t!r}")
        row.update(type=t, why=ans.get("why", ""), error=None)
    except (JudgeFailed, ValueError) as e:
        row.update(type=None, why="", error=str(e))
    row["seconds"] = round(time.time() - t0, 1)
    return row


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=("claude", "azure", "vertex"), required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--packet", type=pathlib.Path, required=True)
    ap.add_argument("--protocol", type=pathlib.Path, default=HERE / "typology.md")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    protocol = args.protocol.read_text()
    items = [p for p in json.loads(args.packet.read_text()) if p.get("version") != "control"
             and p.get("kind") not in ("positive", "negative", "regime")]
    done = set()
    if args.out.exists():
        for line in args.out.read_text().splitlines():
            r = json.loads(line)
            if r.get("type"):
                done.add((r["version"], r["pid"]))
    todo = [p for p in items if (p["version"], p["pid"]) not in done]
    print(f"{len(items)} propositions, {len(todo)} to do", flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(args.workers) as ex, args.out.open("a") as fh:
        for n, row in enumerate(ex.map(lambda p: one(p, args, protocol), todo), 1):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            if row["error"] or n % 50 == 0:
                print(f"  {n}/{len(todo)} {row['version']} {row['pid']} {row['type']} {row['error'] or ''}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
