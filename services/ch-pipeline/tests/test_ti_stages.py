"""ti_acts_stage, ti_fetch_stage and ti_parse_stage against a mocked
www3.ti.ch (the real trimmed pages) and real Postgres, end to end."""
import datetime
import json
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import db, ti_rl
from chpipe.config import Settings
from chpipe.stages import ti_acts_stage, ti_fetch_stage, ti_parse_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
LIST = (FIXTURES / "ti_rl_list.html").read_bytes()
PAGES = {
    1: (FIXTURES / "ti_rl_act_101_000.html").read_bytes(),
    3: (FIXTURES / "ti_rl_act_110_110.html").read_bytes(),
}
MISSING = (FIXTURES / "ti_rl_missing.html").read_bytes()
RUN_DATE = datetime.date(2026, 8, 26)


@pytest.fixture
def settings(tmp_path):
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=tmp_path,
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


def _registry(conn, tol_id, sysnr, rl_id, dates, active=True, current=None):
    versions = [{"id": 1000 + i, "version_active_since": d,
                 "is_active": d == (current or dates[-1])} for i, d in enumerate(dates)]
    conn.execute(
        "INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, is_active, "
        "original_url, versions_json, version_count) VALUES (%s, 'TI', %s, %s, %s, %s, %s)",
        (tol_id, sysnr, active, ti_rl.act_url(rl_id) if rl_id else None,
         json.dumps(versions), len(versions)))


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        # 101.000 by id; 110.100 (id 2) known by number only, under an OLD
        # number in LexFind... no: matched by number 110.100 with no URL;
        # 110.110 (id 3) by id but renumbered on LexFind's side; id 101
        # (120.200) unknown to LexFind; 999.999 active in LexFind, not listed.
        _registry(c, 1, "101.000", 1, ["01.01.1998", "01.01.2011", "01.01.2023"])
        _registry(c, 2, "110.100", None, ["25.05.1803"])
        _registry(c, 3, "110.105", 3, ["18.04.1996", "05.02.2002"])
        _registry(c, 4, "999.999", 999, ["01.01.2000"])
        _registry(c, 5, "1.1.1.1.1", None, ["01.06.2008"], active=False)
        yield c


class Host:
    def __init__(self, list_body=LIST, pages=None):
        self.calls: list[str] = []
        self.list_body = list_body
        self.pages = PAGES if pages is None else pages

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        assert request.url.host == "www3.ti.ch"
        if request.url.path.endswith("/elenco-atti"):
            return httpx.Response(200, content=self.list_body)
        rl_id = int(request.url.path.rsplit("/", 1)[1])
        if rl_id in self.pages:
            return httpx.Response(200, content=self.pages[rl_id])
        if rl_id == 999:
            return httpx.Response(404, content=b"gone")
        return httpx.Response(200, content=MISSING)


def _acts(settings, host, run_date=RUN_DATE):
    return ti_acts_stage.run(settings, transport=httpx.MockTransport(host), run_date=run_date)


def _fetch(settings, host, **kw):
    return ti_fetch_stage.run(settings, transport=httpx.MockTransport(host), interval=0, **kw)


# --- acts -----------------------------------------------------------------

def test_every_listed_act_gets_one_act_and_one_open_edition(conn, settings):
    host = Host()
    report = _acts(settings, host)
    assert host.calls == ["/CAN/RLeggi/public/index.php/raccolta-leggi/elenco-atti"]
    assert report.list_count == 17 and report.acts == 17 and report.versions == 17
    assert report.errors == 0
    assert conn.execute("SELECT count(*) FROM ch_act WHERE jurisdiction='TI'").fetchone()[0] == 17
    rows = conn.execute(
        "SELECT count(*), count(*) FILTER (WHERE stage='discovered' AND source='ti_rl' AND lang='it' "
        "AND date_end_applicability IS NULL) FROM ch_act_version").fetchone()
    assert rows == (17, 17)
    work, sr, title, status, in_force, meta = conn.execute(
        "SELECT eli_work_uri, sr_number, title_it, enforcement_status, in_force, metadata_json "
        "FROM ch_act WHERE sr_number='101.000'").fetchone()
    assert work == ti_rl.act_url(1) and title == "Costituzione della Repubblica e Cantone Ticino"
    assert status == 0 and in_force is True
    assert meta["platform"] == "ti_rl" and meta["rl_id"] == 1 and meta["lexfind_tol_id"] == 1
    assert meta["host"] == "www3.ti.ch" and meta["matched_by"] == "id"
    uri, xml_url, date_app = conn.execute(
        "SELECT eli_consolidation_uri, xml_url, date_applicability FROM ch_act_version v "
        "JOIN ch_act a USING (act_id) WHERE a.sr_number='101.000'").fetchone()
    assert uri == "ti_rl:num/1" and xml_url == ti_rl.flat_url(1)
    assert date_app == datetime.date(2023, 1, 1), "the registry's current version"


