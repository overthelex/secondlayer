"""The verification gates from the spec, as queries rather than prose.

Every count here is count(*). n_live_tup on this database has been observed
reporting 27,809 for a partition holding 8.7 million rows, so it must never be
used as a stand-in for a real count.

These functions index result rows by column name (row["total"], row["spider"]),
so the caller must hand in a connection whose row_factory is dict_row.
"""
from __future__ import annotations


def gate_a(conn) -> dict:
    """Gate A: what the sample says about HTML / PDF / OCR before the full run.

    `stage = 'failed'` is reachable from three places, not one: extract_stage
    marks a row failed when its quality is bad and there is no scan behind it
    (HTML), but index_stage also marks a row failed when the listing offers
    neither HTML nor PDF, and fetch_stage marks one failed when its attempts
    run out. Those last two never reach this stage at all, so they never get
    a text_source or a text_quality score. Folding them into the same
    denominator as the rows that were actually extracted would silently
    understate every by_source share -- extract runs immediately after fetch
    on the same sample, and some fetches fail, so this is not a corner case.

    So the numbers below cover two different populations, kept apart:

      total, by_source, ocr_pending, failed, mean_quality
          -- rows that reached extraction (text_quality IS NOT NULL).
             by_source/ocr_pending/failed are shares OF `total`; `failed`
             here means bad-quality HTML with nothing left to try.

      pre_extraction_failed
          -- rows marked failed before they ever reached this stage (no
             body available, or fetch exhausted its attempts). Not part of
             `total` and not a share of anything -- reported as its own
             count so it is never hidden inside a shrunk denominator.
    """
    reached = "text_quality IS NOT NULL"    # a row that reached extraction
    row = conn.execute(f"""
        SELECT count(*) FILTER (WHERE {reached})                          AS total,
               count(*) FILTER (WHERE {reached} AND text_source = 'html') AS html,
               count(*) FILTER (WHERE {reached} AND text_source = 'pdf')  AS pdf,
               count(*) FILTER (WHERE {reached} AND text_source = 'ocr')  AS ocr,
               count(*) FILTER (WHERE stage = 'ocr_pending')              AS ocr_pending,
               count(*) FILTER (WHERE stage = 'failed' AND {reached})     AS extraction_failed,
               count(*) FILTER (WHERE stage = 'failed' AND NOT {reached}) AS pre_extraction_failed,
               avg(text_quality)                                          AS mean_quality
          FROM ch_court_decisions
    """).fetchone()
    return {
        "total": row["total"],
        "by_source": {"html": row["html"], "pdf": row["pdf"], "ocr": row["ocr"]},
        "ocr_pending": row["ocr_pending"],
        "failed": row["extraction_failed"],
        "pre_extraction_failed": row["pre_extraction_failed"],
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
