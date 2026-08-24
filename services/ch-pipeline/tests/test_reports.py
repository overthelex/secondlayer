import os
import pathlib
import psycopg
from psycopg.rows import dict_row
import pytest
from chpipe import reports

# Derive repo root from this file's location: services/ch-pipeline/tests/test_reports.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    # reports.py indexes result rows by column name, so this connection must
    # hand back dict rows -- a plain psycopg.connect() yields tuples and
    # reports.py's row["total"] etc. would raise TypeError.
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text, decision_type text,
                decision_date date, docket_number text, parties text, abstract text,
                full_text text, pdf_url text, json_url text, languages text[],
                metadata_json jsonb, imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _row(conn, doc_id, spider, source, quality, stage):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, text_source, "
        "text_quality, stage) VALUES (%s,%s,%s,%s,%s,%s)",
        (f"e:{doc_id}", spider, doc_id, source, quality, stage))


def test_gate_a_reports_shares_by_source_and_the_ocr_backlog(conn):
    _row(conn, "a", "GE_Gerichte", "html", 0.9, "extracted")
    _row(conn, "b", "GE_Gerichte", "html", 0.8, "extracted")
    _row(conn, "c", "CH_BVGer", "pdf", 0.7, "extracted")
    _row(conn, "d", "CH_BVGer", "pdf", 0.1, "ocr_pending")
    g = reports.gate_a(conn)
    assert g["total"] == 4
    assert g["by_source"]["html"] == 2
    assert g["by_source"]["pdf"] == 2
    assert g["ocr_pending"] == 1
    assert 0.6 < g["mean_quality"] < 0.7


def test_gate_a_separates_pre_extraction_failures_from_the_extracted_population(conn):
    """Round 1 finding: stage = 'failed' is reachable from three places, not
    one. index_stage marks a row failed when the listing has neither HTML
    nor PDF, and fetch_stage marks one failed when attempts run out --
    neither of those two ever gets a text_source or a text_quality score, so
    folding them into gate_a's denominator silently understates every
    by_source share. They must be counted separately and never hidden."""
    # An extraction-stage failure: HTML with bad quality, so text_source and
    # text_quality ARE set -- it reached extraction, it just failed there.
    _row(conn, "a", "GE_Gerichte", "html", 0.9, "extracted")
    _row(conn, "b", "GE_Gerichte", "html", 0.1, "failed")
    # An index-stage failure: no body was ever available, so neither
    # text_source nor text_quality is set -- it never reached extraction.
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage) "
        "VALUES (%s,%s,%s,%s)",
        ("e:c", "ZH_Obergericht", "c", "failed"))

    g = reports.gate_a(conn)

    assert g["total"] == 2, "only rows that reached extraction count toward the total"
    assert g["failed"] == 1, "the extraction-stage failure (bad HTML quality)"
    assert g["pre_extraction_failed"] == 1, "the index-stage failure, kept apart"
    assert (g["by_source"]["html"] + g["by_source"]["pdf"] + g["by_source"]["ocr"]
            == g["total"]), "by-source shares must sum to the same population as total"


def test_quality_distribution_buckets_by_tenth(conn):
    for i, q in enumerate([0.05, 0.15, 0.15, 0.95]):
        _row(conn, f"d{i}", "S", "pdf", q, "extracted")
    dist = dict((row[0], row[1]) for row in reports.quality_distribution(conn))
    assert dist[0.1] == 2
    assert dist[0.0] == 1


def test_completeness_flags_a_spider_more_than_one_percent_short(conn):
    """Per-spider behaviour, unchanged in meaning: still one row per snapshot
    key that matches a real spider name, now returned under result["per_spider"]
    alongside the corpus-level and uncovered pieces."""
    for i in range(90):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    result = reports.completeness(conn, {"GE_Gerichte": 100}, total_alle=100)
    rows = {r["spider"]: r for r in result["per_spider"]}
    assert rows["GE_Gerichte"]["ours"] == 90
    assert rows["GE_Gerichte"]["theirs"] == 100
    assert rows["GE_Gerichte"]["needs_investigation"] is True


def test_completeness_accepts_a_spider_within_one_percent(conn):
    for i in range(100):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    result = reports.completeness(conn, {"GE_Gerichte": 100}, total_alle=100)
    rows = {r["spider"]: r for r in result["per_spider"]}
    assert rows["GE_Gerichte"]["needs_investigation"] is False