def test_matching_by_id_then_by_number_and_the_unmatched_are_counted(conn, settings):
    report = _acts(settings, Host())
    assert report.matched_by_id == 2, "101.000 and the renumbered 110.110"
    assert report.matched_by_number == 1, "110.100 has no URL in LexFind"
    assert report.unmatched == 14
    assert report.number_changed == 1
    assert report.number_changed_samples == ["num/3 portal 110.110 lexfind 110.105"]
    assert report.registry_active == 4 and report.registry_active_not_listed == 1
    assert report.dates_from_registry == 3 and report.dates_from_run_date == 14
    meta = conn.execute("SELECT metadata_json FROM ch_act WHERE sr_number='110.110'").fetchone()[0]
    assert meta["matched_by"] == "id" and meta["lexfind_systematic_number"] == "110.105"
    date_app = conn.execute(
        "SELECT date_applicability FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='120.200'").fetchone()[0]
    assert date_app == RUN_DATE


def test_a_rerun_creates_no_second_row_and_keeps_the_stage(conn, settings):
    _acts(settings, Host())
    vid = conn.execute("SELECT version_id FROM ch_act_version v JOIN ch_act a USING (act_id) "
                       "WHERE a.sr_number='101.000'").fetchone()[0]
    db.complete_version(conn, vid, "parsed", full_text="x")
    report = _acts(settings, Host(), run_date=RUN_DATE + datetime.timedelta(days=1))
    assert report.acts == 17
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 17
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 17
    assert conn.execute("SELECT stage FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()[0] == "parsed"
    # a run-date row keeps its first date across reruns
    assert conn.execute(
        "SELECT date_applicability FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='120.200'").fetchone()[0] == RUN_DATE


def test_a_moved_registry_date_reopens_the_edition_for_a_refetch(conn, settings):
    _acts(settings, Host())
    vid = conn.execute("SELECT version_id FROM ch_act_version v JOIN ch_act a USING (act_id) "
                       "WHERE a.sr_number='101.000'").fetchone()[0]
    db.complete_version(conn, vid, "parsed", full_text="x")
    conn.execute("UPDATE ch_cantonal_registry SET versions_json = %s WHERE lexfind_tol_id = 1",
                 (json.dumps([{"id": 1, "version_active_since": "01.01.2023", "is_active": False},
                              {"id": 2, "version_active_since": "01.01.2026", "is_active": True}]),))
    _acts(settings, Host())
    stage, date_app = conn.execute(
        "SELECT stage, date_applicability FROM ch_act_version WHERE version_id=%s", (vid,)).fetchone()
    assert stage == "discovered" and date_app == datetime.date(2026, 1, 1)
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 17


def test_an_abrogated_registry_match_is_not_in_force(conn, settings):
    conn.execute("UPDATE ch_cantonal_registry SET is_active = false WHERE lexfind_tol_id = 1")
    _acts(settings, Host())
    assert conn.execute("SELECT in_force FROM ch_act WHERE sr_number='101.000'").fetchone()[0] is False


def test_an_empty_list_aborts_the_run(conn, settings):
    with pytest.raises(ti_rl.TiParseError):
        _acts(settings, Host(list_body=b"<html><body>manutenzione</body></html>"))
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 0


def test_current_since_prefers_the_active_version():
    assert ti_acts_stage.current_since([
        {"version_active_since": "01.01.2011", "is_active": False},
        {"version_active_since": "01.01.2023", "is_active": True},
        {"version_active_since": "01.06.2025", "is_active": False}]) == datetime.date(2023, 1, 1)
    assert ti_acts_stage.current_since([
        {"version_active_since": "01.01.2011"}, {"version_active_since": "bad"}]) == datetime.date(2011, 1, 1)
    assert ti_acts_stage.current_since([]) is None


# --- fetch ----------------------------------------------------------------

def test_fetch_stores_the_page_and_refuses_the_not_present_body(conn, settings):
    _acts(settings, Host())
    host = Host()
    report = _fetch(settings, host, limit=4)
    assert report.fetched == 2, "ids 1 and 3 have pages"
    assert report.not_present == 2 and report.failed == 0
    assert len(host.calls) == 4 and all("/legge-piatta/num/" in c for c in host.calls)
    vid, stage, page, fetched_at = conn.execute(
        "SELECT v.version_id, v.stage, v.akn_xml, v.fetched_at FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='101.000'").fetchone()
    assert stage == "fetched" and fetched_at is not None
    assert 'id="contenutoLeggePiatta"' in page
    assert ti_fetch_stage.page_path(settings, vid).exists()
    stage, error = conn.execute(
        "SELECT v.stage, v.last_error FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='110.100'").fetchone()
    assert stage == "discovered" and error == "L'atto normativo cercato non è presente"


def test_a_404_fails_the_row(conn, settings):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                 "VALUES (99, %s, 'TI', '999.999')", (ti_rl.act_url(999),))
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
                 "xml_url, source) VALUES (99, 'ti_rl:num/999', 'it', '2000-01-01', %s, 'ti_rl')",
                 (ti_rl.flat_url(999),))
    report = _fetch(settings, Host())
    assert report.failed == 1 and report.fetched == 0
    assert "404" in conn.execute("SELECT last_error FROM ch_act_version").fetchone()[0]


