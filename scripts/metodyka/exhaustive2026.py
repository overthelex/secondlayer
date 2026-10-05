"""The exhaustive search for the 2026 norms (PAPER-244).

Eight passages chosen by meaning find an application but cannot show that
the record lacks one, nor date the first. As in the Swiss audit
(exhaustive.py, textlag.py), each norm gets a second, date-ordered reading
of the decisions nearest to it:

  a norm the first reading found applied by either judge: the 24 decisions
  nearest to it dated before the earliest such passage (how old the practice
  the 2026 text wrote down is -- the text lag);
  a norm it did not: the 24 nearest decisions dated before 1 August 2026
  (whether the record holds it at all).

One passage per decision, decisions already read for the norm left out,
read in date order in three batches of eight (round 1 the oldest) by both
judges under judge2026.py. The first batch holding an agreed application,
or one the reader confirms, gives the earliest application found.

    python3 exhaustive2026.py plan --out /data/amcu/packet2026_exh.json
"""
from __future__ import annotations

import argparse
import json
import pathlib

import psycopg2
import psycopg2.extras

import packet
import retrieve

DATA = pathlib.Path(__file__).resolve().parents[2] / "data" / "metodyka"
CUTOFF = "2026-08-01"
TOP = 24
BATCH = 8


def applied_dates(first: list[dict]) -> dict[str, str]:
    """norm -> earliest date of a first-reading passage either judge read as applying it."""
    lab = {}
    for who in ("claude-opus", "gemini-3.1-pro"):
        for line in (DATA / "judges2026" / f"{who}.jsonl").read_text().splitlines():
            r = json.loads(line)
            lab.setdefault((r["number"], r["doc_id"], r["ord"]), []).append(r)
    out = {}
    for item in first:
        for s in item["passages"]:
            rows = lab.get((item["number"], s["doc_id"], s["ord"]), [])
            if any(r["label"] == "застосовує" and (item["origin"] == "new" or r.get("new") == "так") for r in rows):
                d = s["date"]
                if d and (item["number"] not in out or d < out[item["number"]]):
                    out[item["number"]] = d
    return out


def cmd_plan(args) -> int:
    first = json.loads(pathlib.Path(args.first).read_text(encoding="utf-8"))
    applied = applied_dates(first)
    conn = psycopg2.connect(retrieve.dsn())
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT doc_id, decision_date FROM ua_metodyka_audit_corpus WHERE canonical AND decision_date IS NOT NULL")
        dates = {r["doc_id"]: str(r["decision_date"]) for r in cur.fetchall()}
    index = retrieve.dense_index()
    cache: dict = {}
    out = []
    for item in first:
        n = item["number"]
        before = applied.get(n, CUTOFF)
        read = {s["doc_id"] for s in item["passages"]}
        keep = {d for d, dt in dates.items() if dt < before and d not in read}
        hits = retrieve.search_dense(index, item["text"], TOP, cache, keep)
        hits.sort(key=lambda h: (dates[h["doc_id"]], -h["rank"]))
        bodies, meta = packet.passage_bodies(conn, hits)
        out.append({**{k: item[k] for k in ("number", "rozdil", "rozdil_title", "text", "origin", "from_2002", "text_2002")},
                    "mode": "text lag" if n in applied else "record", "before": before,
                    "passages": [{"doc_id": h["doc_id"], "ord": h["ord"], "score": round(h["rank"], 4),
                                  "round": i // BATCH + 1, "corpus": meta.get(h["doc_id"], {}).get("corpus"),
                                  "doc_ref": meta.get(h["doc_id"], {}).get("doc_ref"), "date": dates[h["doc_id"]],
                                  "body": bodies.get((h["doc_id"], h["ord"]), "")} for i, h in enumerate(hits)]})
        print(f"  {n:<8} {out[-1]['mode']:<9} before {before}: {len(hits)} decisions", flush=True)
    pathlib.Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out)} norms, {sum(p['mode'] == 'text lag' for p in out)} searched for older practice, "
          f"{sum(len(p['passages']) for p in out)} passages -> {args.out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--first", default="/data/amcu/packet2026.json")
    p.add_argument("--out", default="/data/amcu/packet2026_exh.json")
    args = ap.parse_args()
    return {"plan": cmd_plan}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
