"""Discovery of consolidated editions into ch_act_version.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_versions_stage.py
"""
import os
import pathlib
import psycopg
import pytest
from chpipe import fedlex_queries as fq
from chpipe.stages import acts_stage, versions_stage
from chpipe.config import Settings

from conftest import reset_legislation_schema

# Derive repo root from this file's location: services/ch-pipeline/tests/test_versions_stage.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent

L = "http://publications.europa.eu/resource/authority/language/"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        # reset_legislation_schema (conftest.py) applies 197, 198, 201 and
        # 204 -- the source column and its widened CHECK (fedlex_pdf
        # included) live in 201/204, and the pdf-a discovery tests below
        # need both.
        reset_legislation_schema(c)
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


@pytest.fixture
def settings():
    return Settings(
        dsn=os.environ["CHPIPE_TEST_DSN"],
        raw_dir=pathlib.Path("/tmp/chpipe-versions-test"),
        http_concurrency=1,
        cpu_workers=1,
        ocr_workers=1,
        load_ceiling=6.0,
        max_attempts=3,
    )


def _row(date="2026-01-01", lang="DEU", end=None, work=WORK):
    return {
        "work": work,
        "consolidation": f"{work}/{date.replace('-', '')}",
        "dateApplicability": date,
        "dateEndApplicability": end,
        "lang": L + lang,
        "fileUrl": ("https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/"
                    f"eli/cc/27/317_321_377/{date.replace('-', '')}/de/xml/x.xml"),
    }


class _FakeSparqlClient:
    """Stands in for chpipe.sparql.SparqlClient so run() can be exercised
    without ever touching the live Fedlex endpoint. batched() records the
    driving set it was handed -- which is the thing under test, since the
    walk is now driven by ch_act rather than by an offset -- and replays the
    rows it was built with.

    run() now issues two passes over the same driving set, fq.VERSIONS then
    fq.VERSIONS_PDF (see versions_stage.run()) -- batched() dispatches on
    `query_template is fq.VERSIONS_PDF` so the two passes can be fed
    different rows (`rows` for the xml pass, `pdf_rows` for the pdf pass,
    empty by default so every pre-existing single-pass test keeps its old
    behaviour unchanged). Every call is recorded separately in `self.calls`
    (query_template, batches) -- collapsing both calls into one shared
    `self.batches` used to mean an xml-pass assertion silently started
    reading the pdf pass's batching instead (they happen to come out
    structurally identical, since both passes are driven by the same works
    list and batch_size, but that is an accident of these tests' inputs, not
    something the fake should rely on). `xml_batches`/`pdf_batches` name the
    call each assertion actually means."""

    def __init__(self, rows, pdf_rows=None):
        self._rows = rows
        self._pdf_rows = pdf_rows if pdf_rows is not None else []
        self.closed = False
        self.calls: list[tuple[str, list[list[str]]]] = []

    def batched(self, query_template, uris, batch_size=20):
        batches: list[list[str]] = []
        batch: list[str] = []
        for uri in uris:
            batch.append(uri)
            if len(batch) >= batch_size:
                batches.append(batch)
                batch = []
        if batch:
            batches.append(batch)
        self.calls.append((query_template, batches))
        if not batches:
            return
        rows = self._pdf_rows if query_template is fq.VERSIONS_PDF else self._rows
        yield from rows

    def _batches_for(self, query_template) -> list[list[str]]:
        for template, batches in self.calls:
            if template is query_template:
                return batches
        return []

    @property
    def xml_batches(self) -> list[list[str]]:
        return self._batches_for(fq.VERSIONS)

    @property
    def pdf_batches(self) -> list[list[str]]:
        return self._batches_for(fq.VERSIONS_PDF)

    def close(self):
        self.closed = True


def _run_with_rows(monkeypatch, settings, rows, capture=None, pdf_rows=None):
    fake = _FakeSparqlClient(rows, pdf_rows=pdf_rows)
    if capture is not None:
        capture.append(fake)
    monkeypatch.setattr(versions_stage, "SparqlClient", lambda endpoint: fake)
    return versions_stage.run(settings)


def test_stores_a_version_against_its_act(conn):
    vid = versions_stage.upsert_version(conn, _row())
    row = conn.execute(
        "SELECT v.date_applicability, v.lang, v.xml_url, a.sr_number "
        "FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE v.version_id = %s", (vid,)).fetchone()
    assert str(row[0]) == "2026-01-01"
    assert row[1] == "de"
    assert row[2].endswith(".xml")
    assert row[3] == "220"


def test_an_act_can_hold_many_versions(conn):
    for d in ("2020-01-01", "2022-01-01", "2026-01-01"):
        versions_stage.upsert_version(conn, _row(date=d))
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 3


