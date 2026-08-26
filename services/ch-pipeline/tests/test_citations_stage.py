"""citations_stage: runs chpipe.citations over `loaded` decisions and writes
raw edges into ch_case_citations / ch_legislation_citations. A mocked DB
cannot validate the executemany/ON CONFLICT DO NOTHING SQL, so this is a
scratch-database test like test_load_stage.py and test_migration_200.py.
The queue itself is ch_citation_state (migration 200): nothing in this
stage writes ch_court_decisions, and one of the tests below measures that.
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

from conftest import apply_migration_200

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
        # not create) and migrations 199 + 200 -- see tests/conftest.py.
        # 200 is what creates ch_citation_state, which db.complete() writes
        # to on every 'extracted' and 'loaded' transition.
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        yield c


def _row(conn, ecli, doc_id, court_code, decision_date, text, stage="loaded",
        spider="CH_BGer", docket_number=None):
    """A decision as the pipeline leaves it, queue row included.

    The queue is ch_citation_state (migration 200), not a column on the
    decision: a decision reaches it through db.complete(-> 'loaded'), and a
    row inserted straight into ch_court_decisions the way this helper does
    would otherwise be invisible to the claim. Enrolling every row -- not
    just the 'loaded' ones -- is deliberate: the claim's stage predicate is
    what has to keep a 'failed' decision out, and a helper that quietly
    withheld the queue row would hide a broken predicate.
    """
    conn.execute(
        "INSERT INTO ch_court_decisions "
        "(ecli, spider, doc_id, court_code, decision_date, full_text, stage, docket_number) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        (ecli, spider, doc_id, court_code, decision_date, text, stage, docket_number))
    db.ensure_citation_state(conn, [ecli])


def _state(conn, ecli):
    """The decision's row in the citation queue, or None."""
    return conn.execute(
        "SELECT * FROM ch_citation_state WHERE ecli = %s", (ecli,)).fetchone()


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
        "SELECT ecli FROM ch_citation_state "
        "WHERE ecli IN ('ECLI:A','ECLI:B') AND extracted_at IS NOT NULL"
    ).fetchall()
    assert {r["ecli"] for r in stamped} == {"ECLI:A", "ECLI:B"}

    assert _state(conn, "ECLI:C")["extracted_at"] is None

    second = citations_stage.run(settings)
    assert second.decisions == 0


def test_a_null_full_text_is_stamped_with_zero_edges_and_not_a_failure(conn, settings):
    _row(conn, "ECLI:D", "d", "CH_BGer", date(2020, 1, 1), None)

    report = citations_stage.run(settings)

    assert report.decisions == 1
    assert report.failed == 0
    assert report.case_refs == 0
    assert report.statute_refs == 0
    assert _state(conn, "ECLI:D")["extracted_at"] is not None


def test_a_raising_extraction_is_counted_failed_and_left_unstamped(conn, settings,
                                                                   monkeypatch):
    """A bad text must not block the queue AND must not be retired from it
    while it still has attempts left: the row is counted in `failed` and
    logged, its stamp is left NULL so the next run tries again, one attempt
    is spent on its ch_citation_state row, and ch_court_decisions.last_error
    is left exactly as it was, because this stage never writes that table. The run itself is what keeps the unstamped
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
        "SELECT last_error FROM ch_court_decisions WHERE ecli = 'ECLI:E'").fetchone()
    assert row["last_error"] == "preexisting", \
        "ch_court_decisions.last_error belongs to the stage queue, not to this stage"
    state = _state(conn, "ECLI:E")
    assert state["extracted_at"] is None, "a failure must stay claimable"
    assert state["attempts"] == 1, "a failure spends one of its attempts"
    assert "simulated extraction failure" in state["last_error"]

    # The row that did not raise still got its citation written -- and its
    # stamp, so the failure did not drag it back into the queue.
    leg_rows = conn.execute(
        "SELECT * FROM ch_legislation_citations WHERE from_ecli = 'ECLI:F'").fetchall()
    assert len(leg_rows) == 1
    assert _state(conn, "ECLI:F")["extracted_at"] is not None

    # ... and the next run (a fixed extractor) picks the failure up again.
    monkeypatch.undo()
    retry = citations_stage.run(settings)
    assert retry.decisions == 1
    assert retry.failed == 0
    retried = _state(conn, "ECLI:E")
    assert retried["extracted_at"] is not None
    assert retried["last_error"] is None, "a success clears the failure it replaces"


def test_a_re_extraction_that_raises_keeps_the_edges_the_old_text_produced(
        conn, settings, monkeypatch):
    """The destructive combination: a decision that already HAS edges is
    given new text (complete(-> 'extracted') re-queues it), and the new
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
    assert _state(conn, "ECLI:M")["extracted_at"] is None


