"""decision_index_stage: maintains ch_decision_index (migration 207), the
inbound-citation aggregates the precedent-status tools read. A mocked DB
cannot validate the INSERT ... ON CONFLICT / anti-join SQL, so this is a
scratch-database test like test_citations_resolve_stage.py.
"""
import os
import pathlib
from datetime import date

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.config import Settings
from chpipe.stages import decision_index_stage

from conftest import apply_migration_207

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        # Same isolation pattern as test_citations_resolve_stage.py: drop the
        # citation tables plus a minimal ch_court_decisions (migration 199
        # ALTERs it, so it has to exist before 199 applies).
        for t in ("ch_decision_index", "ch_case_citations",
                  "ch_legislation_citations", "ch_act_alias",
                  "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text,
                doc_id text,
                docket_number text,
                stage text
            )
        """)
        apply_migration_207(c)
        yield c


def _edge(conn, from_ecli, to_ecli, *, resolved=True, from_date=None,
          from_court=None, to_raw=None):
    conn.execute(
        "INSERT INTO ch_case_citations (from_ecli, to_raw, cite_kind, to_ecli, "
        "resolved, match_method, from_date, from_court) "
        "VALUES (%s, %s, 'docket', %s, %s, %s, %s, %s)",
        (from_ecli, to_raw or f"{from_ecli}->{to_ecli}", to_ecli, resolved,
         "docket_exact" if resolved else "unresolved", from_date, from_court))


def _rows(conn):
    return conn.execute(
        "SELECT * FROM ch_decision_index ORDER BY ecli").fetchall()


def test_aggregates_resolved_inbound_edges(settings, conn):
    _edge(conn, "ECLI:CH:A", "ECLI:CH:T", from_date=date(2020, 1, 1),
          from_court="CH_BGer")
    _edge(conn, "ECLI:CH:B", "ECLI:CH:T", from_date=date(2024, 6, 1),
          from_court="ZH_Obergericht")
    _edge(conn, "ECLI:CH:C", "ECLI:CH:T", from_date=date(2022, 3, 1),
          from_court="CH_BGer")

    report = decision_index_stage.run(settings)

    rows = _rows(conn)
    assert len(rows) == 1
    row = rows[0]
    assert row["ecli"] == "ECLI:CH:T"
    assert row["cited_by_count"] == 3
    assert row["citing_courts"] == 2
    assert row["first_citing_date"] == date(2020, 1, 1)
    assert row["last_citing_date"] == date(2024, 6, 1)
    assert report.upserted == 1
    assert report.total == 1


def test_ignores_unresolved_edges(settings, conn):
    _edge(conn, "ECLI:CH:A", None, resolved=False)

    decision_index_stage.run(settings)

    assert _rows(conn) == []


def test_excludes_self_citations(settings, conn):
    """A decision restating its own docket number resolves to itself; that
    edge is not precedent and must not count."""
    _edge(conn, "ECLI:CH:T", "ECLI:CH:T")
    _edge(conn, "ECLI:CH:A", "ECLI:CH:T")

    decision_index_stage.run(settings)

    rows = _rows(conn)
    assert len(rows) == 1
    assert rows[0]["cited_by_count"] == 1


def test_second_run_is_a_noop(settings, conn):
    _edge(conn, "ECLI:CH:A", "ECLI:CH:T", from_date=date(2021, 1, 1))
    decision_index_stage.run(settings)
    before = _rows(conn)[0]["refreshed_at"]

    report = decision_index_stage.run(settings)

    assert report.upserted == 0
    assert report.removed == 0
    assert report.total == 1
    # The upsert's IS DISTINCT FROM guard must leave an unchanged row alone
    # -- otherwise every nightly delta rewrites all ~1.5M rows just to bump
    # refreshed_at, which is exactly the wide-update shape this stage exists
    # to avoid.
    assert _rows(conn)[0]["refreshed_at"] == before


def test_new_edge_updates_the_row(settings, conn):
    _edge(conn, "ECLI:CH:A", "ECLI:CH:T", from_date=date(2021, 1, 1),
          from_court="CH_BGer")
    decision_index_stage.run(settings)
    _edge(conn, "ECLI:CH:B", "ECLI:CH:T", from_date=date(2025, 2, 2),
          from_court="CH_BVGer")

    report = decision_index_stage.run(settings)

    row = _rows(conn)[0]
    assert row["cited_by_count"] == 2
    assert row["citing_courts"] == 2
    assert row["last_citing_date"] == date(2025, 2, 2)
    assert report.upserted == 1


def test_row_removed_when_its_edges_are_gone(settings, conn):
    """CHPIPE_CIT_RESOLVE_ALL resets to_ecli on every edge before
    re-resolving, and a re-extraction can delete edges outright -- a row
    whose inbound edges no longer exist must not survive as a stale
    aggregate."""
    _edge(conn, "ECLI:CH:A", "ECLI:CH:T")
    _edge(conn, "ECLI:CH:B", "ECLI:CH:U")
    decision_index_stage.run(settings)
    conn.execute("DELETE FROM ch_case_citations WHERE to_ecli = 'ECLI:CH:T'")

    report = decision_index_stage.run(settings)

    rows = _rows(conn)
    assert [r["ecli"] for r in rows] == ["ECLI:CH:U"]
    assert report.removed == 1
    assert report.total == 1


def test_null_dates_and_courts_do_not_break_the_aggregate(settings, conn):
    _edge(conn, "ECLI:CH:A", "ECLI:CH:T")

    decision_index_stage.run(settings)

    row = _rows(conn)[0]
    assert row["cited_by_count"] == 1
    assert row["citing_courts"] == 0
    assert row["first_citing_date"] is None
    assert row["last_citing_date"] is None
