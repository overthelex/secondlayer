"""Step 2 of measurement 1: the record before the text, for the propositions
step 1 left as "announcement?".

For each such proposition, the version that first stated it and its text;
the passages are drawn only from decisions whose date_upper_bound lies
before that version's date (packet.pool with `before`), chosen by the same
rules as the full packet. The judges read this packet under protocol v2; a
supporting passage here turns the proposition into a codification.

    python3 before_packet.py --dsn ... --step1 measure1_step1.json --out packet_before.json
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from datetime import date

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import packet  # noqa: E402
from retrieve import dense_index, embed  # noqa: E402

DIR = pathlib.Path("/data/ch-corpus/weko-bek")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--tei", default="http://172.30.0.2:80")
    ap.add_argument("--step1", type=pathlib.Path, default=DIR / "measure1_step1.json")
    ap.add_argument("--full", type=pathlib.Path, default=DIR / "packet_full.json")
    ap.add_argument("--out", type=pathlib.Path, default=DIR / "packet_before.json")
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    full = {(p["version"], p["pid"]): p for p in json.loads(args.full.read_text())}
    todo = [r for r in json.loads(args.step1.read_text()) if r["class"] == "announcement?"]

    meta = {r["ecli"]: r for r in conn.execute(packet.META).fetchall()}
    family = packet.families(conn, meta)
    index = dense_index()
    cache: dict = {}
    out = []
    for r in todo:
        v = r["first_version"]
        item = dict(full[(v, r["versions"][v]["pid"])])
        before = date.fromisoformat(r.get("first_date") or v[:10])
        q = np.asarray(embed([item["text"]], args.tei, cache)[0], dtype="float32")
        q /= max(float(np.linalg.norm(q)), 1e-9)
        chosen, stats = packet.pool(conn, index, meta, family, item["text"], q, before)
        item["evidence"] = [packet.evidence(c, meta, before, set()) for c in chosen]
        item.update({"before": str(before), "pool": stats, "track": r["track"]})
        out.append(item)
        print(f"  {v:15} {item['pid']:8} before {before}: {len(chosen)} passages "
              f"(pool {stats['pool']}, agency {stats['agency_in_pool']})", flush=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    empty = sum(1 for x in out if not x["evidence"])
    print(f"{len(out)} propositions -> {args.out}; with no earlier decision at all: {empty}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
