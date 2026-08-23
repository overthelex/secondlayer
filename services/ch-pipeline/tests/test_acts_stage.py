"""Discovery of Fedlex Systematic Compilation works into ch_act.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:5432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_acts_stage.py
"""
import os
import pathlib
import psycopg
import pytest
from chpipe.stages import acts_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/test_acts_stage.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "sr_number text, title text, PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        yield c


OR_ROW = {
    "work": "https://fedlex.data.admin.ch/eli/cc/27/317_321_377",
    "srNotation": "220",
    "dateDocument": "1911-03-30",
    "dateEntryForce": "1912-01-01",
    "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0",
}


def test_stores_the_real_sr_number(conn):
    """The whole point: the old table stored '1971/1069_1068_1068' here."""
    acts_stage.upsert_act(conn, OR_ROW)
    assert conn.execute("SELECT sr_number FROM ch_act").fetchone()[0] == "220"


def test_status_zero_means_in_force(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    row = conn.execute("SELECT enforcement_status, in_force FROM ch_act").fetchone()
    assert row == (0, True)


def test_status_three_means_repealed(conn):
    acts_stage.upsert_act(conn, {**OR_ROW, "inForce":
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"})
    row = conn.execute("SELECT enforcement_status, in_force FROM ch_act").fetchone()
    assert row == (3, False)


def test_a_work_with_no_status_is_stored_with_null_not_false(conn):
    """~4,296 works publish no status; recording them as 'not in force' would be
    an assertion Fedlex never made."""
    row = dict(OR_ROW)
    row.pop("inForce")
    acts_stage.upsert_act(conn, row)
    assert conn.execute(
        "SELECT enforcement_status, in_force FROM ch_act").fetchone() == (None, None)


def test_a_work_with_no_sr_notation_is_still_stored(conn):
    row = dict(OR_ROW)
    row.pop("srNotation")
    row["work"] = "https://fedlex.data.admin.ch/eli/cc/1/116_97_116"
    act_id = acts_stage.upsert_act(conn, row)
    assert act_id is not None
    assert conn.execute("SELECT sr_number FROM ch_act").fetchone()[0] is None


def test_upsert_is_idempotent_and_returns_the_same_id(conn):
    first = acts_stage.upsert_act(conn, OR_ROW)
    second = acts_stage.upsert_act(conn, OR_ROW)
    assert first == second
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 1


def test_apply_titles_writes_all_five_languages_and_the_abbreviation(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    L = "http://publications.europa.eu/resource/authority/language/"
    acts_stage.apply_titles(conn, [
        {"work": OR_ROW["work"], "lang": L + "DEU", "title": "Bundesgesetz …",
         "titleShort": "OR"},
        {"work": OR_ROW["work"], "lang": L + "FRA", "title": "Loi fédérale …",
         "titleShort": "CO"},
        {"work": OR_ROW["work"], "lang": L + "ITA", "title": "Legge federale …"},
        {"work": OR_ROW["work"], "lang": L + "ENG", "title": "Federal Act …"},
        {"work": OR_ROW["work"], "lang": L + "ROH", "title": "Lescha federala …"},
    ])
    row = conn.execute(
        "SELECT title_de, title_fr, title_it, title_en, title_rm, abbreviation "
        "FROM ch_act").fetchone()
    assert row[0].startswith("Bundesgesetz")
    assert row[3].startswith("Federal Act")
    assert row[4].startswith("Lescha")
    assert row[5] == "OR"


def test_apply_titles_ignores_a_language_we_do_not_store(conn):
    acts_stage.upsert_act(conn, OR_ROW)
    acts_stage.apply_titles(conn, [
        {"work": OR_ROW["work"], "lang": "http://example/unknown", "title": "x"}])
    assert conn.execute("SELECT title_de FROM ch_act").fetchone()[0] is None


def test_apply_titles_for_an_unknown_work_is_a_no_op(conn):
    assert acts_stage.apply_titles(conn, [
        {"work": "https://x/never-seen", "lang":
         "http://publications.europa.eu/resource/authority/language/DEU",
         "title": "x"}]) == 0


def test_conflicting_status_is_recorded_not_resolved(conn):
    """Twelve live works assert BOTH inForceStatus 0 and 3 for the same work
    (see fedlex_queries.ACTS's comment). Picking a winner would assert
    something Fedlex itself does not -- the honest answer is 'unknown',
    recorded loudly in metadata_json rather than silently defaulted."""
    work = "https://fedlex.data.admin.ch/eli/cc/2003/31"
    first = acts_stage.upsert_act(conn, {**OR_ROW, "work": work,
        "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"})
    second = acts_stage.upsert_act(conn, {**OR_ROW, "work": work,
        "inForce": "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"})
    assert first == second

    row = conn.execute(
        "SELECT enforcement_status, in_force, metadata_json FROM ch_act "
        "WHERE eli_work_uri = %s", (work,)).fetchone()
    enforcement_status, in_force, metadata_json = row

    # 1. enforcement_status reads NULL, so the generated in_force is unknown,
    #    not silently False.
    assert enforcement_status is None
    assert in_force is None

    # 2. Both observed values are recorded in metadata_json under a clearly
    #    named key, so the row explains why it is unknown.
    assert sorted(metadata_json["status_conflict"]) == [0, 3]


# --------------------------------------------------------------------------
# run(): a keyset walk for the acts, a VALUES-driven pass for the titles.
#
# The offset walk these replaced could not reach past row 10,000 of a 17,293
# work corpus: Fedlex's Virtuoso raises SR353 once OFFSET + LIMIT exceeds
# 10,000. Every test here fails against that code, which had no run() coverage
# at all -- which is precisely why the ceiling went unnoticed.
# --------------------------------------------------------------------------

L = "http://publications.europa.eu/resource/authority/language/"


@pytest.fixture
def settings():
    from chpipe.config import Settings
    return Settings(
        dsn=os.environ["CHPIPE_TEST_DSN"],
        raw_dir=pathlib.Path("/tmp/chpipe-acts-test"),
        http_concurrency=1, cpu_workers=1, ocr_workers=1,
        load_ceiling=6.0, max_attempts=3,
    )


class _FakeSparqlClient:
    """Stands in for chpipe.sparql.SparqlClient. Records which query text each
    walker was handed and, for batched(), the driving set it was given -- that
    driving set is the thing under test."""

    def __init__(self, act_rows, title_rows):
        self._act_rows = act_rows
        self._title_rows = title_rows
        self.keyset_calls: list[tuple] = []
        self.batches: list[list[str]] = []
        self.closed = False

    def keyset(self, query_template, key="work", page_size=2000):
        self.keyset_calls.append((query_template, key, page_size))
        yield from self._act_rows

    def batched(self, query_template, uris, batch_size=20):
        batch: list[str] = []
        for uri in uris:
            batch.append(uri)
            if len(batch) >= batch_size:
                self.batches.append(batch)
                batch = []
        if batch:
            self.batches.append(batch)
        if self.batches:
            yield from self._title_rows

    def close(self):
        self.closed = True


def _run(monkeypatch, settings, act_rows, title_rows=(), capture=None):
    fake = _FakeSparqlClient(list(act_rows), list(title_rows))
    if capture is not None:
        capture.append(fake)
    monkeypatch.setattr(acts_stage, "SparqlClient", lambda endpoint: fake)
    return acts_stage.run(settings)


def _act(i):
    return {"work": f"https://fedlex.data.admin.ch/eli/cc/z/{i:03d}",
            "srNotation": str(100 + i)}


def test_run_walks_the_acts_by_key_not_by_an_offset(conn, settings, monkeypatch):
    seen: list = []
    _run(monkeypatch, settings, [_act(0)], capture=seen)
    template, key, _page = seen[0].keyset_calls[0]
    assert template is acts_stage.fq.ACTS
    assert key == "work", "the walk must advance by the work URI"
    assert "OFFSET" not in template.upper()


def test_run_titles_the_works_it_has_just_discovered(conn, settings, monkeypatch):
    """The titles pass is driven by the works of this run, in walk order, in
    batches -- not by an offset into a 52,000-row global ordering."""
    seen: list = []
    rows = [_act(i) for i in range(45)]
    _run(monkeypatch, settings, rows, capture=seen)

    driven = [u for b in seen[0].batches for u in b]
    assert driven == [r["work"] for r in rows]
    assert [len(b) for b in seen[0].batches] == [20, 20, 5]


def test_run_binds_a_dual_status_work_into_a_batch_only_once(conn, settings,
                                                             monkeypatch):
    """Twelve works occupy two ACTS rows. Binding such a work into a VALUES
    batch twice would make Fedlex answer for it twice for no gain."""
    work = "https://fedlex.data.admin.ch/eli/cc/2003/31"
    seen: list = []
    rows = [
        {"work": work, "inForce":
         "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"},
        {"work": work, "inForce":
         "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"},
    ]
    report = _run(monkeypatch, settings, rows, capture=seen)

    assert report.discovered == 2, "both source rows are walked"
    assert [u for b in seen[0].batches for u in b] == [work], "…but bound once"
    # And the conflict is still recorded, not resolved.
    assert report.conflicts == 1
    assert report.conflicting_works == [work]
    assert conn.execute(
        "SELECT enforcement_status, in_force FROM ch_act WHERE eli_work_uri=%s",
        (work,)).fetchone() == (None, None)


def test_run_applies_the_titles_a_batch_returns(conn, settings, monkeypatch):
    row = _act(0)
    report = _run(monkeypatch, settings, [row], title_rows=[
        {"work": row["work"], "lang": L + "DEU", "title": "Bundesgesetz …",
         "titleShort": "OR"}])
    assert report.titled == 1
    assert report.unmatched_titles == 0
    assert conn.execute(
        "SELECT title_de, abbreviation FROM ch_act").fetchone() == (
            "Bundesgesetz …", "OR")


def test_run_still_reports_a_title_row_that_went_nowhere(conn, settings,
                                                         monkeypatch):
    """A title in a language the schema has no column for reaches the stage
    and is written nowhere. That must stay visible."""
    row = _act(0)
    report = _run(monkeypatch, settings, [row], title_rows=[
        {"work": row["work"], "lang": "http://example/klingon", "title": "x"}])
    assert report.titled == 0
    assert report.unmatched_titles == 1


def test_run_issues_no_title_batch_when_nothing_was_discovered(conn, settings,
                                                               monkeypatch):
    seen: list = []
    report = _run(monkeypatch, settings, [], capture=seen)
    assert seen[0].batches == []
    assert report.discovered == 0


def test_run_does_not_abort_the_walk_on_one_bad_row(conn, settings, monkeypatch):
    """One malformed binding must not lose the other 17,292 works."""
    bad = {"srNotation": "220"}                 # no ?work -> KeyError on upsert
    report = _run(monkeypatch, settings, [bad, _act(1)])
    assert report.errors == 1
    assert report.discovered == 1
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 1


def test_run_closes_the_client_even_after_a_bad_row(conn, settings, monkeypatch):
    seen: list = []
    _run(monkeypatch, settings, [{"srNotation": "220"}], capture=seen)
    assert seen[0].closed is True