def test_the_batch_size_is_configurable(conn, settings, monkeypatch):
    """claim_for_citations() pulls full_text for the whole batch at once, so
    the batch size is the stage's memory knob -- CHPIPE_CIT_BATCH is how an
    operator turns it down on a host with long decisions and little RAM."""
    for ecli, doc_id in (("ECLI:N", "n"), ("ECLI:O", "o"), ("ECLI:P", "p")):
        _row(conn, ecli, doc_id, "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")

    limits: list[int] = []
    real_claim = citations_stage.db.claim_for_citations

    def spy(conn_, limit, spider=None, max_attempts=3):
        limits.append(limit)
        return real_claim(conn_, limit, spider=spider, max_attempts=max_attempts)

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
    assert _state(conn, "ECLI:G")["extracted_at"] is not None
    assert _state(conn, "ECLI:H")["extracted_at"] is None


def test_re_extraction_unstamps_a_decision_for_the_next_citations_run(conn, settings):
    """db.complete(..., 'extracted', ...) is the statement extract_stage and
    ocr_stage both use to write new full_text -- a decision that gets new
    text must be re-scanned for citations, not left stamped against the OLD
    text it was extracted from. The decision's ch_citation_state row must
    therefore go back to extracted_at IS NULL whenever a row is completed
    into 'extracted', not just stay wherever the previous citations_stage
    run left it."""
    _row(conn, "ECLI:I", "i", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")

    first = citations_stage.run(settings)
    assert first.decisions == 1
    assert _state(conn, "ECLI:I")["extracted_at"] is not None

    # A re-extraction with new text, exactly as extract_stage/ocr_stage write
    # it: db.complete(..., 'extracted', full_text=..., text_quality=...).
    db.complete(conn, "i", "extracted", full_text="art. 336 OR", text_quality=0.9)
    assert _state(conn, "ECLI:I")["extracted_at"] is None
    assert conn.execute(
        "SELECT stage FROM ch_court_decisions WHERE ecli = 'ECLI:I'"
    ).fetchone()["stage"] == "extracted"

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


def test_a_row_that_reaches_loaded_is_enrolled_in_the_queue(conn, settings):
    """The queue is a side table, so a decision has to be PUT there. Nothing
    else does it: db.complete(-> 'loaded') -- the statement load_stage
    promotes with -- ensures the state row, and without it every decision
    loaded after migration 200's one-time seed would be invisible to the
    claim forever, with no symptom other than a citation graph that quietly
    stopped growing."""
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, doc_id, stage, full_text) "
        "VALUES ('ECLI:Q', 'CH_BGer', 'q', 'extracted', 'art. 8 Cst.')")
    assert _state(conn, "ECLI:Q") is None

    db.complete(conn, "q", "loaded")

    state = _state(conn, "ECLI:Q")
    assert state is not None and state["extracted_at"] is None
    # ... with the spider copied off the decision, so a per-spider claim
    # never has to reach into ch_court_decisions to know what to skip.
    assert state["spider"] == "CH_BGer"
    assert citations_stage.run(settings).decisions == 1
    assert _state(conn, "ECLI:Q")["extracted_at"] is not None


