"""Supplementary French and Italian selection (PAPER-236).

The record is every decision of WEKO and every decision whose text holds
"Kartellgesetz" or "Wettbewerbsabrede" -- German words. This counts what
the same rule finds in French and Italian, outside the record: decisions
naming the Act (LCart, loi sur les cartels, legge sui cartelli) or its
agreements (accord en matière de concurrence, accordo in materia di
concorrenza), and among them those on vertical agreements.

    python3 frit_select.py --dsn ...
"""
from __future__ import annotations

import argparse
import collections
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"

SQL = """
SELECT d.ecli, d.spider, d.decision_date, d.docket_number,
       (d.full_text ILIKE '%%vertica%%' OR d.full_text ILIKE '%%verticaux%%' OR d.full_text ILIKE '%%verticali%%') AS vertical,
       (d.full_text ILIKE '%%accord en matière de concurrence%%' OR d.full_text ILIKE '%%accords en matière de concurrence%%'
        OR d.full_text ILIKE '%%accordo in materia di concorrenza%%' OR d.full_text ILIKE '%%accordi in materia di concorrenza%%') AS agreement,
       CASE WHEN d.full_text ILIKE '%%legge sui cartelli%%' OR d.full_text ILIKE '%%accordo in materia%%'
                 OR d.full_text ILIKE '%%accordi in materia%%' THEN 'it' ELSE 'fr' END AS lang
  FROM ch_court_decisions d
 WHERE d.stage = 'loaded'
   AND NOT EXISTS (SELECT 1 FROM ch_weko_audit_corpus a WHERE a.ecli = d.ecli)
   AND (d.full_text ILIKE '%%LCart%%' OR d.full_text ILIKE '%%loi sur les cartels%%'
        OR d.full_text ILIKE '%%legge sui cartelli%%'
        OR d.full_text ILIKE '%%accord en matière de concurrence%%' OR d.full_text ILIKE '%%accords en matière de concurrence%%'
        OR d.full_text ILIKE '%%accordo in materia di concorrenza%%' OR d.full_text ILIKE '%%accordi in materia di concorrenza%%')
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    conn.execute("SET statement_timeout = '20min'")
    rows = conn.execute(SQL).fetchall()
    ext = {r["ecli"] for r in conn.execute("SELECT DISTINCT ecli FROM ch_weko_audit_ext_passages").fetchall()}
    tier = lambda s: ("federal" if s in ("CH_BGE", "CH_BGer", "CH_BVGer", "CH_BSTG") else
                      "agency" if s.startswith("CH_") else "cantonal")
    out = {
        "found": len(rows),
        "by_lang": dict(collections.Counter(r["lang"] for r in rows)),
        "by_tier": dict(collections.Counter(tier(r["spider"]) for r in rows)),
        "agreement": sum(r["agreement"] for r in rows),
        "vertical": sum(r["vertical"] for r in rows),
        "agreement_and_vertical": sum(r["agreement"] and r["vertical"] for r in rows),
        "hand_picked_ext": len(ext),
        "hand_picked_found": len(ext & {r["ecli"] for r in rows}),
        "candidates": [{"ecli": r["ecli"], "spider": r["spider"], "date": str(r["decision_date"]), "docket": r["docket_number"],
                        "lang": r["lang"], "tier": tier(r["spider"])}
                       for r in rows if r["agreement"] and r["vertical"]],
    }
    print(json.dumps({k: v for k, v in out.items() if k != "candidates"}, ensure_ascii=False))
    print("vertical agreement candidates by tier:", dict(collections.Counter(c["tier"] for c in out["candidates"])))
    print("by decade:", dict(collections.Counter(c["date"][:3] + "0s" for c in out["candidates"])))
    (DATA / "frit_selection.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
