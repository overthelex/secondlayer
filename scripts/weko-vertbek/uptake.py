"""How often the record cites the vertical-restraints notice, year by year
(PAPER-241), and how much competition practice there is to cite it.

A first count found no citation before 2008. It knew only the short German
names (Vertikalbekanntmachung, VertBek); the early decisions cite the notice
by its full title ("Bekanntmachung der Wettbewerbskommission über die
wettbewerbsrechtliche Behandlung vertikaler Abreden vom 18. Februar 2002"),
and the French ones as "Communication concernant l'appréciation des accords
verticaux" or "ComVert". Two look-alikes are kept out: the notice itself
(its RPW part D1, and its reprints in the VPB and the Federal Gazette), and
the separate notice on motor-vehicle distribution ("... vertikaler Abreden
im Kraftfahrzeughandel", "... accords verticaux dans le domaine de la
distribution automobile").

The numerator runs over the whole Swiss corpus (ch_court_decisions); the
denominator is the audit's competition record (ch_weko_audit_corpus), by
the year a decision can be shown to fall in (date_upper_bound).

    python3 uptake.py --dsn ... --out ../../data/weko-vertbek/uptake.json
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE.parents[1] / "data" / "weko-vertbek"

NAMES = [
    re.compile(r"vertikal-?\s?bekanntmachung", re.I),
    re.compile(r"\bVertBek\b"),
    re.compile(r"bekanntmachung[^.]{0,80}?vertikale[nr]?\s+abreden", re.I),
    re.compile(r"communication\s+concernant\s+l.appr[ée]ciation\s+des\s+accords\s+verticaux", re.I),
    re.compile(r"communication\s+(?:sur|concernant)\s+les\s+accords\s+verticaux", re.I),
    re.compile(r"\b(?:ComVert|CommVert)\b"),
    re.compile(r"comunicazione\s+(?:sulla\s+valutazione\s+degli|sugli|riguardante\s+la\s+valutazione\s+degli)\s+accordi\s+verticali", re.I),
]
# the motor-vehicle notice: removed from the text before the names are matched
MOTOR = re.compile(r"(vertikalen?r?\s+abreden\s+im\s+kraftfahrzeug(?:handel|sektor)|kfz-?\s?bekanntmachung|\bKFZ-Bek\b"
                   r"|accords\s+verticaux\s+dans\s+le\s+domaine\s+de\s+la\s+distribution\s+automobile"
                   r"|accordi\s+verticali\s+nel\s+settore\s+della\s+distribuzione\s+di\s+autoveicoli)", re.I)
# a reprint of the notice opens with its own title and the Commission's resolution
SELF = re.compile(r"^\W*(?:publications\s+des\s+départements\s+et\s+des\s+offices\s+de\s+la\s+confédération\s+"
                  r"|publikationen\s+der\s+departemente\s+und\s+ämter\s+der\s+eidgenossenschaft\s+"
                  r"|pubblicazioni\s+dei\s+dipartimenti\s+e\s+degli\s+uffici\s+della\s+confederazione\s+)?"
                  r"(?:[A-Z]\s?\d[.\d]*\s+\d+\.\s+)?(?:bekanntmachung\s+über\s+die\s+wettbewerbsrechtliche\s+behandlung\s+vertikaler"
                  r"|communication\s+concernant\s+l.appr[ée]ciation\s+des\s+accords\s+verticaux"
                  r"|comunicazione\s+(?:sulla|riguardante\s+la)\s+valutazione\s+degli\s+accordi\s+verticali"
                  r"|erläuterungen\s+zur\s+vertikalbekanntmachung)", re.I)


def tier(spider: str) -> str:
    if spider.startswith("CH_WEKO"):
        return "agency"
    if spider in ("CH_BGE", "CH_BGer", "CH_BVGer", "CH_BSTG"):
        return "federal_court"
    if not spider.startswith("CH_"):
        return "cantonal"
    return "other_federal"


def cites(text: str) -> bool:
    head = re.sub(r"\s+", " ", text[:600])
    if SELF.search(head):
        return False
    t = MOTOR.sub(" ", text)
    return any(p.search(t) for p in NAMES)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--out", type=pathlib.Path, default=DATA / "uptake.json")
    ap.add_argument("--samples", type=int, default=3, help="contexts printed per year, to check precision")
    args = ap.parse_args()
    import psycopg
    from psycopg.rows import dict_row
    conn = psycopg.connect(args.dsn, row_factory=dict_row)
    conn.execute("SET statement_timeout = '1800s'")

    # numerator: any decision in the corpus that names the notice
    rows = conn.execute("""
        SELECT d.ecli, d.spider, d.docket_number, a.date_upper_bound, a.rpw_chapter,
               coalesce(a.date_upper_bound, d.decision_date) AS d, d.full_text
          FROM ch_court_decisions d LEFT JOIN ch_weko_audit_corpus a ON a.ecli = d.ecli
         WHERE d.stage = 'loaded'
           AND d.full_text ~* '(vertikal|VertBek|accords verticaux|ComVert|CommVert|accordi verticali)'""").fetchall()
    citing = collections.defaultdict(collections.Counter)
    samples = collections.defaultdict(list)
    seen_docket = set()
    for r in rows:
        if r["rpw_chapter"] == "D1" or not r["d"] or not cites(r["full_text"] or ""):
            continue
        # one judgment reprinted in several sources counts once
        key = ((r["docket_number"] or "").strip().lower(), r["d"])
        if key in seen_docket:
            continue
        seen_docket.add(key)
        y = r["d"].year
        citing[y][tier(r["spider"])] += 1
        if len(samples[y]) < args.samples:
            t = MOTOR.sub(" ", r["full_text"])
            m = next(p.search(t) for p in NAMES if p.search(t))
            samples[y].append(f"{r['spider']} {r['docket_number']}: …{re.sub(chr(10), ' ', t[max(0, m.start() - 70): m.end() + 40])}…")

    # denominator: the competition record, one decision per docket and year
    base = collections.defaultdict(collections.Counter)
    seen = set()
    for r in conn.execute("""SELECT spider, docket_number, date_upper_bound FROM ch_weko_audit_corpus
                              WHERE rpw_chapter IS DISTINCT FROM 'D1' AND date_upper_bound IS NOT NULL""").fetchall():
        key = ((r["docket_number"] or "").strip().lower(), r["date_upper_bound"])
        if key in seen:
            continue
        seen.add(key)
        base[r["date_upper_bound"].year][tier(r["spider"])] += 1

    years = sorted(y for y in set(citing) | set(base) if 1996 <= y <= 2026)
    out = [{"year": y, "record": sum(base[y].values()), "record_by_tier": dict(base[y]),
            "citing": sum(citing[y].values()), "citing_by_tier": dict(citing[y])} for y in years]
    args.out.write_text(json.dumps({"years": out, "samples": {str(k): v for k, v in samples.items()}},
                                   ensure_ascii=False, indent=1))
    with open(args.out.with_suffix(".csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["year", "tier", "citing", "record"])
        for y in years:
            for t in ("agency", "federal_court", "cantonal", "other_federal"):
                w.writerow([y, t, citing[y].get(t, 0), base[y].get(t, 0)])
    for o in out:
        print(f"{o['year']}: record {o['record']:4}  citing {o['citing']:3}  {o['citing_by_tier']}")
    print("\nsamples:")
    for y in sorted(samples):
        for s in samples[y]:
            print(f"  {y} {s[:230]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