def test_completeness_reports_the_corpus_level_gap(conn):
    """Round 2 finding: the per-spider comparison only ever covers the
    spiders whose name happens to match a snapshot key (7 of 54 against a
    real entscheidsuche snapshot). The corpus-level number is exact and
    level-independent -- it is the one figure that actually answers "did we
    get everything" -- so it must be reported on its own, not derived by the
    caller from the per-spider rows."""
    for i in range(80):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    result = reports.completeness(conn, {"GE_Gerichte": 80}, total_alle=100)
    assert result["corpus"]["ours"] == 80
    assert result["corpus"]["theirs"] == 100
    assert result["corpus"]["gap_pct"] == 20.0
    assert result["corpus"]["needs_investigation"] is True


def test_completeness_reports_snapshot_keys_that_match_no_spider_as_uncovered(conn):
    """The gate must state its own blind spot instead of silently dropping a
    snapshot key that names no spider we know about (entscheidsuche's
    court-code naming, e.g. "ZH_OG", differs from our spider names, e.g.
    "ZH_Obergericht"). A clean per-spider result must not read as "the
    backfill is done" while keys like these sit uncounted."""
    for i in range(80):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    result = reports.completeness(
        conn, {"GE_Gerichte": 80, "ZH_OG": 15, "not_a_spider_at_all": 5},
        total_alle=100)
    assert result["uncovered"]["key_count"] == 2
    assert result["uncovered"]["docs"] == 20
    assert result["uncovered"]["share_pct"] == 20.0
    # the matched key is unaffected -- it shows up in per_spider, not folded
    # into uncovered
    assert {r["spider"] for r in result["per_spider"]} == {"GE_Gerichte"}


def test_gate_a_reports_no_mean_quality_when_nothing_was_measured(conn):
    """A gate with an empty population must return None, not a number that
    reads as "we measured, and the quality was zero" -- which is the single
    worst thing a verification gate can say. avg() over no rows is SQL NULL
    for exactly this reason."""
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage) "
        "VALUES ('e:a','S','a','indexed')")
    g = reports.gate_a(conn)
    assert g["total"] == 0
    assert g["mean_quality"] is None


def test_gate_a_reports_a_genuine_zero_as_zero(conn):
    """The other direction: a measured 0.0 is a real finding and must not be
    confused with an absent one."""
    _row(conn, "a", "S", "pdf", 0.0, "failed")
    g = reports.gate_a(conn)
    assert g["total"] == 1
    assert g["mean_quality"] == 0.0


# --- Gate D: a snapshot that says nothing must not read as a clean corpus ---
#
# `if total_alle else 0.0` made a zero/absent grand total report gap_pct 0.0
# and needs_investigation False -- the most reassuring output this gate can
# produce, from the one input that carries no information at all.

def test_a_zero_snapshot_total_against_a_populated_corpus_is_flagged(conn):
    _row(conn, "g1", "GE_Gerichte", "html", 0.9, "loaded")
    _row(conn, "g2", "GE_Gerichte", "html", 0.9, "loaded")
    result = reports.completeness(conn, {}, total_alle=0)
    assert result["corpus"]["snapshot_unusable"] is True
    assert result["corpus"]["needs_investigation"] is True
    assert result["corpus"]["gap_pct"] is None, \
        "a gap that could not be computed is None, never a number"
    assert result["corpus"]["ours"] == 2


def test_both_sides_zero_is_a_genuine_clean_zero(conn):
    """An empty scratch database agreeing with an empty snapshot is not a
    malformed snapshot -- the flag must not fire on it."""
    result = reports.completeness(conn, {}, total_alle=0)
    assert result["corpus"]["snapshot_unusable"] is False
    assert result["corpus"]["needs_investigation"] is False
    assert result["corpus"]["gap_pct"] == 0.0


def test_a_usable_snapshot_still_reports_a_numeric_gap(conn):
    _row(conn, "g1", "GE_Gerichte", "html", 0.9, "loaded")
    result = reports.completeness(conn, {"GE_Gerichte": 1}, total_alle=1)
    assert result["corpus"]["snapshot_unusable"] is False
    assert result["corpus"]["gap_pct"] == 0.0
