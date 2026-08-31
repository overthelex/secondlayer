"""zh_amend_stage: one ch_act_change_document per ZH Nachtrag edition.

Everything the stage needs was stored by zh_acts_stage (ch_act.metadata_json
.editions plus the ch_act_version rows), so these tests seed those two
shapes directly -- the real ones, via conftest.reset_legislation_schema --
and never touch the network. Verified live on zh.ch (2026-08-31, six
edition pages across 1869-2024): the description list carries NO OS
reference on any era, so `number` is the Nachtrag number and os_ref is
stored as an explicit null, never parsed from anywhere.
"""
import datetime
import json
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import zh_amend_stage
from chpipe.stages.zh_acts_stage import consolidation_uri, work_uri

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

D = datetime.date


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        reset_legislation_schema(c)
        yield c


def _edition(page, kind, text, title, enactment, publication, withdrawal,
             entry_into_force=None):
    return {"page": page, "kind": kind, "text": text, "title": title,
            "enactment": enactment, "publication": publication,
            "withdrawal": withdrawal, "entry_into_force": entry_into_force}


def _act(conn, sr, editions, jurisdiction="ZH"):
    return conn.execute(
        "INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, metadata_json) "
        "VALUES (%s, %s, %s, %s) RETURNING act_id",
        (work_uri(sr), jurisdiction, sr,
         json.dumps({"platform": "zhlex", "editions": editions}))).fetchone()["act_id"]


def _version(conn, act_id, sr, no, date_app, source="zhlex", lang="de"):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
        "date_applicability, source, stage) VALUES (%s, %s, %s, %s, %s, 'parsed') "
        "RETURNING version_id",
        (act_id, consolidation_uri(sr, no), lang, date_app, source)).fetchone()["version_id"]


def _docs(conn, act_id):
    return conn.execute(
        "SELECT * FROM ch_act_change_document WHERE act_id = %s ORDER BY source_id",
        (act_id,)).fetchall()


# The constitution's shape in miniature: an 1869 loose-leaf series (no
# Publikationsdatum) re-enacted in 2005 (publication dates, PDFs).
EDITIONS_101 = {
    "000": _edition("https://www.zh.ch/e-000.html", "html", "https://www.notes.zh.ch/webrt/0",
                    "Verfassung des eidgenössischen Standes Zürich",
                    "1869-04-18", None, "1995-09-30"),
    "039": _edition("https://www.zh.ch/e-039.html", "html", "https://www.notes.zh.ch/webrt/39",
                    "Verfassung des eidgenössischen Standes Zürich",
                    "1869-04-18", None, "2006-01-01"),
    "051": _edition("https://www.zh.ch/e-051.html", "pdf", "https://www.notes.zh.ch/pdf/51.pdf",
                    "Verfassung des Kantons Zürich",
                    "2005-02-27", "2006-01-01", "2009-01-01", entry_into_force="2006-01-01"),
    "129": _edition("https://www.zh.ch/e-129.html", "pdf", "https://www.notes.zh.ch/pdf/129.pdf",
                    "Verfassung des Kantons Zürich",
                    "2005-02-27", "2024-07-01", None, entry_into_force="2006-01-01"),
}


def test_source_id_is_monotone_in_nachtrag_order():
    ids = [zh_amend_stage.source_id(no) for no in ("000", "008", "008b", "009", "129")]
    assert ids == [0, 800, 802, 900, 12900]
    assert ids == sorted(ids)


def test_one_document_per_successor_edition_never_the_original(conn, settings):
    act = _act(conn, "101", EDITIONS_101)
    versions = {no: _version(conn, act, "101", no, d) for no, d in
                (("000", D(1869, 4, 18)), ("039", D(1995, 10, 1)),
                 ("051", D(2006, 1, 1)), ("129", D(2024, 7, 1)))}
    report = zh_amend_stage.run(settings)

    docs = _docs(conn, act)
    assert [d["number"] for d in docs] == ["039", "051", "129"]
    assert report.acts == 1 and report.documents == 3 and report.first_editions == 1
    for doc in docs:
        assert doc["jurisdiction"] == "ZH"
        meta = doc["metadata_json"]
        assert meta["nachtrag"] == doc["number"]
        assert meta["os_ref"] is None, "no OS reference exists on zh.ch edition pages"
        assert meta["version_id"] == versions[doc["number"]]
        assert meta["consolidation"] == consolidation_uri("101", doc["number"])
        assert meta["page_url"] == EDITIONS_101[doc["number"]]["page"]


