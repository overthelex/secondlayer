"""The citation graph's own numbers: what citations_stage extracted and what
citations_resolve_stage managed to resolve it to.

Every count here is count(*), for the same reason chpipe/reports.py's module
docstring gives -- n_live_tup has been observed badly wrong on this
database, so it must never stand in for a real count.

`resolved_share` is None, never 0.0, over an empty population -- an empty
`ch_case_citations`/`ch_legislation_citations` means nothing has been
measured yet, and "resolved_share: 0.0" reads as "we measured, and nothing
resolved", the worst thing this report can say by accident (same discipline
as reports.gate_a's mean_quality).

This module indexes result rows by column name, so every query below goes
through an explicit dict_row cursor rather than relying on the caller's
connection default -- the same discipline reports_leg.py uses for the same
reason.
"""
from __future__ import annotations

import json

from psycopg.rows import dict_row

TOP_N = 20


def _share(resolved: int, total: int) -> float | None:
    return (resolved / total) if total else None


def _case_totals(cur) -> dict:
    """ch_case_citations: overall, and split by cite_kind (bge/docket/ecli)
    -- the three shapes citations.py's extractor ever writes."""
    cur.execute("""
        SELECT count(*) AS n, count(*) FILTER (WHERE resolved) AS resolved
          FROM ch_case_citations
    """)
    row = cur.fetchone()
    total, resolved = row["n"], row["resolved"]

    cur.execute("""
        SELECT cite_kind, count(*) AS n, count(*) FILTER (WHERE resolved) AS resolved
          FROM ch_case_citations
         GROUP BY cite_kind
         ORDER BY cite_kind
    """)
    by_kind = {
        r["cite_kind"]: {
            "total": r["n"], "resolved": r["resolved"],
            "resolved_share": _share(r["resolved"], r["n"]),
        }
        for r in cur.fetchall()
    }

    return {
        "total": total, "resolved": resolved,
        "resolved_share": _share(resolved, total),
        "by_kind": by_kind,
    }


def _legislation_totals(cur) -> dict:
    """ch_legislation_citations: overall, per language the pattern matched
    in (`lang`, NULL folded to "unknown" -- a JSON key must be a string),
    and per match_method (act_only/edition_at_date/latest_edition/
    unresolved_abbr/NULL for never-attempted)."""
    cur.execute("""
        SELECT count(*) AS n, count(*) FILTER (WHERE resolved) AS resolved
          FROM ch_legislation_citations
    """)
    row = cur.fetchone()
    total, resolved = row["n"], row["resolved"]

    cur.execute("""
        SELECT lang, count(*) AS n, count(*) FILTER (WHERE resolved) AS resolved
          FROM ch_legislation_citations
         GROUP BY lang
         ORDER BY lang
    """)
    by_lang = {
        (r["lang"] or "unknown"): {
            "total": r["n"], "resolved": r["resolved"],
            "resolved_share": _share(r["resolved"], r["n"]),
        }
        for r in cur.fetchall()
    }

    cur.execute("""
        SELECT match_method, count(*) AS n
          FROM ch_legislation_citations
         GROUP BY match_method
         ORDER BY match_method
    """)
    by_match_method = {
        (r["match_method"] or "unattempted"): r["n"] for r in cur.fetchall()
    }

    return {
        "total": total, "resolved": resolved,
        "resolved_share": _share(resolved, total),
        "by_lang": by_lang, "by_match_method": by_match_method,
    }


def _top_unresolved_abbr(cur) -> list[dict]:
    """The abbreviations ch_act_alias has nothing for, most-cited first --
    exactly what aliases_stage's curated map (or a new title_paren source)
    should be extended with next."""
    cur.execute("""
        SELECT abbr_raw, count(*) AS n
          FROM ch_legislation_citations
         WHERE match_method = 'unresolved_abbr'
         GROUP BY abbr_raw
         ORDER BY n DESC, abbr_raw
         LIMIT %s
    """, (TOP_N,))
    return [{"abbr_raw": r["abbr_raw"], "count": r["n"]} for r in cur.fetchall()]


def _top_cited_bge(cur) -> list[dict]:
    """The most-cited BGE/ATF rulings in the corpus -- cite_kind = 'bge'
    only, not every case citation: docket and ECLI references name the SAME
    court decisions in different vocabularies, and mixing all three kinds
    into one ranking would double-count a ruling cited once as a BGE number
    and once by its docket."""
    cur.execute("""
        SELECT to_raw, count(*) AS n
          FROM ch_case_citations
         WHERE cite_kind = 'bge'
         GROUP BY to_raw
         ORDER BY n DESC, to_raw
         LIMIT %s
    """, (TOP_N,))
    return [{"to_raw": r["to_raw"], "count": r["n"]} for r in cur.fetchall()]


def _decisions(cur) -> dict:
    """How much of the loaded corpus citations_stage has actually reached.
    `loaded` is ch_court_decisions.stage = 'loaded' (load_stage's terminal,
    verified-present state -- see load_stage.py's docstring); `stamped` is
    citations_extracted_at IS NOT NULL, the flag citations_stage sets once a
    decision's text has been scanned. The gap between the two is exactly
    claim_for_citations()'s own backlog."""
    cur.execute("""
        SELECT count(*) FILTER (WHERE stage = 'loaded')               AS loaded,
               count(*) FILTER (WHERE citations_extracted_at IS NOT NULL) AS stamped
          FROM ch_court_decisions
    """)
    row = cur.fetchone()
    return {"loaded": row["loaded"], "stamped": row["stamped"]}


def summary(conn) -> dict:
    """The citation graph's whole picture in one call: extraction totals,
    resolution shares, the worst-offending unresolved abbreviations, the
    most-cited BGE rulings, and how far citations_stage has gotten through
    the loaded corpus."""
    with conn.cursor(row_factory=dict_row) as cur:
        return {
            "cases": _case_totals(cur),
            "legislation": _legislation_totals(cur),
            "top_unresolved_abbr": _top_unresolved_abbr(cur),
            "top_cited_bge": _top_cited_bge(cur),
            "decisions": _decisions(cur),
        }


def main() -> dict:
    """Entry point: `summary(conn)` against CHPIPE_DSN, printed as JSON.
    Not wired into run-stage.sh -- this is a read-only report, invoked by
    hand or by a monitoring job, not a pipeline stage with a queue of its
    own to claim."""
    from . import db
    from .config import Settings

    result = summary(db.connect(Settings.from_env()))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    main()
