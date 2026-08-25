"""citations_stage: runs chpipe.citations over `loaded` decisions and writes
raw edges into ch_case_citations / ch_legislation_citations. A mocked DB
cannot validate the executemany/ON CONFLICT DO NOTHING SQL, so this is a
scratch-database test like test_load_stage.py and test_migration_199.py.
"""
import datetime
import os
import pathlib
from datetime import date

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import db
from chpipe.config import Settings
from chpipe.stages import citations_stage

from conftest import apply_migration_199

# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_citations_stage.py is 3 levels down from the repo root (matches the
# convention already used in tests/test_load_stage.py).
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_196 = _REPO_ROOT / "mcp_backend/src/migrations/196_ch_court_pipeline.sql"

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
        # Drop the citation tables first for isolation (same pattern as
        # test_migration_199.py), then a minimal ch_court_decisions with
        # migrations 196 and 199 layered on top -- the ALTER TABLE / partial
        # index / stage enrolment both migrations add.
        for t in ("ch_case_citations", "ch_legislation_citations", "ch_act_alias",
                  "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text NOT NULL,
                doc_id text,
                court_code text,
                decision_date date,
                full_text text,
                stage text,
                docket_number text,
                updated_at timestamptz DEFAULT now()
            )
        """)
        c.execute(MIGRATION_196.read_text())
        # ch_act_article (migration 197's table, which 199 indexes but does
        # not create) and migration 199 itself -- see tests/conftest.py.
        apply_migration_199(c)
        yield c


def _row(conn, ecli, doc_id, court_code, decision_date, text, stage="loaded",
        spider="CH_BGer", docket_number=None):
    conn.execute(
        "INSERT INTO ch_court_decisions "
        "(ecli, spider, doc_id, court_code, decision_date, full_text, stage, docket_number) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (ecli, spider, doc_id, court_code, decision_date, text, stage, docket_number))


def test_a_decision_does_not_cite_its_own_docket(conn, settings):
    """The masthead repeats the decision's own docket; that is not an edge.
    Other dockets in the same text still are."""
    _row(conn, "ECLI:SELF", "self", "CH_BGer_004", datetime.date(2020, 5, 1),
         "Urteil 4A_22/2017 vom 19. Juni 2017. Vgl. Urteil 4A_99/2016 und BGE 142 III 102.",
         docket_number="4A_22/2017")
    citations_stage.run(settings)
    raws = sorted(r["to_raw"] for r in conn.execute(
        "SELECT to_raw FROM ch_case_citations WHERE from_ecli = 'ECLI:SELF'").fetchall())
    assert raws == ["4A_99/2016", "BGE 142 III 102"]


def test_extracts_citations_and_stamps_loaded_decisions(conn, settings):
    _row(conn, "ECLI:A", "a", "CH_BGer", date(2020, 5, 1),
        "Art. 336 Abs. 1 OR ... BGE 142 III 102")
    _row(conn, "ECLI:B", "b", "CH_BGer", date(2021, 1, 1), "art. 8 Cst.")
    # Not 'loaded' -- must not be claimed at all.
    _row(conn, "ECLI:C", "c", "CH_BGer", date(2020, 1, 1), "irrelevant text",
        stage="failed")

    report = citations_stage.run(settings)
    assert report.decisions == 2

    case_rows = conn.execute("SELECT * FROM ch_case_citations").fetchall()
    assert len(case_rows) == 1
    assert case_rows[0]["from_ecli"] == "ECLI:A"
    assert case_rows[0]["to_raw"] == "BGE 142 III 102"
    assert case_rows[0]["from_date"] == date(2020, 5, 1)
    # from_court is the fixture's court_code, not hardcoded.
    assert case_rows[0]["from_court"] == "CH_BGer"

    leg_rows = conn.execute(
        "SELECT * FROM ch_legislation_citations ORDER BY from_ecli").fetchall()
    assert len(leg_rows) == 2

    b_row = next(r for r in leg_rows if r["from_ecli"] == "ECLI:B")
    assert b_row["abbr_raw"] == "Cst."
    assert b_row["article"] == "8"
    # decision_date = 2021-01-01 is the source placeholder -> from_date NULL.
    assert b_row["from_date"] is None

    stamped = conn.execute(
        "SELECT ecli FROM ch_court_decisions "
        "WHERE ecli IN ('ECLI:A','ECLI:B') AND citations_extracted_at IS NOT NULL"
    ).fetchall()
    assert {r["ecli"] for r in stamped} == {"ECLI:A", "ECLI:B"}

    untouched = conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:C'"
    ).fetchone()
    assert untouched["citations_extracted_at"] is None

    second = citations_stage.run(settings)
    assert second.decisions == 0


def test_a_null_full_text_is_stamped_with_zero_edges_and_not_a_failure(conn, settings):
    _row(conn, "ECLI:D", "d", "CH_BGer", date(2020, 1, 1), None)

    report = citations_stage.run(settings)

    assert report.decisions == 1
    assert report.failed == 0
    assert report.case_refs == 0
    assert report.statute_refs == 0
    row = conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:D'"
    ).fetchone()
    assert row["citations_extracted_at"] is not None


def test_a_raising_extraction_is_counted_failed_and_left_unstamped(conn, settings,
                                                                   monkeypatch):
    """A bad text must not block the queue AND must not be retired from it:
    the row is counted in `failed` and logged, its stamp is left NULL so the
    next run tries again, and last_error is left exactly as it was, because
    this stage never writes it. The run itself is what keeps the unstamped
    row from being re-extracted forever -- it skips the eclis it already
    failed, so the decisions behind it still get scanned."""
    _row(conn, "ECLI:E", "e", "CH_BGer", date(2020, 1, 1), "boom text")
    _row(conn, "ECLI:F", "f", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")
    conn.execute(
        "UPDATE ch_court_decisions SET last_error = 'preexisting' WHERE ecli = 'ECLI:E'")

    real_extract_cases = citations_stage.citations.extract_cases

    def flaky(text):
        if text == "boom text":
            raise RuntimeError("simulated extraction failure")
        return real_extract_cases(text)

    monkeypatch.setattr(citations_stage.citations, "extract_cases", flaky)

    report = citations_stage.run(settings, limit=2)

    assert report.decisions == 2
    assert report.failed == 1

    row = conn.execute(
        "SELECT citations_extracted_at, last_error FROM ch_court_decisions "
        "WHERE ecli = 'ECLI:E'").fetchone()
    assert row["citations_extracted_at"] is None, "a failure must stay claimable"
    assert row["last_error"] == "preexisting"

    # The row that did not raise still got its citation written -- and its
    # stamp, so the failure did not drag it back into the queue.
    leg_rows = conn.execute(
        "SELECT * FROM ch_legislation_citations WHERE from_ecli = 'ECLI:F'").fetchall()
    assert len(leg_rows) == 1
    assert conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:F'"
    ).fetchone()["citations_extracted_at"] is not None

    # ... and the next run (a fixed extractor) picks the failure up again.
    monkeypatch.undo()
    retry = citations_stage.run(settings)
    assert retry.decisions == 1
    assert retry.failed == 0
    assert conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:E'"
    ).fetchone()["citations_extracted_at"] is not None


def test_a_re_extraction_that_raises_keeps_the_edges_the_old_text_produced(
        conn, settings, monkeypatch):
    """The destructive combination: a decision that already HAS edges is
    given new text (complete(-> 'extracted') clears its stamp), and the new
    text raises. Deleting the batch's edges before inserting the replacements
    would drop this decision's real citations with nothing to put back, and
    stamping it would mean it is never claimed again -- silent, permanent
    loss. The delete is therefore scoped to the decisions that extracted
    cleanly, and the failure is left exactly as it was."""
    _row(conn, "ECLI:M", "m", "CH_BGer", date(2020, 1, 1),
        "art. 8 Cst. und BGE 142 III 102")
    citations_stage.run(settings)
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:M'").fetchone()["n"] == 1

    db.complete(conn, "m", "extracted", full_text="boom text", text_quality=0.9)
    conn.execute("UPDATE ch_court_decisions SET stage = 'loaded' WHERE ecli = 'ECLI:M'")

    real_extract_cases = citations_stage.citations.extract_cases

    def flaky(text):
        if text == "boom text":
            raise RuntimeError("simulated extraction failure")
        return real_extract_cases(text)

    monkeypatch.setattr(citations_stage.citations, "extract_cases", flaky)

    # No limit: the claim query keeps offering the unstamped failure, so this
    # also pins the guard that stops the run from re-extracting it forever.
    report = citations_stage.run(settings)
    assert report.failed == 1

    assert [r["abbr_raw"] for r in conn.execute(
        "SELECT abbr_raw FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:M'").fetchall()] == ["Cst."]
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_case_citations "
        "WHERE from_ecli = 'ECLI:M'").fetchone()["n"] == 1
    assert conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:M'"
    ).fetchone()["citations_extracted_at"] is None


def test_the_batch_size_is_configurable(conn, settings, monkeypatch):
    """claim_for_citations() pulls full_text for the whole batch at once, so
    the batch size is the stage's memory knob -- CHPIPE_CIT_BATCH is how an
    operator turns it down on a host with long decisions and little RAM."""
    for ecli, doc_id in (("ECLI:N", "n"), ("ECLI:O", "o"), ("ECLI:P", "p")):
        _row(conn, ecli, doc_id, "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")

    limits: list[int] = []
    real_claim = citations_stage.db.claim_for_citations

    def spy(conn_, limit, spider=None):
        limits.append(limit)
        return real_claim(conn_, limit, spider=spider)

    monkeypatch.setattr(citations_stage.db, "claim_for_citations", spy)
    monkeypatch.setenv("CHPIPE_CIT_BATCH", "1")

    report = citations_stage.run(settings)

    assert report.decisions == 3
    assert set(limits) == {1}, limits
    assert len(limits) == 4          # three rows, then the empty claim


def test_a_bad_batch_size_falls_back_to_the_default(monkeypatch):
    monkeypatch.setenv("CHPIPE_CIT_BATCH", "not-a-number")
    assert citations_stage._batch_size() == citations_stage.BATCH_SIZE
    monkeypatch.setenv("CHPIPE_CIT_BATCH", "0")
    assert citations_stage._batch_size() == citations_stage.BATCH_SIZE
    monkeypatch.setenv("CHPIPE_CIT_BATCH", "7")
    assert citations_stage._batch_size() == 7


def test_a_spider_filter_only_claims_that_spider(conn, settings):
    _row(conn, "ECLI:G", "g", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
        spider="CH_BGer")
    _row(conn, "ECLI:H", "h", "CH_BVGer", date(2020, 1, 1), "art. 8 Cst.",
        spider="CH_BVGer")

    report = citations_stage.run(settings, spider="CH_BGer")

    assert report.decisions == 1
    row_g = conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:G'"
    ).fetchone()
    row_h = conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:H'"
    ).fetchone()
    assert row_g["citations_extracted_at"] is not None
    assert row_h["citations_extracted_at"] is None


def test_re_extraction_unstamps_a_decision_for_the_next_citations_run(conn, settings):
    """db.complete(..., 'extracted', ...) is the statement extract_stage and
    ocr_stage both use to write new full_text -- a decision that gets new
    text must be re-scanned for citations, not left stamped against the OLD
    text it was extracted from. citations_extracted_at must therefore go
    back to NULL whenever a row is completed into 'extracted', not just
    stay wherever the previous citations_stage run left it."""
    _row(conn, "ECLI:I", "i", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")

    first = citations_stage.run(settings)
    assert first.decisions == 1
    stamped = conn.execute(
        "SELECT citations_extracted_at FROM ch_court_decisions WHERE ecli = 'ECLI:I'"
    ).fetchone()
    assert stamped["citations_extracted_at"] is not None

    # A re-extraction with new text, exactly as extract_stage/ocr_stage write
    # it: db.complete(..., 'extracted', full_text=..., text_quality=...).
    db.complete(conn, "i", "extracted", full_text="art. 336 OR", text_quality=0.9)
    reextracted = conn.execute(
        "SELECT citations_extracted_at, stage FROM ch_court_decisions "
        "WHERE ecli = 'ECLI:I'").fetchone()
    assert reextracted["citations_extracted_at"] is None
    assert reextracted["stage"] == "extracted"

    # load_stage is what would move it back to 'loaded' in the real
    # pipeline; done directly here since this test is about
    # citations_stage's own claim query, not load's.
    conn.execute("UPDATE ch_court_decisions SET stage = 'loaded' WHERE ecli = 'ECLI:I'")

    second = citations_stage.run(settings)
    assert second.decisions == 1
    # The re-scan is over the NEW text ("art. 336 OR"), so "OR" must show up
    # -- and the "Cst." row from the first pass must NOT: it was extracted
    # from text this decision no longer has.
    leg_abbrs = {r["abbr_raw"] for r in conn.execute(
        "SELECT abbr_raw FROM ch_legislation_citations WHERE from_ecli = 'ECLI:I'"
    ).fetchall()}
    assert leg_abbrs == {"OR"}


def test_re_extraction_removes_the_edges_the_old_text_produced(conn, settings):
    """A re-extraction replaces a decision's edges, it does not add to them.
    ON CONFLICT DO NOTHING makes re-inserting the SAME edge harmless, but an
    edge the new text no longer contains has nothing to collide with -- left
    alone it survives forever, and the graph keeps serving a citation the
    decision does not make."""
    _row(conn, "ECLI:J", "j", "CH_BGer", date(2020, 1, 1),
        "art. 8 Cst. und BGE 142 III 102")

    citations_stage.run(settings)
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:J'").fetchone()["n"] == 1
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_case_citations "
        "WHERE from_ecli = 'ECLI:J'").fetchone()["n"] == 1

    # New text, with neither of the two references the first one carried.
    db.complete(conn, "j", "extracted", full_text="art. 336 OR", text_quality=0.9)
    conn.execute("UPDATE ch_court_decisions SET stage = 'loaded' WHERE ecli = 'ECLI:J'")

    citations_stage.run(settings)

    leg = conn.execute(
        "SELECT abbr_raw FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:J'").fetchall()
    assert [r["abbr_raw"] for r in leg] == ["OR"], "the Cst. edge is gone"
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_case_citations "
        "WHERE from_ecli = 'ECLI:J'").fetchone()["n"] == 0, "the BGE edge is gone"


def test_a_decision_whose_edges_are_deleted_does_not_touch_another_decisions(
        conn, settings):
    """The delete is scoped to the batch's own from_ecli values -- a
    re-extracted decision must not take another decision's edges with it."""
    _row(conn, "ECLI:K", "k", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")
    _row(conn, "ECLI:L", "l", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")

    citations_stage.run(settings)
    db.complete(conn, "k", "extracted", full_text="art. 336 OR", text_quality=0.9)
    conn.execute("UPDATE ch_court_decisions SET stage = 'loaded' WHERE ecli = 'ECLI:K'")

    citations_stage.run(settings)

    assert conn.execute(
        "SELECT abbr_raw FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:L'").fetchone()["abbr_raw"] == "Cst."
