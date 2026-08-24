import datetime
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

# A real OR footnote that records two successive amendments of one article.
# extract() emits one row per act and keeps the whole note in raw_note, so the
# two rows differ only in the fields that name their own act.
_TWO_EVENT_NOTE = (
    "Eingef\u00fcgt durch Ziff. I des BG vom 5. Okt. 1990 (AS 1991 846; "
    "BBl 1986 II 354). Aufgehoben durch Anhang Ziff. 5 des "
    "Gerichtsstandsgesetzes vom 24. M\u00e4rz 2000, mit Wirkung seit "
    "1. Jan. 2001 (AS 2000 2355; BBl 1999 2829).")


def _snapshot(conn, version_id):
    """Every column that distinguishes one provenance row from another, in a
    stable order. A set of (e_id, raw_note) cannot tell one row from two rows
    of the same two-event note -- see the crash-recovery test."""
    return conn.execute(
        "SELECT e_id, action, as_reference, bbl_reference, effective_date, "
        "source_act_date, raw_note FROM ch_article_provenance "
        "WHERE version_id = %s ORDER BY provenance_id", (version_id,)).fetchall()


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
        for t in ("ch_article_provenance", "ch_act_as_link", "ch_as_act",
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
    # Without this, `== len(rows)` is 0 == 0 for a fixture that yields
    # nothing, and the test passes while storing not one row.
    assert rows, "the fixture must yield provenance for this test to mean anything"
    assert provenance_stage.store(conn, vid, rows) == len(rows)
    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE version_id=%s", (vid,)
    ).fetchone()[0] == len(rows)


