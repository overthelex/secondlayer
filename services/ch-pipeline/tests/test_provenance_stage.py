import os
import pathlib
import psycopg
import pytest
from chpipe import amendment_notes
from chpipe.config import Settings
from chpipe.stages import acts_stage, provenance_stage, versions_stage

# Derive repo root from this file's location, the same way test_diff_stage.py
# does: this file runs from both the service directory and the repo root
# (see the two full-suite commands in the task brief), so a path relative to
# the working directory would break one of them.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
M198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "or_de_20260101.xml"
WORK = "https://fedlex.data.admin.ch/eli/cc/27/317_321_377"
L = "http://publications.europa.eu/resource/authority/language/"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    # 0.0 disables the guard (throttle.should_pause). The capacity test
    # monkeypatches wait_for_capacity, so it still sees the call; a real
    # ceiling here would instead park every other test in this file in a
    # 60s sleep loop whenever the box's load is high -- a hung suite, not a
    # failing one. See test_diff_stage.py's identical fixture comment.
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        for t in ("ch_article_provenance", "ch_act_amendment_link", "ch_as_act",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        acts_stage.upsert_act(c, {"work": WORK, "srNotation": "220"})
        yield c


def _version(conn, with_xml=True):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026", "dateApplicability": "2026-01-01",
        "lang": L + "DEU", "fileUrl": "https://x/x.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s "
                 "WHERE version_id=%s",
                 (FIXTURE.read_text() if with_xml else None, vid))
    return vid


def test_stores_provenance_rows_for_a_version(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    assert provenance_stage.store(conn, vid, rows) == len(rows)
    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(rows)


def test_rerunning_replaces_rather_than_duplicating(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    provenance_stage.store(conn, vid, rows)
    provenance_stage.store(conn, vid, rows)
    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance").fetchone()[0] == len(rows)


def test_the_raw_note_is_always_persisted(conn, settings):
    vid = _version(conn)
    provenance_stage.store(conn, vid, amendment_notes.extract(FIXTURE.read_bytes()))
    missing = conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE raw_note IS NULL "
        "OR raw_note = ''").fetchone()[0]
    assert missing == 0


def test_run_skips_a_version_with_no_xml(conn, settings):
    _version(conn, with_xml=False)
    report = provenance_stage.run(settings)
    assert report.rows == 0
    assert report.versions_without_notes == 1


def test_run_only_touches_the_requested_language(conn, settings):
    vid = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026fr",
        "dateApplicability": "2026-01-01", "lang": L + "FRA",
        "fileUrl": "https://x/fr.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s "
                 "WHERE version_id=%s", (FIXTURE.read_text(), vid))
    assert provenance_stage.run(settings, lang="de").versions == 0


# --- overrides to the brief: transaction safety, `failed`, capacity ---

def test_a_crash_between_the_delete_and_the_insert_keeps_the_old_rows(
        conn, settings, monkeypatch):
    """store()'s connection is autocommit (db.connect() sets it), so an
    unguarded delete would commit on its own: a kill before the inserts
    would leave the version's provenance empty and committed -- a state the
    code could not otherwise reach. This is the same defect diff_stage's
    _CLEAR_CHANGES / _UPSERT_CHANGE pair was found and closed for at
    323c0d83 (see diff_stage.run()'s `with conn.transaction():` block, and
    that commit's test of the same name); this test proves store() gets the
    identical guard, using the same "break the write with a bad statement"
    technique test_diff_stage.py uses."""
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    provenance_stage.store(conn, vid, rows)
    before = {(r[0], r[1]) for r in conn.execute(
        "SELECT e_id, raw_note FROM ch_article_provenance WHERE version_id=%s",
        (vid,)).fetchall()}
    assert before, "the fixture must produce at least one row for this test to mean anything"

    monkeypatch.setattr(provenance_stage, "_INSERT", "SELECT 1/0")
    with pytest.raises(Exception):
        provenance_stage.store(conn, vid, rows)

    after = {(r[0], r[1]) for r in conn.execute(
        "SELECT e_id, raw_note FROM ch_article_provenance WHERE version_id=%s",
        (vid,)).fetchall()}
    assert after == before, "the delete must have rolled back with the failed insert"


def test_run_counts_a_parse_failure_without_aborting_the_walk(conn, settings,
                                                              monkeypatch):
    """Two versions, one whose extract() blows up: the walk must still
    finish the other one and count the failure rather than raising out of
    run() -- the same per-item guard parse_akn_stage.run() and
    diff_stage.run() both already carry."""
    v1 = _version(conn)
    v2 = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026b",
        "dateApplicability": "2026-06-01", "lang": L + "DEU",
        "fileUrl": "https://x/x2.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s "
                 "WHERE version_id=%s", (FIXTURE.read_text(), v2))

    real_extract = provenance_stage.amendment_notes.extract
    calls = []

    def _flaky(xml, lang="de"):
        calls.append(xml)
        if len(calls) == 1:
            raise ValueError("malformed xml")
        return real_extract(xml, lang=lang)

    monkeypatch.setattr(provenance_stage.amendment_notes, "extract", _flaky)
    report = provenance_stage.run(settings)

    assert report.failed == 1
    assert report.versions == 1


def test_run_waits_for_capacity_before_each_version(conn, settings, monkeypatch):
    """This is a 12,033-document full-corpus lxml walk, parse_akn_stage's
    shape exactly, so it takes the same per-unit-of-work capacity check --
    inside the loop, before claiming each version, not once at startup."""
    seen = []
    monkeypatch.setattr(provenance_stage.throttle, "wait_for_capacity",
                        lambda ceiling, stage, **kw: seen.append((ceiling, stage)))
    v1 = _version(conn)
    v2 = versions_stage.upsert_version(conn, {
        "work": WORK, "consolidation": f"{WORK}/2026b",
        "dateApplicability": "2026-06-01", "lang": L + "DEU",
        "fileUrl": "https://x/x2.xml"})
    conn.execute("UPDATE ch_act_version SET stage='parsed', akn_xml=%s "
                 "WHERE version_id=%s", (FIXTURE.read_text(), v2))

    provenance_stage.run(settings)

    assert seen == [(settings.load_ceiling, "provenance")] * 2
