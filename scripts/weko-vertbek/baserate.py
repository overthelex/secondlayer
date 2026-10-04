"""Base rate: the record each version was written against (PAPER-235 d).

For every version, the decisions dated (upper bound) before its first
publication, by tier and by the regime they were decided under: the
Kartellgesetz of 1995, or the revised Act with direct sanctions in force
from 1 April 2004. Notices themselves (RPW chapter D1) are left out, as in
every reading of the audit. A codification is only possible against what
the record already held, so the share of codifications is read against it.

    python3 baserate.py --dsn ...
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib
from datetime import date

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"
FIRST = {"2002-02-18": date(2002, 2, 18), "2007-07-02": date(2007, 7, 2), "2010-06-28": date(2010, 6, 28),
         "2017-05-22": date(2017, 5, 22), "2019-04-09": date(2017, 6, 12), "2022-12-12": date(2022, 12, 12),
         "2022-12-12-erl": date(2022, 12, 12)}
SANCTIONS = date(2004, 4, 1)
TIER = {"CH_WEKO": "agency", "CH_WEKO_RPW": "agency", "CH_BGer": "federal", "CH_BGE": "federal",
        "CH_BVGer": "federal", "CH_BVGE": "federal"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    rows = conn.execute("SELECT ecli, spider, date_upper_bound d FROM ch_weko_audit_corpus "
                        "WHERE coalesce(rpw_chapter, '') <> 'D1' AND date_upper_bound IS NOT NULL").fetchall()
    m1 = [t for t in json.loads((DATA / "measure1_final_v8.json").read_text()) if t["type"] == "norm"]
    cls = collections.Counter((t["first_version"], t["final_class"]) for t in m1)
    out = {}
    for v, d in FIRST.items():
        before = [r for r in rows if r["d"] < d]
        out[v] = {"first_published": str(d), "decisions_before": len(before),
                  "under_kg2003": sum(r["d"] >= SANCTIONS for r in before),
                  "by_tier": dict(collections.Counter(TIER.get(r["spider"], "other") for r in before)),
                  "norms": sum(n for (vv, _), n in cls.items() if vv == v),
                  "codifications": cls[(v, "codification")]}
        print(v, out[v])
    out["_all"] = len(rows)
    (DATA / "baserate.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