def test_rerunning_replaces_rather_than_duplicating(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    assert rows, "the fixture must yield provenance for this test to mean anything"
    provenance_stage.store(conn, vid, rows)
    provenance_stage.store(conn, vid, rows)
    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance").fetchone()[0] == len(rows)


def test_the_raw_note_is_always_persisted(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    assert rows, "the fixture must yield provenance for this test to mean anything"
    provenance_stage.store(conn, vid, rows)
    missing = conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE raw_note IS NULL "
        "OR raw_note = ''").fetchone()[0]
    assert missing == 0


def test_run_skips_a_version_with_no_xml(conn, settings):
    """N3: an edition with no akn_xml is a hole in the CORPUS, and it gets
    its own counter. Folded into versions_without_notes, as it was, an
    operator could not tell a fetch gap worth chasing from a law nobody has
    amended."""
    _version(conn, with_xml=False)
    report = provenance_stage.run(settings)
    assert report.rows == 0
    assert report.versions_without_xml == 1
    assert report.versions_without_notes == 0


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
    # Two rows sharing an e_id AND a raw_note, which is what a note recording
    # two successive amendments now produces: extract() splits it into one row
    # per act but keeps the whole note in raw_note, so the pair differs only in
    # `action`. A set of (e_id, raw_note) collapses that pair into one element
    # and would stay green while the table silently lost one of the two -- so
    # this compares an ordered list of every column that distinguishes them.
    rows = [
        amendment_notes.Provenance(
            e_id="art_1", action="inserted", as_reference="AS 1991 846",
            bbl_reference=None, effective_date=datetime.date(1991, 7, 1),
            source_act_date=datetime.date(1990, 10, 5), raw_note=_TWO_EVENT_NOTE),
        amendment_notes.Provenance(
            e_id="art_1", action="repealed", as_reference="AS 2000 2355",
            bbl_reference=None, effective_date=datetime.date(2001, 1, 1),
            source_act_date=datetime.date(2000, 3, 24), raw_note=_TWO_EVENT_NOTE),
    ]
    provenance_stage.store(conn, vid, rows)
    before = _snapshot(conn, vid)
    assert len(before) == 2, \
        "both rows of a two-event note must be stored, not collapsed into one"

    monkeypatch.setattr(provenance_stage, "_INSERT", "SELECT 1/0")
    with pytest.raises(Exception):
        provenance_stage.store(conn, vid, rows)

    assert _snapshot(conn, vid) == before, \
        "the delete must have rolled back with the failed insert"


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


# --- B4: a re-run that yields nothing must REMOVE the stale rows ---------

_XML_WITH_NOTE = (
    '<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">'
    '<act><body><article eId="art_1"><paragraph eId="art_1/para_1"><content>'
    '<p>Text.<authorialNote><p>{note}</p></authorialNote></p>'
    '</content></paragraph></article></body></act></akomaNtoso>')

_REAL_NOTE = ("Aufgehoben durch Ziff. I des BG vom 4. Okt. 1991, mit Wirkung "
              "seit 1. Juli 1992 (AS 1992 733; BBl 1983 II 745).")
# Not an amendment at all -- a plain SR cross-reference. extract() returns []
# for it, which before this fix meant store() was never called.
_NO_NOTE = "SR 943.03"


def _set_xml(conn, vid, note):
    conn.execute("UPDATE ch_act_version SET akn_xml=%s WHERE version_id=%s",
                 (_XML_WITH_NOTE.format(note=note), vid))


def test_a_rerun_that_yields_nothing_clears_the_previous_rows(conn, settings):
    """run() `continue`d without calling store() when extract() returned [],
    and store() is the only thing that deletes -- so a row written by an
    earlier, wrong parse kept asserting its amendment forever while the
    report counted the night clean.

    This is the recovery path for every parser fix that tightens a rule:
    this branch's own parser went 748 -> 783 -> 782 -> 874 across four
    rounds, and rows have to be able to leave, not only arrive."""
    vid = _version(conn)
    _set_xml(conn, vid, _REAL_NOTE)
    first = provenance_stage.run(settings)
    assert first.rows == 1
    assert conn.execute("SELECT count(*) FROM ch_article_provenance "
                        "WHERE version_id=%s", (vid,)).fetchone()[0] == 1

    # Same version, re-parsed with its amendment footnote gone.
    _set_xml(conn, vid, _NO_NOTE)
    second = provenance_stage.run(settings)

    assert second.rows == 0
    assert second.versions_without_notes == 1
    assert second.cleared == 1, "the report must say a stale row was removed"
    assert conn.execute("SELECT count(*) FROM ch_article_provenance "
                        "WHERE version_id=%s", (vid,)).fetchone()[0] == 0


def test_a_version_with_no_xml_keeps_its_rows(conn, settings):
    """The deliberate asymmetry. A missing akn_xml is absence of evidence:
    the rows were written when the XML was there, and dropping them over an
    unrelated fetch gap would destroy a good parse. It is counted instead."""
    vid = _version(conn)
    _set_xml(conn, vid, _REAL_NOTE)
    provenance_stage.run(settings)
    conn.execute("UPDATE ch_act_version SET akn_xml=NULL WHERE version_id=%s",
                 (vid,))

    report = provenance_stage.run(settings)

    assert report.versions_without_xml == 1
    assert report.cleared == 0
    assert conn.execute("SELECT count(*) FROM ch_article_provenance "
                        "WHERE version_id=%s", (vid,)).fetchone()[0] == 1


def test_clearing_a_version_that_never_had_rows_is_not_counted(conn, settings):
    """`cleared` is the signal that a fix reached the stored rows, so it must
    stay 0 on a steady-state night rather than counting every quiet act."""
    vid = _version(conn)
    _set_xml(conn, vid, _NO_NOTE)
    report = provenance_stage.run(settings)
    assert report.versions_without_notes == 1
    assert report.cleared == 0


# --- B5: container-anchored rows reach the table ------------------------

def test_a_container_anchored_row_is_stored_with_its_fan_out(conn, settings):
    vid = _version(conn)
    rows = amendment_notes.extract(FIXTURE.read_bytes())
    containers = [r for r in rows
                  if r.anchor_level == amendment_notes.ANCHOR_CONTAINER]
    assert containers, "the fixture must carry a container-anchored note"
    provenance_stage.store(conn, vid, rows)

    stored = conn.execute(
        "SELECT anchor_level, count(*) FROM ch_article_provenance "
        "WHERE version_id=%s GROUP BY 1 ORDER BY 1", (vid,)).fetchall()
    assert dict(stored) == {
        "article": sum(1 for r in rows
                       if r.anchor_level == amendment_notes.ANCHOR_ARTICLE),
        "container": len(containers)}
    bad = conn.execute(
        "SELECT count(*) FROM ch_article_provenance WHERE version_id=%s "
        "AND anchor_level='container' AND container_articles IS NULL",
        (vid,)).fetchone()[0]
    assert bad == 0


def test_the_schema_refuses_a_container_row_without_a_fan_out(conn, settings):
    """The CHECK is what stops a container row from silently reading as a
    point statement about one provision."""
    vid = _version(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO ch_article_provenance (version_id, e_id, raw_note, "
            "anchor_level) VALUES (%s, 'part_3', 'x', 'container')", (vid,))


def test_the_schema_refuses_a_fan_out_on_an_article_row(conn, settings):
    vid = _version(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO ch_article_provenance (version_id, e_id, raw_note, "
            "anchor_level, container_articles) "
            "VALUES (%s, 'art_1', 'x', 'article', 5)", (vid,))