def test_dates_and_pdf_url_per_edition_era(conn, settings):
    act = _act(conn, "101", EDITIONS_101)
    for no, d in (("000", D(1869, 4, 18)), ("039", D(1995, 10, 1)),
                  ("051", D(2006, 1, 1)), ("129", D(2024, 7, 1))):
        _version(conn, act, "101", no, d)
    report = zh_amend_stage.run(settings)

    by_no = {d["number"]: d for d in _docs(conn, act)}
    # Loose-leaf 039 has no Publikationsdatum: the derived start
    # (date_applicability of its own version row) stands in, and says so.
    assert by_no["039"]["date_publication"] == D(1995, 10, 1)
    assert by_no["039"]["metadata_json"]["date_source"] == "derived"
    assert by_no["039"]["pdf_url"] is None
    assert by_no["039"]["metadata_json"]["text_url"].startswith("https://www.notes.zh.ch/webrt")
    # 051 opens the 2005 series: a re-enactment, so its Erlassdatum IS the
    # decision date of the new act. Within a series the page just repeats
    # the series' Erlassdatum, which is no Nachtrag decision date at all.
    assert by_no["051"]["date_decision"] == D(2005, 2, 27)
    assert by_no["051"]["metadata_json"]["reenactment"] is True
    assert by_no["129"]["date_decision"] is None
    assert by_no["129"]["metadata_json"]["reenactment"] is False
    assert by_no["129"]["date_publication"] == D(2024, 7, 1)
    assert by_no["129"]["metadata_json"]["date_source"] == "publication"
    assert by_no["129"]["pdf_url"] == "https://www.notes.zh.ch/pdf/129.pdf"
    assert by_no["129"]["title"] == "Verfassung des Kantons Zürich"
    assert report.reenactments == 1


def test_rerun_is_idempotent_and_removes_orphans(conn, settings):
    act = _act(conn, "101", EDITIONS_101)
    for no, d in (("000", D(1869, 4, 18)), ("039", D(1995, 10, 1)),
                  ("051", D(2006, 1, 1)), ("129", D(2024, 7, 1))):
        _version(conn, act, "101", no, d)
    zh_amend_stage.run(settings)
    # A document a previous run wrote for an edition that no longer exists
    # (the walk renumbered, the page vanished from the Historie) must not
    # survive as fabricated history.
    conn.execute(
        "INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number) "
        "VALUES (%s, 'ZH', 99900, '999')", (act,))
    report = zh_amend_stage.run(settings)

    assert [d["number"] for d in _docs(conn, act)] == ["039", "051", "129"]
    assert report.documents == 3 and report.orphaned == 1


def test_acts_without_editions_or_versions_are_counted_not_guessed(conn, settings):
    bare = conn.execute(
        "INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, metadata_json) "
        "VALUES (%s, 'ZH', '999.9', %s) RETURNING act_id",
        (work_uri("999.9"), json.dumps({"platform": "zhlex"}))).fetchone()["act_id"]
    # 170.4: editions stored, but one version row missing (a pages_failed
    # rerun gap). The document is still written -- the edition is real --
    # with a null version link and a counter.
    gap = _act(conn, "170.4", {
        "000": _edition("https://www.zh.ch/g0.html", "html", "u0", "G", "1990-01-01", None, None),
        "001": _edition("https://www.zh.ch/g1.html", "pdf", "u1.pdf", "G", "1990-01-01",
                        "2001-05-01", None),
    })
    _version(conn, gap, "170.4", "000", D(1990, 1, 1))
    # a BE act must never be touched
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number) "
                 "VALUES ('be/1', 'BE', '101.1')")
    report = zh_amend_stage.run(settings)

    assert report.no_editions == 1 and report.no_editions_samples == ["999.9"]
    assert _docs(conn, bare) == []
    docs = _docs(conn, gap)
    assert [d["number"] for d in docs] == ["001"]
    assert docs[0]["metadata_json"]["version_id"] is None
    assert docs[0]["date_publication"] == D(2001, 5, 1)
    assert report.version_missing == 1
    assert conn.execute("SELECT count(*) AS n FROM ch_act_change_document "
                        "WHERE jurisdiction <> 'ZH'").fetchone()["n"] == 0


