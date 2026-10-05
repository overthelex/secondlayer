"""The judges on the 2026 Methodology's new and modified norms (PAPER-244).

One label per (norm, passage) under the reader's protocol (protocol.md, the
same text the 2002 audit used, sent verbatim). Only the task changes: the
rule now comes from the 2026 Methodology, and the decision is older than the
text, so it cannot cite the rule by number -- the question is whether it uses
the rule all the same. For a modified norm the judge also gets the 2002 text
and says whether what the passage applies is what changed in 2026.

    python3 judge2026.py --provider claude --model opus --packet packet2026.json --out judges2026/claude-opus.jsonl
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
for p in (HERE, HERE.parent / "weko-vertbek"):
    sys.path.insert(0, str(p))

LABELS = {"застосовує", "суперечить", "лише переказує", "не про це"}
TASK = """Ти розмічаєш, чи українська практика до 1 серпня 2026 року вже застосовувала правило,
яке Методика визначення товарного ринку та монопольного (домінуючого) становища
суб'єктів господарювання на ньому (розпорядження АМКУ № 2-рп від 11.06.2026) записала
лише у 2026 році. Рішення, з якого взято уривок, ухвалено раніше, тож воно не може
посилатися на цей пункт; судіть лише за суттю: чи використано саме це правило.

Нижче протокол розмітки. У ньому йдеться про Методику 2002 року; для цього завдання
«пункт Методики» — це пункт Методики 2026 року. Постав рівно одну позначку за протоколом.

Відповідай РІВНО одним рядком JSON і нічим більше: {"label": "<застосовує|суперечить|лише переказує|не про це>",
"why": "<одне коротке речення українською>"}"""
TASK_MODIFIED = """

Цей пункт 2026 року змінює правило Методики 2002 року (текст 2002 року дано нижче).
Якщо твоя позначка «застосовує», додай поле "нове": "так", якщо в уривку застосовано саме
те, що змінено або додано у 2026 році, і "ні", якщо застосовано лише те, що було і в 2002 році.
Тоді відповідь: {"label": "...", "нове": "<так|ні>", "why": "..."}"""


def prompt(protocol: str, item: dict, body: str) -> tuple[str, str]:
    system = TASK + (TASK_MODIFIED if item["origin"] == "modified" else "") + "\n\n--- ПРОТОКОЛ ---\n" + protocol
    user = f"ПУНКТ {item['number']} МЕТОДИКИ 2026 РОКУ:\n{item['text']}\n\n"
    if item["origin"] == "modified":
        user += f"ВІДПОВІДНИЙ ПУНКТ {item['from_2002']} МЕТОДИКИ 2002 РОКУ:\n{item['text_2002']}\n\n"
    return system, user + f"--- УРИВОК З РІШЕННЯ ---\n{body}"


def one(job, args, protocol):
    from judge import JudgeFailed, ask_azure, ask_claude, parse
    item, s = job
    system, user = prompt(protocol, item, s["body"])
    row = {"number": item["number"], "doc_id": s["doc_id"], "ord": s["ord"], "provider": args.provider,
           "model": args.model, "system_sha256": hashlib.sha256(system.encode()).hexdigest()}
    t0 = time.time()
    try:
        if args.provider in ("azure", "vertex"):
            text, _ = ask_azure(args.model, system, user, os.environ.get("AZURE_KEY"), vertex=args.provider == "vertex")
        else:
            text, _ = ask_claude(args.model, system, user)
        ans = parse(text)
        lab = str(ans.get("label", "")).strip()
        if lab not in LABELS:
            raise ValueError(f"label {lab!r}")
        new = ans.get("нове")
        if item["origin"] == "modified" and lab == "застосовує" and new not in ("так", "ні"):
            raise ValueError(f"нове {new!r}")
        row.update(label=lab, new=new if lab == "застосовує" else None, why=ans.get("why", ""), error=None)
    except (JudgeFailed, ValueError) as e:
        row.update(label=None, new=None, why="", error=str(e))
    row["seconds"] = round(time.time() - t0, 1)
    return row


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=("claude", "azure", "vertex"), required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--packet", type=pathlib.Path, required=True)
    ap.add_argument("--protocol", type=pathlib.Path, default=HERE / "protocol.md")
    ap.add_argument("--out", type=pathlib.Path, required=True)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    protocol = args.protocol.read_text(encoding="utf-8")
    items = json.loads(args.packet.read_text(encoding="utf-8"))
    done = set()
    if args.out.exists():
        for l in args.out.read_text().splitlines():
            r = json.loads(l)
            if r.get("label"):
                done.add((r["number"], r["doc_id"], r["ord"]))
    jobs = [(it, s) for it in items for s in it["passages"] if (it["number"], s["doc_id"], s["ord"]) not in done]
    print(f"{sum(len(i['passages']) for i in items)} passages, {len(jobs)} to do", flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with cf.ThreadPoolExecutor(args.workers) as ex, args.out.open("a") as fh:
        for n, row in enumerate(ex.map(lambda j: one(j, args, protocol), jobs), 1):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n"); fh.flush()
            if row["error"] or n % 50 == 0:
                print(f"  {n}/{len(jobs)} {row['number']} {row['label']} {row['error'] or ''}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
