"""No stage may spin on a population it cannot drain.

Every claiming stage is `while True: claim(); if not rows: break`. That
terminates only if each claimed row is guaranteed to leave the stage (or to
burn an attempt) before the next iteration. It did not: `claim` handed out
rows with a NULL doc_id, and both `complete` and `fail` key on
`WHERE doc_id = %s`, so nothing moved and the identical rows came back on
the next pass -- forever, against a volunteer-run mirror, with
`report.fetched_pdf` counting every non-write as a success.

All four claiming stages are exercised here (index does not claim; it walks
a spider list and terminates by construction). Each test seeds ONLY
legacy-shaped rows -- `ecli` set, `doc_id` NULL, exactly the 678,165 rows
already on prod before `index` runs -- and runs the stage with no `limit`,
which is how it runs in production. `db.claim` is wrapped with a counter
that aborts after a handful of calls, so a regression fails loudly and
quickly instead of hanging the suite.
"""
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import db
from chpipe.config import Settings
from chpipe.stages import extract_stage, fetch_stage, load_stage, ocr_stage

_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

MAX_CLAIMS = 5


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        c.execute("DROP TABLE IF EXISTS ch_court_decisions")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text NOT NULL,
                court_code text, court_name text, chamber text,
                decision_type text, decision_date date, docket_number text,
                parties text, abstract text, full_text text,
                pdf_url text, json_url text, languages text[], metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now())
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _seed_unkeyed(conn, n, stage, spider="S"):
    for i in range(n):
        conn.execute(
            "INSERT INTO ch_court_decisions (ecli, spider, stage, pdf_url, "
            "text_source, full_text) VALUES (%s,%s,%s,%s,'pdf',%s)",
            (f"ECLI:CH:{spider}:legacy{i}", spider, stage,
             f"https://x/legacy{i}.pdf", "x" * 500))


def _settings(tmp_path, backoff=()):
    """backoff defaults to () so a single run() call can exercise a row's
    whole retry budget; production keeps the spec's 1/5/30-minute wait."""
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=2, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3,
                    retry_backoff_minutes=backoff)


@pytest.fixture
def counted_claim(monkeypatch):
    """db.claim, counted, and hard-stopped before a runaway loop can hang."""
    calls = {"n": 0}
    real = db.claim

    def wrapper(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] > MAX_CLAIMS:
            raise AssertionError(
                f"the stage loop did not drain: {MAX_CLAIMS} claims and still "
                "going, which in production is an endless re-fetch of the same "
                "rows from a volunteer-run mirror")
        return real(*args, **kwargs)

    monkeypatch.setattr(db, "claim", wrapper)
    return calls


def test_fetch_drains_instead_of_spinning_on_unkeyed_rows(conn, tmp_path,
                                                          counted_claim):
    _seed_unkeyed(conn, 3, "indexed")
    report = fetch_stage.run(_settings(tmp_path))
    assert counted_claim["n"] == 1
    assert (report.fetched_html, report.fetched_pdf, report.failed) == (0, 0, 0), \
        "a row that was never written must not be counted as fetched"


def test_extract_drains_instead_of_spinning_on_unkeyed_rows(conn, tmp_path,
                                                            counted_claim):
    _seed_unkeyed(conn, 3, "fetched")
    report = extract_stage.run(_settings(tmp_path))
    assert counted_claim["n"] == 1
    assert (report.extracted, report.queued_for_ocr, report.failed) == (0, 0, 0)


def test_ocr_drains_instead_of_spinning_on_unkeyed_rows(conn, tmp_path,
                                                        counted_claim):
    _seed_unkeyed(conn, 3, "ocr_pending")
    report = ocr_stage.run(_settings(tmp_path))
    assert counted_claim["n"] == 1
    assert (report.recovered, report.still_bad, report.failed) == (0, 0, 0)


def test_load_drains_instead_of_spinning_on_unkeyed_rows(conn, tmp_path,
                                                         counted_claim):
    _seed_unkeyed(conn, 3, "extracted")
    report = load_stage.run(_settings(tmp_path))
    assert counted_claim["n"] == 1
    assert report.loaded == 0


def test_a_keyed_row_that_cannot_be_written_still_terminates(conn, tmp_path,
                                                             counted_claim):
    """The other half of the same rule: a row that IS claimable but whose
    write keeps failing must burn its attempts budget and leave the stage,
    not be re-claimed forever. Three attempts, three claims, then done.

    The retry backoff is disabled here so the whole budget is spent inside
    one run(); with the production 1/5/30-minute wait the row would simply
    not be re-offered until the next run, which is the point of the wait.
    """
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, full_text) "
        "VALUES ('e:k','S','k','extracted',%s)", ("x" * 500,))

    def always_fails(conn_, doc_id, next_stage, **fields):
        raise RuntimeError("simulated write failure")

    import unittest.mock
    with unittest.mock.patch.object(load_stage.db, "complete", always_fails):
        load_stage.run(_settings(tmp_path))

    row = conn.execute(
        "SELECT stage, attempts FROM ch_court_decisions WHERE doc_id='k'").fetchone()
    assert row["stage"] == "failed"
    assert row["attempts"] == 3
    assert counted_claim["n"] <= 4