def test_only_narrows_to_the_named_numbers(conn, settings):
    a = _act(conn, "101", EDITIONS_101)
    for no, d in (("000", D(1869, 4, 18)), ("039", D(1995, 10, 1)),
                  ("051", D(2006, 1, 1)), ("129", D(2024, 7, 1))):
        _version(conn, a, "101", no, d)
    b = _act(conn, "170.4", {
        "000": _edition("p0", "html", "u0", "G", "1990-01-01", None, None),
        "001": _edition("p1", "pdf", "u1.pdf", "G", "1990-01-01", "2001-05-01", None),
    })
    report = zh_amend_stage.run(settings, only={"170.4"})
    assert report.acts == 1 and report.documents == 1
    assert _docs(conn, a) == [] and len(_docs(conn, b)) == 1


def test_bad_version_numbers_are_skipped_with_a_sample(conn, settings):
    act = _act(conn, "200.1", {
        "000": _edition("p0", "html", "u0", "T", "2000-01-01", None, None),
        "oops": _edition("px", "pdf", "ux.pdf", "T", "2000-01-01", "2010-01-01", None),
        "001": _edition("p1", "pdf", "u1.pdf", "T", "2000-01-01", "2005-01-01", None),
    })
    report = zh_amend_stage.run(settings)
    assert [d["number"] for d in _docs(conn, act)] == ["001"]
    assert report.bad_version_no == 1 and "200.1/oops" in report.bad_version_no_samples[0]


def test_gate_f_zh_amendment_counters_become_nonzero(conn, settings):
    """Deliverable K3-ZH end to end on a seeded act: zh-amend writes the
    change documents, diff computes ch_act_change between the parsed
    editions, and Gate F's ZH amendment counters stop reading zero."""
    from chpipe import reports_cantonal
    from chpipe.stages import diff_stage

    act = _act(conn, "101", EDITIONS_101)
    versions = {no: _version(conn, act, "101", no, d) for no, d in
                (("039", D(1995, 10, 1)), ("051", D(2006, 1, 1)))}
    for no, text in (("039", "§ 1. Der Kanton ist souverän."),
                     ("051", "§ 1. Der Kanton Zürich ist ein Stand der Eidgenossenschaft.")):
        conn.execute(
            "INSERT INTO ch_act_article (version_id, e_id, article_number, text, ordinal) "
            "VALUES (%s, 'par_1', '1', %s, 0)", (versions[no], text))
    amend = zh_amend_stage.run(settings)
    diffed = diff_stage.run(settings, lang="de", act_id=act)

    assert amend.documents == 3 and diffed.changes >= 1
    row = reports_cantonal.gate_f(conn, "ZH")[0]
    assert row["changes"] >= 1, "ZH used to report zero computed changes"
    assert row["change_documents"] == 3, "ZH used to report zero change documents"
    # Edition-level linkage only: the document names its version in
    # metadata_json, so a computed change joins to the Nachtrag that
    # introduced it through to_version_id. No provenance rows for ZH.
    linked = conn.execute(
        "SELECT count(*) AS n FROM ch_act_change c "
        "JOIN ch_act_change_document d ON d.act_id = c.act_id "
        " AND (d.metadata_json->>'version_id')::bigint = c.to_version_id "
        "WHERE d.jurisdiction = 'ZH'").fetchone()["n"]
    assert linked == diffed.changes
    assert row["provenance_rows"] == 0