def test_promoting_an_already_stamped_row_to_loaded_does_not_re_queue_it(conn, settings):
    """The 'loaded' branch is absent-only. A decision that goes round the
    loop again (load promotes a row that has been through here before)
    already has its state row -- re-queueing it there would undo a stamp
    that is still valid, and re-extract text nothing has changed."""
    _row(conn, "ECLI:R", "r", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")
    citations_stage.run(settings)
    stamped_at = _state(conn, "ECLI:R")["extracted_at"]
    assert stamped_at is not None

    conn.execute("UPDATE ch_court_decisions SET stage = 'extracted' WHERE doc_id = 'r'")
    db.complete(conn, "r", "loaded")

    assert _state(conn, "ECLI:R")["extracted_at"] == stamped_at
    assert citations_stage.run(settings).decisions == 0


def test_new_text_re_queues_a_decision_and_clears_its_failed_attempts(conn, settings):
    """db.complete(-> 'extracted') is the only path that un-stamps. It also
    resets the attempt counter, for the same reason complete() resets the
    stage retry budget: the attempts were spent on text this decision no
    longer has, and carrying them over would retire a decision from the
    citation queue for the sins of a document it has replaced."""
    _row(conn, "ECLI:S", "s", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")
    conn.execute(
        "UPDATE ch_citation_state SET extracted_at = now(), attempts = 3, "
        "last_error = 'old boom' WHERE ecli = 'ECLI:S'")

    db.complete(conn, "s", "extracted", full_text="art. 336 OR", text_quality=0.9)

    state = _state(conn, "ECLI:S")
    assert state["extracted_at"] is None
    assert state["attempts"] == 0
    assert state["last_error"] is None
    assert state["spider"] == "CH_BGer"


def test_a_decision_out_of_attempts_is_no_longer_claimed(conn, settings):
    """The attempt counter the column-flag queue could not afford. A text
    that raises every time is retired from the queue after max_attempts
    instead of being re-read (and re-logged) on every run forever -- and the
    decisions behind it are unaffected."""
    _row(conn, "ECLI:T", "t", "CH_BGer", date(2020, 1, 1), "boom text")
    _row(conn, "ECLI:U", "u", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.")

    real_extract_cases = citations_stage.citations.extract_cases

    def flaky(text):
        if text == "boom text":
            raise RuntimeError("simulated extraction failure")
        return real_extract_cases(text)

    # settings.max_attempts is 3, so three runs spend the whole budget.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(citations_stage.citations, "extract_cases", flaky)
        for expected_attempts in (1, 2, 3):
            citations_stage.run(settings)
            assert _state(conn, "ECLI:T")["attempts"] == expected_attempts

        # The fourth run does not claim it at all: `failed` stays 0 and the
        # counter does not move.
        report = citations_stage.run(settings)
        assert report.decisions == 0
        assert report.failed == 0
        assert _state(conn, "ECLI:T")["attempts"] == 3

    # The decision behind it was extracted on the very first run.
    assert _state(conn, "ECLI:U")["extracted_at"] is not None


def test_a_run_never_writes_to_ch_court_decisions(conn, settings):
    """The whole point of migration 200. ch_court_decisions is 19 GB with a
    7.6 GB full-text GIN: a stamp stored on it is a non-HOT row rewrite into
    every one of those indexes (measured on prod 2026-08-25: a 1.22M-row
    reset ran 22+ minutes and grew the GIN 0.6 GB in a day). This stage must
    therefore only ever READ that table.

    Measured with xmin, not pg_stat_user_tables.n_tup_upd: xmin is the row's
    own inserting transaction id and changes on any UPDATE, immediately and
    per row, whereas the statistics counters land asynchronously and would
    make this assertion a race. A failed extraction is included on purpose --
    that is the path that used to leave last_error behind."""
    _row(conn, "ECLI:V", "v", "CH_BGer", date(2020, 1, 1),
         "art. 8 Cst. und BGE 142 III 102")
    _row(conn, "ECLI:W", "w", "CH_BGer", date(2020, 1, 1), "boom text")

    def xmins():
        return {r["ecli"]: r["xmin"] for r in conn.execute(
            "SELECT ecli, xmin::text AS xmin FROM ch_court_decisions "
            "ORDER BY ecli").fetchall()}

    before = xmins()
    assert len(before) == 2

    real_extract_cases = citations_stage.citations.extract_cases

    def flaky(text):
        if text == "boom text":
            raise RuntimeError("simulated extraction failure")
        return real_extract_cases(text)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(citations_stage.citations, "extract_cases", flaky)
        report = citations_stage.run(settings)

    assert report.decisions == 2 and report.failed == 1
    assert xmins() == before, "citations_stage wrote to ch_court_decisions"
    # ... and it did do its work, on its own table.
    assert _state(conn, "ECLI:V")["extracted_at"] is not None
    assert _state(conn, "ECLI:W")["attempts"] == 1


def test_the_claim_is_ordered_by_ecli_not_by_spider_and_doc_id(conn, settings):
    """Measured by review on a 200k-row backlog: ORDER BY d.spider, d.doc_id
    costs a hash join plus an external sort -- 255 ms per 200-row claim, and
    it materialises full_text for EVERY pending row to sort them. The
    (spider, doc_id) partial index that used to make that ordering cheap was
    on ch_court_decisions and went with migration 200. ch_citation_state's
    primary key is the ecli, so ordering by it is an index scan into a nested
    loop: 0.8 ms for the same claim.

    The order itself is arbitrary -- the queue has no priority, it only needs
    to be stable so a claim that is skipped is not re-offered ahead of
    everything else forever. This fixture's two rows sort in OPPOSITE
    directions under the two orderings, so a limit of 1 tells them apart.
    """
    _row(conn, "ECLI:AA", "zzz", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="Z_last")
    _row(conn, "ECLI:ZZ", "aaa", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="A_first")

    rows = db.claim_for_citations(conn, 1)
    assert [r["ecli"] for r in rows] == ["ECLI:AA"]

    assert [r["ecli"] for r in db.claim_for_citations(conn, 10)] == \
        ["ECLI:AA", "ECLI:ZZ"]


def test_the_spider_filter_still_applies_under_the_ecli_order(conn, settings):
    """The filter is on the JOINED table (d.spider) while the order is on the
    state table -- the combination a planner change could quietly break."""
    _row(conn, "ECLI:AA", "zzz", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="Z_last")
    _row(conn, "ECLI:ZZ", "aaa", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="A_first")

    assert [r["ecli"] for r in db.claim_for_citations(conn, 10, spider="A_first")] \
        == ["ECLI:ZZ"]
    assert [r["ecli"] for r in db.claim_for_citations(conn, 10, spider="Z_last")] \
        == ["ECLI:AA"]


def test_the_spider_filter_reads_the_state_row_not_the_decision(conn, settings):
    """The predicate is s.spider, and it has to be: filtering on d.spider
    means every pending row in the backlog is read and joined before it can
    be discarded, which is what makes a per-spider claim scan the whole
    mixed queue. s.spider is the leading column of
    idx_ch_citation_state_pending_spider, so the claim seeks straight to
    that spider's pending rows.

    The two columns cannot disagree in the pipeline -- every writer copies
    the spider off the decision row. They are forced apart here for one
    reason: it is the only way to say WHICH of the two the claim reads.
    """
    _row(conn, "ECLI:AA", "aaa", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="A_first")
    conn.execute(
        "UPDATE ch_citation_state SET spider = 'Z_last' WHERE ecli = 'ECLI:AA'")

    assert db.claim_for_citations(conn, 10, spider="A_first") == []
    assert [r["ecli"] for r in db.claim_for_citations(conn, 10, spider="Z_last")] \
        == ["ECLI:AA"]


def test_a_per_spider_claim_returns_only_that_spiders_pending_rows(conn, settings):
    """The ordinary case, over a mixed backlog: three spiders pending, one
    asked for."""
    _row(conn, "ECLI:1", "d1", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="CH_BGer")
    _row(conn, "ECLI:2", "d2", "CH_BVGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="CH_BVGer")
    _row(conn, "ECLI:3", "d3", "CH_BGer", date(2020, 1, 1), "art. 8 Cst.",
         spider="CH_BGer")
    _row(conn, "ECLI:4", "d4", "ZG_Obergericht", date(2020, 1, 1), "art. 8 Cst.",
         spider="ZG_Obergericht")

    claimed = db.claim_for_citations(conn, 10, spider="CH_BGer")
    assert [r["ecli"] for r in claimed] == ["ECLI:1", "ECLI:3"]
    assert {r["spider"] for r in claimed} == {"CH_BGer"}

    # ... and the stage leaves the other spiders' rows queued.
    citations_stage.run(settings, spider="CH_BGer")
    still_pending = {r["ecli"] for r in conn.execute(
        "SELECT ecli FROM ch_citation_state WHERE extracted_at IS NULL").fetchall()}
    assert still_pending == {"ECLI:2", "ECLI:4"}