def test_only_ti_rows_are_claimed_by_fetch_and_parse(conn, settings):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                 "VALUES (1, 'https://www.belex.sites.be.ch/app/de/texts_of_law/101.1', 'BE', '101.1')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
                 "xml_url, source, stage, akn_xml) VALUES (1, 'be/101.1/1', 'de', '2024-03-03', "
                 "'https://www.belex.sites.be.ch/x', 'lexwork', 'fetched', 'x'), "
                 "(1, 'be/101.1/2', 'de', '2024-03-03', 'https://www.belex.sites.be.ch/y', 'lexwork', "
                 "'discovered', NULL)")
    host = Host()
    assert _fetch(settings, host).fetched == 0 and host.calls == []
    assert ti_parse_stage.run(settings).parsed == 0
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage IN ('fetched', 'discovered')"
                        ).fetchone()[0] == 2


# --- parse ----------------------------------------------------------------

def test_parse_stores_articles_text_and_the_page_dates(conn, settings):
    _acts(settings, Host())
    _fetch(settings, Host(), limit=4)
    report = ti_parse_stage.run(settings)
    assert report.parsed == 2 and report.failed == 0
    assert report.no_articles == 0 and report.short_text == 0
    assert report.articles == 22, "the trimmed constitution has 13 articles, the decree 9"
    assert len(report.acts) == 2
    act_id, stage, count, text = conn.execute(
        "SELECT a.act_id, v.stage, v.article_count, v.full_text FROM ch_act_version v "
        "JOIN ch_act a USING (act_id) WHERE a.sr_number='101.000'").fetchone()
    assert stage == "parsed" and count == 13
    assert text.startswith("101.000\nCostituzione\n")
    rows = conn.execute(
        "SELECT article_number, marginal_note, left(text, 40), notes FROM ch_act_article ar "
        "JOIN ch_act_version v USING (version_id) WHERE v.act_id = %s ORDER BY ordinal", (act_id,)).fetchall()
    assert rows[0][:3] == ("1", "Cantone Ticino", "1 Il Cantone Ticino è una repubblica dem")
    assert [r[0] for r in rows] == ["1", "2", "3", "4", "5", "6", "7", "8", "9a", "34bis", "34ter", "67", "96"][:count]
    by_number = {r[0]: r for r in rows}
    assert len(by_number["4"][3]) == 3
    assert by_number["67"][2] == "…"
    date_document, date_entry = conn.execute(
        "SELECT date_document, date_entry_force FROM ch_act WHERE act_id=%s", (act_id,)).fetchone()
    assert date_document == datetime.date(1997, 12, 14) and date_entry == datetime.date(1998, 1, 1)


