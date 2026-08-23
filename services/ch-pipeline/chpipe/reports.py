"""The verification gates from the spec, as queries rather than prose.

Every count here is count(*). n_live_tup on this database has been observed
reporting 27,809 for a partition holding 8.7 million rows, so it must never be
used as a stand-in for a real count.

These functions index result rows by column name (row["total"], row["spider"]),
so the caller must hand in a connection whose row_factory is dict_row.
"""
from __future__ import annotations


def gate_a(conn) -> dict:
    """Gate A: what the sample says about HTML / PDF / OCR before the full run."""
    row = conn.execute("""
        SELECT count(*)                                              AS total,
               count(*) FILTER (WHERE text_source = 'html')          AS html,
               count(*) FILTER (WHERE text_source = 'pdf')           AS pdf,
               count(*) FILTER (WHERE text_source = 'ocr')           AS ocr,
               count(*) FILTER (WHERE stage = 'ocr_pending')         AS ocr_pending,
               count(*) FILTER (WHERE stage = 'failed')              AS failed,
               avg(text_quality)                                     AS mean_quality
          FROM ch_court_decisions
         WHERE text_quality IS NOT NULL OR stage IN ('ocr_pending','failed')
    """).fetchone()
    return {
        "total": row["total"],
        "by_source": {"html": row["html"], "pdf": row["pdf"], "ocr": row["ocr"]},
        "ocr_pending": row["ocr_pending"],
        "failed": row["failed"],
        "mean_quality": float(row["mean_quality"]) if row["mean_quality"] else 0.0,
    }


def quality_distribution(conn) -> list[tuple[float, int]]:
    """Gate C: the distribution of the score, not a count of non-empty rows.

    The project rule this exists to satisfy: this function must never report
    "N rows have text" -- only how the quality score itself is distributed,
    because that distribution is the entire reason the score was built.
    """
    rows = conn.execute("""
        SELECT floor(text_quality * 10) / 10 AS bucket, count(*) AS n
          FROM ch_court_decisions
         WHERE text_quality IS NOT NULL
         GROUP BY 1 ORDER BY 1
    """).fetchall()
    return [(float(r["bucket"]), r["n"]) for r in rows]


def completeness(conn, snapshot: dict[str, int]) -> list[dict]:
    """Gate D: our per-spider counts against entscheidsuche's own snapshot.

    `snapshot` is the `total` map from /docs/Snapshots/{date}.json. A gap of
    more than one percent is investigated, never written off.
    """
    ours = {r["spider"]: r["n"] for r in conn.execute(
        "SELECT spider, count(*) AS n FROM ch_court_decisions GROUP BY 1").fetchall()}
    out = []
    for spider, theirs in sorted(snapshot.items()):
        mine = ours.get(spider, 0)
        gap = abs(mine - theirs) / theirs if theirs else 0.0
        out.append({"spider": spider, "ours": mine, "theirs": theirs,
                    "gap_pct": round(gap * 100, 2),
                    "needs_investigation": gap > 0.01})
    return out
