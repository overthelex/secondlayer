"""Dates for the audit's record, so that "before the version date" means something.

Measured 2026-10-01: 659 of the 1,592 WEKO items cut from the journal
(CH_WEKO_RPW) carried no decision_date, and at least one carried a date its
issue cannot hold (RPW 2019/4 B 2.8.6 at 1995-10-06, a date the decision
quotes). The no-look-ahead measurement and the regime control both need to
place every agency decision before or after a given day, so an undated row
was silently in or out depending on how the query treated NULL.

Three columns on ch_weko_audit_corpus:

    date_exact        the decision's own date, or NULL
    date_upper_bound  the latest day it can carry: date_exact, else the
                      journal issue's bound (chpipe.rpw.date_upper_bound)
    date_source       text | same_as | record | issue | none

For the journal rows the date is read again with the pipeline's own reader
(services/ch-pipeline, chpipe.rpw.decision_date, checked against the issue);
where the opening names none, the entscheidsuche twin's date is taken when
the row has one (metadata rpw.same_as), and otherwise only the issue's bound
is known. Every other source keeps the date its own pipeline gave it.

A filter for "decided on or before D" uses date_upper_bound <= D: a row known
only by its issue is counted as early only when its whole window is.

    python3 dates.py --dsn ...            # report, write nothing
    python3 dates.py --dsn ... --write
"""
from __future__ import annotations

import argparse
import collections
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "services" / "ch-pipeline"))
from chpipe import rpw  # noqa: E402
from chpipe.portals.common import parse_date  # noqa: E402

COLUMNS = [
    "ALTER TABLE ch_weko_audit_corpus ADD COLUMN IF NOT EXISTS date_exact date",
    "ALTER TABLE ch_weko_audit_corpus ADD COLUMN IF NOT EXISTS date_upper_bound date",
    "ALTER TABLE ch_weko_audit_corpus ADD COLUMN IF NOT EXISTS date_source text",
]

ROWS = """
SELECT a.ecli, a.spider, a.decision_date, a.full_text,
       c.metadata_json->'rpw'->>'issue_key' AS issue_key,
       c.metadata_json->'rpw'->>'same_as'   AS same_as,
       s.decision_date                      AS same_as_date
  FROM ch_weko_audit_corpus a
  JOIN ch_court_decisions c USING (ecli)
  LEFT JOIN ch_court_decisions s ON s.ecli = c.metadata_json->'rpw'->>'same_as'
"""


def issue_of_key(key: str | None) -> rpw.Issue | None:
    m = re.fullmatch(r"(\d{4})-(\d{1,2})([a-z]?)", key or "")
    return rpw.Issue(int(m.group(1)), int(m.group(2)), m.group(3)) if m else None


# "2C_180/2014 vom 28. Juni 2016", "arrêt 4A_123/2015 du 3 mars 2016"
# "Urteil der I. Zivilabteilung vom 27. September 1977", "Extrait de l'arrêt
# de la Ire Cour civile du 3 mai 1983": older heads name no docket.
_BGE_HEAD = re.compile(r"(?:\b\d{1,2}[A-Z][_.]\d{1,4}/\d{4}|\b(?:Urteil|Entscheid|Beschluss|[Aa]rrêt|[Dd]écision"
                       r"|[Ss]entenza)\b[^;]{0,160}?)\s+(?:vom|du|del)\s+(?=\d)")


def bge_date(text: str):
    """The judgment's own date from a BGE's head. entscheidsuche dates a BGE
    on 1 January of its volume year (BGE 143 II 297, Gaba: 2017-01-01 for a
    judgment of 28 June 2016) -- 221 of the audit's 292 BGE rows."""
    head = re.sub(r"\s+", " ", (text or "")[:2500])
    m = _BGE_HEAD.search(head)
    return parse_date(head[m.end(): m.end() + 40]) if m else None


def date_of(row: dict) -> tuple:
    """(date_exact, date_upper_bound, date_source) for one row."""
    if row["spider"] == "CH_BGE":
        d = bge_date(row["full_text"])
        if d:
            return d, d, "text"
    if row["spider"] != rpw.SPIDER:
        d = row["decision_date"]
        return (d, d, "record") if d else (None, None, "none")
    issue = issue_of_key(row["issue_key"])
    d = rpw.decision_date(row["full_text"] or "", issue=issue)
    if d:
        return d, d, "text"
    twin = row["same_as_date"]
    if twin and (issue is None or rpw.plausible(twin, issue)):
        return twin, twin, "same_as"
    if issue:
        return None, rpw.date_upper_bound(issue), "issue"
    return None, None, "none"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(args.dsn, row_factory=dict_row) as conn:
        rows = conn.execute(ROWS).fetchall()
        results = {r["ecli"]: date_of(r) for r in rows}

        by_source = collections.Counter()
        changed, filled = [], 0
        for r in rows:
            exact, bound, source = results[r["ecli"]]
            by_source[(r["spider"] == rpw.SPIDER, source)] += 1
            if r["decision_date"] is None and exact is not None:
                filled += 1
            elif r["decision_date"] is not None and exact != r["decision_date"]:
                changed.append((r["ecli"], r["decision_date"], exact, source))

        print(f"{len(rows)} rows")
        for (journal, source), n in sorted(by_source.items()):
            print(f"  {'journal' if journal else 'other  '}  {source:8} {n:6}")
        print(f"undated before, dated now: {filled}")
        print(f"dated before, date changed or dropped: {len(changed)}")
        for c in changed[:40]:
            print(f"    {c[0]}  {c[1]} -> {c[2]} ({c[3]})")

        if args.write:
            for stmt in COLUMNS:
                conn.execute(stmt)
            with conn.cursor() as cur:
                cur.executemany(
                    "UPDATE ch_weko_audit_corpus SET date_exact = %s, date_upper_bound = %s, "
                    "date_source = %s WHERE ecli = %s",
                    [(*results[e], e) for e in results])
            conn.commit()
            print("written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