def test_short_pages_retire_and_prose_pages_parse_with_zero_articles(conn, settings):
    """12 in-force TI acts are published without an 'Art. N' paragraph (the
    F3/K9 audit, 2026-08-31): prose keeps its text as a parsed edition with
    article_count 0; only a near-empty page retires."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri, jurisdiction, sr_number) "
                 "VALUES (1, %s, 'TI', '1.1'), (2, %s, 'TI', '1.2'), (3, %s, 'TI', '1.3')",
                 (ti_rl.act_url(1), ti_rl.act_url(2), ti_rl.act_url(3)))
    wrap = ('<html><body><div id="contenutoLeggePiatta"><h2>1.1</h2><title>t</title>'
            '<div>{}</div></div></body></html>')
    no_articles = wrap.format("<p>Preambolo. " + "parola " * 60 + "</p>")
    short = wrap.format('<p><span style="font-weight:bold">Art. 1</span><span> Breve.</span></p>')
    for act_id, page in ((1, no_articles), (2, short), (3, MISSING.decode())):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                     "date_applicability, xml_url, source, stage, akn_xml) VALUES "
                     "(%s, %s, 'it', '2026-01-01', 'x', 'ti_rl', 'fetched', %s)",
                     (act_id, f"ti_rl:num/{act_id}", page))
    report = ti_parse_stage.run(settings)
    assert report.parsed == 1 and report.no_articles == 1 and report.short_text == 1
    assert report.failed == 1
    rows = dict(conn.execute("SELECT act_id, stage || ' ' || left(coalesce(last_error,''), 40) "
                             "FROM ch_act_version").fetchall())
    assert rows[1].startswith("parsed"), "prose is kept, not retired"
    assert conn.execute("SELECT article_count, length(full_text) FROM ch_act_version "
                        "WHERE act_id=1").fetchone()[0] == 0
    assert rows[2].startswith("failed short_text:")
    assert rows[3].startswith("fetched L'atto normativo"), "a parser refusal keeps its retry budget"


def test_limit_bounds_parse(conn, settings):
    _acts(settings, Host())
    _fetch(settings, Host(), limit=4)
    assert ti_parse_stage.run(settings, limit=1).parsed == 1
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE stage='fetched'").fetchone()[0] == 1


def test_parse_writes_amendment_provenance_and_change_documents(conn, settings):
    _acts(settings, Host())
    _fetch(settings, Host(), limit=4)
    report = ti_parse_stage.run(settings)
    assert report.parsed == 2
    # the trimmed constitution: 8 notes -> 8 events, every one carrying a
    # "BU {year}, {page}" reference -> 6 distinct documents
    act_id = conn.execute("SELECT act_id FROM ch_act WHERE sr_number='101.000'").fetchone()[0]
    docs = dict(conn.execute(
        "SELECT number, date_decision FROM ch_act_change_document WHERE act_id=%s",
        (act_id,)).fetchall())
    assert len(docs) == 6 and docs["BU 2018, 81"] == datetime.date(2016, 9, 25)
    # BU 2016, 193 is cited by art. 9a and 96 with the same popular-vote date
    assert docs["BU 2016, 193"] == datetime.date(2013, 9, 22)
    rows = conn.execute(
        "SELECT p.e_id, p.action, p.as_reference, p.effective_date, p.source_act_date, "
        "p.raw_note, p.change_document_id FROM ch_article_provenance p "
        "JOIN ch_act_version v USING (version_id) WHERE v.act_id=%s ORDER BY p.provenance_id",
        (act_id,)).fetchall()
    assert len(rows) == 8 and all(r[6] is not None for r in rows)
    by_eid = {}
    for r in rows:
        by_eid.setdefault(r[0], []).append(r)
    assert by_eid["art_67"][0][1] == "repealed"
    assert by_eid["art_9a"][0][1] == "inserted"
    art4 = by_eid["art_4"]
    assert [r[2] for r in art4] == ["BU 2018, 81", "BU 2011, 345", "BU 2020, 63"]
    assert art4[0][3] == datetime.date(2018, 4, 1)          # in vigore dal 1.4.2018
    assert art4[0][5].startswith("Modifica dell’art. 4 cpv. 1")
    assert report.provenance_rows >= 8 and report.change_documents >= 6
    assert report.provenance_linked >= 8


def test_reprovenance_rebuilds_from_stored_pages_without_refetching(conn, settings):
    _acts(settings, Host())
    _fetch(settings, Host(), limit=4)
    ti_parse_stage.run(settings)
    conn.execute("DELETE FROM ch_article_provenance")
    conn.execute("DELETE FROM ch_act_change_document")
    report = ti_parse_stage.run_reprovenance(settings)
    assert report.parsed == 2 and report.failed == 0
    assert conn.execute("SELECT count(*) FROM ch_article_provenance").fetchone()[0] == 8 + 1
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 6 + 1
    # a second pass converges on the same rows
    again = ti_parse_stage.run_reprovenance(settings)
    assert again.provenance_rows == report.provenance_rows
    assert conn.execute("SELECT count(*) FROM ch_article_provenance").fetchone()[0] == 8 + 1


def test_gate_f_amendment_counters_are_non_zero_for_ti(conn, settings):
    from chpipe import reports_cantonal
    _acts(settings, Host())
    _fetch(settings, Host(), limit=4)
    ti_parse_stage.run(settings)
    row = reports_cantonal.gate_f(conn, "TI")[0]
    assert row["change_documents"] == 7
    assert row["provenance_rows"] == 9 and row["provenance_linked"] == 9
    assert row["change_documents_unlinked"] == 0
