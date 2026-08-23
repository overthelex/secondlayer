"""Discovery of consolidated editions into ch_act_version.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_versions_stage.py
"""
import os
import pathlib
import psycopg
import pytest
from chpipe.stages import acts_stage, versions_stage
from chpipe.config import Settings

# Derive repo root from this file's location: services/ch-pipeline/tests/test_versions_stage.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

L = "http://publications.europa.eu/resource/authority/language/"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
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
    without ever touching the live Fedlex endpoint. paged() ignores the
    query text and page_size and just replays the rows it was built with."""

    def __init__(self, rows):
        self._rows = rows
        self.closed = False

    def paged(self, query_template, page_size=5000):
        yield from self._rows

    def close(self):
        self.closed = True


def _run_with_rows(monkeypatch, settings, rows):
    monkeypatch.setattr(versions_stage, "SparqlClient",
                         lambda endpoint: _FakeSparqlClient(rows))
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