def test_the_same_consolidation_in_three_languages_is_three_rows(conn):
    for lang in ("DEU", "FRA", "ITA"):
        versions_stage.upsert_version(conn, _row(lang=lang))
    langs = {r[0] for r in conn.execute("SELECT lang FROM ch_act_version").fetchall()}
    assert langs == {"de", "fr", "it"}


def test_duplicate_rows_from_named_graphs_collapse(conn):
    """Fedlex returns the same consolidation from several graphs; the second
    write must update, not duplicate."""
    first = versions_stage.upsert_version(conn, _row())
    second = versions_stage.upsert_version(conn, _row())
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 1


def test_end_of_applicability_is_kept_when_present(conn):
    vid = versions_stage.upsert_version(conn, _row(date="2020-01-01", end="2021-12-31"))
    assert str(conn.execute(
        "SELECT date_end_applicability FROM ch_act_version WHERE version_id=%s",
        (vid,)).fetchone()[0]) == "2021-12-31"


def test_a_version_whose_work_was_never_discovered_is_reported_not_inserted(conn):
    row = _row()
    row["work"] = "https://fedlex.data.admin.ch/eli/cc/never/seen"
    assert versions_stage.upsert_version(conn, row) is None
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 0


def test_a_language_we_do_not_map_is_skipped(conn):
    row = _row()
    row["lang"] = "http://example/klingon"
    assert versions_stage.upsert_version(conn, row) is None


