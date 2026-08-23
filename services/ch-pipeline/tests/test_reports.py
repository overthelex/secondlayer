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
    for i in range(90):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    rows = {r["spider"]: r for r in reports.completeness(conn, {"GE_Gerichte": 100})}
    assert rows["GE_Gerichte"]["ours"] == 90
    assert rows["GE_Gerichte"]["theirs"] == 100
    assert rows["GE_Gerichte"]["needs_investigation"] is True


def test_completeness_accepts_a_spider_within_one_percent(conn):
    for i in range(100):
        _row(conn, f"g{i}", "GE_Gerichte", "html", 0.9, "loaded")
    rows = {r["spider"]: r for r in reports.completeness(conn, {"GE_Gerichte": 100})}
    assert rows["GE_Gerichte"]["needs_investigation"] is False
