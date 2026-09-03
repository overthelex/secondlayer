"""The verification gates from the spec, as queries rather than prose.

Every count here is count(*). n_live_tup on this database has been observed
reporting 27,809 for a partition holding 8.7 million rows, so it must never be
used as a stand-in for a real count.

These functions index result rows by column name (row["total"], row["spider"]),
so the caller must hand in a connection whose row_factory is dict_row.
"""
from __future__ import annotations

from .portals import PORTAL_SPIDERS
from .stages.index_stage import ALL_SPIDERS


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
             mean_quality is None when `total` is 0: nothing was measured,
             which is not the same claim as "the quality was zero".
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
        # None, never 0.0. A gate whose population is empty has not measured
        # anything, and "mean_quality: 0.0" reads as "we measured, and the
        # quality was zero" -- the single worst thing a verification gate can
        # say. avg() over no rows is SQL NULL for exactly this reason; passing
        # it through is the honest answer. (The old `if row["mean_quality"]`
        # also mapped a genuine measured 0.0 to 0.0, which was harmless, and
        # an empty population to 0.0, which was not.)
        "mean_quality": (None if row["mean_quality"] is None
                         else float(row["mean_quality"])),
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


def completeness(conn, snapshot: dict[str, int], total_alle: int) -> dict:
    """Gate D: our counts against entscheidsuche's own snapshot.

    `snapshot` is the `total` map from /docs/Snapshots/{date}.json;
    `total_alle` is that same file's own grand total.

    Measured against the 2026-08-20 snapshot: `total` is not a flat
    per-spider count. It mixes three nested hierarchy levels of the *same*
    corpus into one dict -- a per-canton rollup (28 keys, e.g. "ZH"), a
    per-court-code level (131 keys, e.g. "ZH_OG"), and a per-chamber level
    (360 keys, e.g. "CH_BGer_001") -- and each level independently sums to
    `total_alle` on its own. Matching keys to our spider names by string
    equality only succeeds for 7 of our 54 spiders (`ALL_SPIDERS`), because
    entscheidsuche's court-code naming differs from ours (its "ZH_OG" is our
    "ZH_Obergericht", its "GE_CJ" is our "GE_Gerichte", and so on). A gate
    that reported completeness only over those 7 spiders would be worse than
    no gate at all: a clean result would read as "the backfill is done"
    while actually covering roughly a quarter of the corpus. So this
    function returns three independently-scoped pieces -- read all three,
    not just one:

      corpus      -- {ours, theirs, gap_pct, needs_investigation,
                      snapshot_unusable}. `ours` is
                      count(*) over the whole table; `theirs` is
                      `total_alle`. Exact and level-independent -- this is
                      the one number that actually answers "did we get
                      everything", and it does not depend on any name match.
                      Always trust this one first.

                      `snapshot_unusable` is True when `total_alle` is zero
                      or absent while `ours` is not: the snapshot said
                      nothing, and every figure in this result that divides
                      by it -- `gap_pct` here, `uncovered.share_pct` below --
                      is meaningless rather than good news. `gap_pct` is None
                      in that case and `needs_investigation` is True, so the
                      gate cannot be read as passing on an input it never got.

      per_spider  -- one row per snapshot key that is also a known spider
                      name (`chpipe.stages.index_stage.ALL_SPIDERS`):
                      {spider, ours, theirs, gap_pct, needs_investigation}.
                      A gap of more than one percent is `needs_investigation`.
                      This only covers the spiders whose name happens to
                      match a snapshot key -- see `uncovered` for the rest.

      uncovered   -- {key_count, docs, share_pct}: the snapshot keys that
                      match no known spider name, how many there are, and
                      what share of `total_alle` their raw values add up to.
                      This is the gate's own blind spot, stated in its own
                      output rather than silently dropped. Because `total`
                      mixes the three nested levels described above,
                      `docs`/`share_pct` sum values from more than one level
                      at once and can legitimately exceed `total_alle` (i.e.
                      a share over 100%) -- that is not a bug, it is the
                      nested structure showing through. Do not read
                      `uncovered.share_pct` as "percent of the corpus we are
                      missing"; read `corpus` for that. `uncovered` only
                      tells you how much of the raw snapshot dict this gate
                      cannot currently place against a spider.
    """
    # The portal spiders (chpipe/portals) are not on entscheidsuche, so they
    # are no part of the comparison against its snapshot on either side.
    ours_total = conn.execute(
        "SELECT count(*) AS n FROM ch_court_decisions WHERE spider <> ALL(%s)",
        (sorted(PORTAL_SPIDERS),)).fetchone()["n"]
    # A snapshot whose grand total is zero or absent while we hold documents
    # is a MALFORMED SNAPSHOT, not a gap-free corpus. `if total_alle else
    # 0.0` used to make that case report gap_pct 0.0 and
    # needs_investigation False -- the single most reassuring output this
    # gate can produce, emitted from the one input that says nothing at all.
    # (The reverse -- both sides zero -- is a genuine clean zero: an empty
    # scratch database agreeing with an empty snapshot.) Same discipline as
    # gate_a's mean_quality above: a figure that was not measurable is None,
    # never a number that reads as a measurement.
    snapshot_unusable = not total_alle and ours_total > 0
    corpus_gap = abs(ours_total - total_alle) / total_alle if total_alle else 0.0
    corpus = {
        "ours": ours_total,
        "theirs": total_alle,
        "gap_pct": None if snapshot_unusable else round(corpus_gap * 100, 2),
        "needs_investigation": snapshot_unusable or corpus_gap > 0.01,
        "snapshot_unusable": snapshot_unusable,
    }

    ours_by_spider = {r["spider"]: r["n"] for r in conn.execute(
        "SELECT spider, count(*) AS n FROM ch_court_decisions GROUP BY 1").fetchall()}

    spider_names = set(ALL_SPIDERS)
    per_spider = []
    for spider, theirs in sorted(snapshot.items()):
        if spider not in spider_names:
            continue
        mine = ours_by_spider.get(spider, 0)
        gap = abs(mine - theirs) / theirs if theirs else 0.0
        per_spider.append({"spider": spider, "ours": mine, "theirs": theirs,
                           "gap_pct": round(gap * 100, 2),
                           "needs_investigation": gap > 0.01})

    uncovered_keys = [k for k in snapshot if k not in spider_names]
    uncovered_docs = sum(snapshot[k] for k in uncovered_keys)
    uncovered_share = (uncovered_docs / total_alle * 100) if total_alle else 0.0
    uncovered = {
        "key_count": len(uncovered_keys),
        "docs": uncovered_docs,
        "share_pct": round(uncovered_share, 2),
    }

    return {"corpus": corpus, "per_spider": per_spider, "uncovered": uncovered}