def test_new_versions_start_at_stage_discovered(conn):
    vid = versions_stage.upsert_version(conn, _row())
    assert conn.execute(
        "SELECT stage FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()[0] \
        == "discovered"


# --- run(): loud orphan / skipped-language reporting, and the per-item guard ---

def test_run_counts_discovered_and_fills_by_lang(conn, settings, monkeypatch):
    rows = [_row(lang="DEU"), _row(lang="FRA"), _row(lang="ITA")]
    report = _run_with_rows(monkeypatch, settings, rows)
    assert report.discovered == 3
    assert report.by_lang == {"de": 1, "fr": 1, "it": 1}
    assert report.orphaned == 0
    assert report.skipped_language == 0


def test_run_reports_orphans_loudly_with_a_capped_sample(conn, settings, monkeypatch):
    """An orphan count sitting quietly in a dataclass nobody reads is not a
    signal. run() must both count every orphan and name a sample of the
    distinct work URIs, without accumulating all 56,000 possible offenders
    in memory."""
    never_seen = [f"https://fedlex.data.admin.ch/eli/cc/never/seen-{i}"
                  for i in range(20)]
    rows = [_row(work=w) for w in never_seen]
    report = _run_with_rows(monkeypatch, settings, rows)
    assert report.discovered == 0
    assert report.orphaned == 20
    # Every orphan is counted, but only a small, capped sample is named.
    assert len(report.orphaned_works) <= 12
    assert len(report.orphaned_works) == len(set(report.orphaned_works))
    assert set(report.orphaned_works) <= set(never_seen)


def test_run_reports_skipped_languages_loudly(conn, settings, monkeypatch):
    """A language Fedlex serves that we do not map is a decision, not an
    accident -- it must be visible in the report, not just swallowed."""
    row = _row()
    row["lang"] = "http://example/klingon"
    report = _run_with_rows(monkeypatch, settings, [row])
    assert report.skipped_language == 1
    assert "http://example/klingon" in report.skipped_langs
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 0


def test_run_does_not_abort_on_one_bad_row(conn, settings, monkeypatch):
    """One malformed binding (a missing key, a write error) must not abort a
    walk of tens of thousands of rows. Every stage in the sibling decisions
    pipeline had this defect found in review; this stage guards the same
    way acts_stage.run() does: log the item, count it, continue."""
    bad = _row()
    del bad["dateApplicability"]          # KeyError inside upsert_version
    good = _row(date="2020-06-01")
    report = _run_with_rows(monkeypatch, settings, [bad, good])
    assert report.errors == 1
    assert report.discovered == 1
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 1


def test_run_closes_the_client_even_after_a_bad_row(conn, settings, monkeypatch):
    bad = _row()
    del bad["dateApplicability"]
    fake = _FakeSparqlClient([bad])
    monkeypatch.setattr(versions_stage, "SparqlClient", lambda endpoint: fake)
    versions_stage.run(settings)
    assert fake.closed is True


# --- the driving set: batches of works read from ch_act, never an offset ---

def test_run_is_driven_by_the_works_in_ch_act(conn, settings, monkeypatch):
    """The whole point of the fix. An offset walk of the tens of thousands of
    version rows dies on Virtuoso's SR353 ceiling at row 10,001; this walk asks
    only for the editions of works ch_act already holds, a batch at a time."""
    for i in range(45):
        acts_stage.upsert_act(conn, {"work": f"https://fedlex.data.admin.ch/eli/cc/x/{i:03d}"})
    seen: list = []
    _run_with_rows(monkeypatch, settings, [], capture=seen)
    fake = seen[0]

    driven = [u for b in fake.xml_batches for u in b]
    stored = [r[0] for r in conn.execute(
        "SELECT eli_work_uri FROM ch_act ORDER BY eli_work_uri").fetchall()]
    assert driven == stored, "every discovered work must drive the walk, in order"
    assert len(fake.xml_batches) == 3, "46 works in batches of 20 is three batches"
    assert [len(b) for b in fake.xml_batches] == [20, 20, 6]


def test_run_uses_the_measured_batch_size_by_default(conn, settings, monkeypatch):
    """20 is not arbitrary. Measured through the shipped queries (with their
    SELECT DISTINCT), the twenty heaviest works in the corpus return 2,461
    version rows and 100 title rows -- a 4x margin under Virtuoso's 10,000-row
    ceiling. VERSIONS is the constraint; TITLES tops out at five rows per work
    because exactly five languages exist."""
    from chpipe import fedlex_queries as fq
    for i in range(25):
        acts_stage.upsert_act(conn, {"work": f"https://fedlex.data.admin.ch/eli/cc/y/{i:03d}"})
    seen: list = []
    _run_with_rows(monkeypatch, settings, [], capture=seen)
    assert [len(b) for b in seen[0].xml_batches] == [fq.WORK_BATCH_SIZE, 6]


def test_run_asks_fedlex_nothing_when_ch_act_is_empty(conn, settings, monkeypatch):
    """An empty driving set must mean no queries at all, not a blind walk of
    the whole graph. Run the acts stage first."""
    conn.execute("DELETE FROM ch_act")
    seen: list = []
    report = _run_with_rows(monkeypatch, settings, [_row()], capture=seen)
    assert seen[0].xml_batches == []
    assert seen[0].pdf_batches == []
    assert report.discovered == 0


def test_the_module_does_not_claim_to_be_resumable():
    """_SELECT_WORKS reads all of ch_act with no filter for works already
    walked, and keyset() always starts from the beginning, so nothing here
    resumes. Saying 'resumable act by act' described behaviour the code does
    not have."""
    doc = versions_stage.__doc__ or ""
    assert "resumable act by act" not in doc
    assert "restartable and idempotent" in doc.lower()
    assert "NOT resumable" in doc
    run_doc = versions_stage.run.__doc__ or ""
    assert "Restartable and idempotent rather than resumable" in run_doc


def test_the_titles_pass_documents_that_it_cannot_be_resumed_at_all():
    """The weaker half: acts_stage accumulates its title work set in memory
    during the acts walk, so an interruption before the titles pass loses it
    with nothing on disk to resume from. That has to be written down."""
    doc = acts_stage.run.__doc__ or ""
    assert "in memory" in doc and "loses that pass entirely" in doc


def test_the_walk_restarts_from_the_beginning_rather_than_resuming(conn, settings,
                                                                   monkeypatch):
    """The docstring says restartable, not resumable, and this pins it: the
    driving set is read unconditionally, so a second run re-walks every work
    rather than picking up after the last one. That is intended -- a work's
    edition set can change between runs -- and the upserts make it safe."""
    for i in range(3):
        acts_stage.upsert_act(conn, {"work": f"https://fedlex.data.admin.ch/eli/cc/r/{i}"})
    first: list = []
    _run_with_rows(monkeypatch, settings, [], capture=first)
    second: list = []
    _run_with_rows(monkeypatch, settings, [], capture=second)
    assert first[0].xml_batches == second[0].xml_batches, \
        "a re-run must redo the whole pass, not resume past what it already walked"


def test_work_uris_returns_the_driving_set_in_a_stable_order(conn):
    for w in ("https://fedlex.data.admin.ch/eli/cc/b/1",
              "https://fedlex.data.admin.ch/eli/cc/a/1"):
        acts_stage.upsert_act(conn, {"work": w})
    uris = versions_stage.work_uris(conn)
    assert uris == sorted(uris)
    assert "https://fedlex.data.admin.ch/eli/cc/a/1" in uris


# --- pdf-a discovery: upsert_pdf_version() -- source='fedlex_pdf' ONLY
# where no XML edition already covers the same (consolidation, lang) ---

def _pdf_row(date="2026-01-01", lang="DEU", end=None, work=WORK):
    """Same shape VERSIONS_PDF returns -- identical fields to _row(), just a
    pdf-a fileUrl so a test reading xml_url back can tell the two apart."""
    row = _row(date=date, lang=lang, end=end, work=work)
    row["fileUrl"] = ("https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/"
                      f"eli/cc/27/317_321_377/{date.replace('-', '')}/de/pdf-a/x.pdf")
    return row


def test_pdf_row_is_skipped_when_an_xml_row_already_covers_the_edition(conn):
    """The whole point of the ordering: an edition available in both formats
    must land as XML, never as pdf-a -- and the existing XML row must be
    completely untouched by the pdf pass."""
    versions_stage.upsert_version(conn, _row())
    outcome = versions_stage.upsert_pdf_version(conn, _pdf_row())
    assert outcome == "skipped_has_xml"
    row = conn.execute(
        "SELECT source, xml_url FROM ch_act_version "
        "WHERE eli_consolidation_uri = %s AND lang = 'de'",
        (_row()["consolidation"],)).fetchone()
    assert row[0] == "fedlex"
    assert row[1].endswith(".xml")
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 1


def test_new_pdf_row_is_inserted_as_fedlex_pdf_discovered(conn):
    pdf_row = _pdf_row()
    outcome = versions_stage.upsert_pdf_version(conn, pdf_row)
    assert outcome == "upserted"
    row = conn.execute(
        "SELECT source, stage, xml_url FROM ch_act_version "
        "WHERE eli_consolidation_uri = %s AND lang = 'de'",
        (pdf_row["consolidation"],)).fetchone()
    assert row[0] == "fedlex_pdf"
    assert row[1] == "discovered"
    assert row[2] == pdf_row["fileUrl"]


def test_rewalk_of_a_pdf_row_updates_dates_with_coalesce_semantics(conn):
    pdf_row = _pdf_row(date="2020-01-01")
    assert versions_stage.upsert_pdf_version(conn, pdf_row) == "upserted"
    pdf_row_with_end = _pdf_row(date="2020-01-01", end="2022-12-31")
    outcome = versions_stage.upsert_pdf_version(conn, pdf_row_with_end)
    assert outcome == "upserted"
    end = conn.execute(
        "SELECT date_end_applicability FROM ch_act_version "
        "WHERE eli_consolidation_uri = %s AND lang = 'de'",
        (pdf_row["consolidation"],)).fetchone()[0]
    assert str(end) == "2022-12-31"


def test_pdf_row_whose_work_was_never_discovered_is_orphaned(conn):
    pdf_row = _pdf_row(work="https://fedlex.data.admin.ch/eli/cc/never/seen")
    assert versions_stage.upsert_pdf_version(conn, pdf_row) == "orphaned"
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 0


def test_migration_204_lets_a_fedlex_pdf_row_pass_the_source_check(conn):
    """conftest's reset_legislation_schema now applies 204: the widened
    CHECK constraint must accept source='fedlex_pdf' directly, not just
    through upsert_pdf_version()'s own SQL."""
    conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
        "date_applicability, xml_url, source) "
        "SELECT act_id, 'https://x/pdf-check', 'de', '2020-01-01', "
        "'https://x/pdf-check.pdf', 'fedlex_pdf' FROM ch_act WHERE eli_work_uri = %s",
        (WORK,))
    assert conn.execute(
        "SELECT source FROM ch_act_version WHERE eli_consolidation_uri = "
        "'https://x/pdf-check'").fetchone()[0] == "fedlex_pdf"


