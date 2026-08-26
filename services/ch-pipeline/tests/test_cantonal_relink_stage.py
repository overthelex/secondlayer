"""cantonal_relink_stage on real Postgres: rows seeded with prod raw_note
strings (2026-08-26), documents numbered as the hosts number them."""
import datetime
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.stages import cantonal_relink_stage

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
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        yield c


def _act(conn, act_id, canton, docs):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                 "VALUES (%s, %s, %s, '1')", (act_id, f"https://{canton}/{act_id}", canton))
    ids = {}
    for source_id, number, pub in docs:
        ids[number] = conn.execute(
            "INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number, "
            "date_publication) VALUES (%s, %s, %s, %s, %s) RETURNING change_document_id",
            (act_id, canton, source_id, number, pub)).fetchone()[0]
    return ids


def _version(conn, act_id, n, source="lexwork"):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "source, stage) VALUES (%s, %s, 'de', '2020-01-01', %s, 'parsed') RETURNING version_id",
        (act_id, f"v/{act_id}/{n}", source)).fetchone()[0]


def _row(conn, version_id, raw_note, linked=None):
    fields = raw_note.split(" | ")

    def date(s):
        d, m, y = s.split(".")
        return D(int(y), int(m), int(d))
    return conn.execute(
        "INSERT INTO ch_article_provenance (version_id, e_id, action, as_reference, "
        "effective_date, source_act_date, raw_note, anchor_level, container_articles, "
        "change_document_id) VALUES (%s, 't-0', 'amended', %s, %s, %s, %s, 'container', 0, %s) "
        "RETURNING provenance_id",
        (version_id, fields[4] if len(fields) > 4 else None, date(fields[1]), date(fields[0]),
         raw_note, linked)).fetchone()[0]


def _links(conn, version_id):
    return [r[0] for r in conn.execute(
        "SELECT change_document_id FROM ch_article_provenance WHERE version_id=%s "
        "ORDER BY provenance_id", (version_id,)).fetchall()]


@pytest.fixture
def seeded(conn):
    bl = _act(conn, 1, "BL", [(1, "2017.026", "2017-05-30"), (2, "2018.040", "2018-06-12")])
    bl_v = _version(conn, 1, 1)
    _row(conn, bl_v, "21.03.2017 | 01.07.2017 | § 16 Abs. 1 | geändert | GS 2017.026")
    _row(conn, bl_v, "05.06.2018 | 01.01.2019 | § 1 Abs. 1, Bst. a. | geändert | GS 2018.040")
    _row(conn, bl_v, "18.05.2000 | 01.01.2001 | § 16 Abs. 1, Bst. f. | geändert | GS 33.1335")
    _row(conn, bl_v, "01.01.2019 | 01.01.2019 | § 2 | geändert | GS 2018.040", linked=bl["2017.026"])
    lu = _act(conn, 2, "LU", [(11, "2009-12", "2009-04-04"), (12, "2017-022", "2017-04-08")])
    lu_v = _version(conn, 2, 1)
    _row(conn, lu_v, "09.03.2009 | 01.01.2010 | § 226 Abs. 3 | eingefügt | G 2009 321")
    _row(conn, lu_v, "28.03.2017 | 01.07.2017 | § 5 | geändert | G 2017-022")
    tg = _act(conn, 3, "TG", [])
    tg_v = _version(conn, 3, 1)
    _row(conn, tg_v, "16.08.2011 | 01.08.2011 | § 66 Abs. 2, 1. | geändert")
    fedlex_v = _version(conn, 1, 2, source="fedlex")
    _row(conn, fedlex_v, "21.03.2017 | 01.07.2017 | § 16 Abs. 1 | geändert | GS 2017.026")
    return {"bl": bl, "bl_v": bl_v, "lu": lu, "lu_v": lu_v, "tg_v": tg_v, "fedlex_v": fedlex_v}


def test_relinks_one_canton_by_number_and_reports_the_rest(conn, settings, seeded):
    report = cantonal_relink_stage.run(settings, canton_code="BL")
    assert report.cantons == ["BL"] and report.acts == 1 and report.versions == 1
    assert (report.rows, report.linked, report.already_linked, report.unlinked) == (4, 2, 1, 1)
    assert report.by_reason == {"number": 2, "window_none": 1}
    bl = seeded["bl"]
    assert _links(conn, seeded["bl_v"]) == [bl["2017.026"], bl["2018.040"], None, bl["2017.026"]]
    # the LU act was not touched, nor the fedlex edition of the BL act
    assert _links(conn, seeded["lu_v"]) == [None, None]
    assert _links(conn, seeded["fedlex_v"]) == [None]


def test_page_style_reference_links_through_the_window(conn, settings, seeded):
    report = cantonal_relink_stage.run(settings, canton_code="LU")
    assert report.by_reason == {"window": 1, "number": 1}
    lu = seeded["lu"]
    assert _links(conn, seeded["lu_v"]) == [lu["2009-12"], lu["2017-022"]]


def test_a_second_run_is_a_no_op(conn, settings, seeded):
    cantonal_relink_stage.run(settings, canton_code="BL,LU")
    before = _links(conn, seeded["bl_v"]) + _links(conn, seeded["lu_v"])
    report = cantonal_relink_stage.run(settings, canton_code="BL,LU")
    assert report.linked == 0 and report.already_linked == 5 and report.unlinked == 1
    assert _links(conn, seeded["bl_v"]) + _links(conn, seeded["lu_v"]) == before


def test_force_recomputes_links_that_already_exist(conn, settings, seeded):
    report = cantonal_relink_stage.run(settings, canton_code="BL", force=True)
    assert report.already_linked == 0 and report.linked == 3
    bl = seeded["bl"]
    # the pre-existing wrong link (row cites 2018.040, was linked to 2017.026) is corrected
    assert _links(conn, seeded["bl_v"])[3] == bl["2018.040"]


def test_date_decision_is_backfilled_from_the_linked_rows(conn, settings, seeded):
    report = cantonal_relink_stage.run(settings, canton_code="BL")
    dates = dict(conn.execute(
        "SELECT number, date_decision FROM ch_act_change_document WHERE act_id=1").fetchall())
    # 2017.026 is cited by two rows with different decision dates (the
    # pre-existing link's row says 01.01.2019): left alone, not averaged
    assert dates == {"2017.026": None, "2018.040": D(2018, 6, 5)}
    assert report.decision_dates_filled == 1


def test_a_canton_without_documents_reports_no_candidates(conn, settings, seeded):
    report = cantonal_relink_stage.run(settings, canton_code="TG")
    assert report.by_reason == {"no_candidates": 1} and report.unlinked == 1


def test_all_cantons_when_none_is_named_and_limit_bounds_versions(conn, settings, seeded):
    report = cantonal_relink_stage.run(settings, limit=1)
    assert len(report.cantons) == 19 and report.versions == 1 and report.acts == 1
    report = cantonal_relink_stage.run(settings)
    assert report.versions == 3 and report.rows == 7


def test_an_unknown_canton_is_a_hard_error(settings):
    with pytest.raises(ValueError):
        cantonal_relink_stage.run(settings, canton_code="XX")