# --- run(): the pdf pass, after the xml pass, over the same works ---

def test_run_second_pass_discovers_pdf_only_editions(conn, settings, monkeypatch):
    """No XML edition for this consolidation (the xml query returns
    nothing), one pdf-a edition -- run()'s pdf pass must land it as
    source='fedlex_pdf'."""
    pdf_row = _pdf_row()
    report = _run_with_rows(monkeypatch, settings, rows=[], pdf_rows=[pdf_row])
    assert report.discovered == 0
    assert report.pdf_discovered == 1
    assert report.pdf_skipped_has_xml == 0
    # pdf-a editions are editions -- by_lang must count them too, not just
    # the xml pass's rows.
    assert report.by_lang == {"de": 1}
    row = conn.execute(
        "SELECT source FROM ch_act_version WHERE eli_consolidation_uri = %s",
        (pdf_row["consolidation"],)).fetchone()
    assert row[0] == "fedlex_pdf"


def test_run_pdf_pass_skips_editions_the_xml_pass_already_covered(conn, settings,
                                                                   monkeypatch):
    """The order-of-passes contract this task exists for: a consolidation
    with both an XML and a pdf-a manifestation must land as XML only. The
    fake SPARQL client feeds run() the same consolidation from both queries
    -- the xml pass runs first (discovering it), so the pdf pass must find
    an XML row already there and skip."""
    row = _row()
    pdf_row = _pdf_row()
    report = _run_with_rows(monkeypatch, settings, rows=[row], pdf_rows=[pdf_row])
    assert report.discovered == 1
    assert report.pdf_discovered == 0
    assert report.pdf_skipped_has_xml == 1
    stored = conn.execute(
        "SELECT source, count(*) FROM ch_act_version GROUP BY source").fetchall()
    assert stored == [("fedlex", 1)]
