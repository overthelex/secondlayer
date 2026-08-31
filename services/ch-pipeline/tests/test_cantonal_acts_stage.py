"""cantonal_acts_stage against a mocked Lexwork host (BE), real Postgres.

The fixture host serves three acts: 101.1 (the constitution, from the real
trimmed detail record), 152.01 and 170.11 (the same record renumbered), in
German and French. 999.9 is registered by LexFind but answers 404."""
import copy
import datetime
import json
import os
import pathlib

import httpx
import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe.config import Settings
from chpipe.http import FetchError
from chpipe.stages import cantonal_acts_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
TOL = json.loads((FIXTURES / "lexwork_be_tol_101_1.json").read_text())


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=4, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3, retry_backoff_minutes=())


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        yield c


def _detail(sysnr: str, lang: str) -> dict:
    tol = copy.deepcopy(TOL)
    t = tol["text_of_law"]
    t["systematic_number"] = sysnr
    if lang == "fr":
        t["title"] = "Constitution du canton de Berne"
    return tol


class Host:
    """A MockTransport handler for one Lexwork host, counting requests."""

    def __init__(self, bad_date: bool = False, fail: bool = False):
        self.calls: list[str] = []
        self.bad_date = bad_date
        self.fail = fail

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append(path)
        if self.fail:
            return httpx.Response(503, text="down")
        if path == "/api/de/status":
            return httpx.Response(200, json={"status": {
                "nof_tol_total": 3, "nof_tol_in_force": 3, "nof_tol_out_of_force": 0}})
        if path == "/api/de/texts_of_law/lightweight_index":
            return httpx.Response(200, json={
                "1": [{"id": 1, "systematic_number": "101.1", "title": "Verfassung",
                       "abrogated": False, "structured_document_id": 33807}],
                "2": [{"id": 2, "systematic_number": "152.01", "title": "x", "abrogated": False},
                      {"id": 3, "systematic_number": "170.11", "title": "y", "abrogated": False}]})
        if path == "/api/de/change_documents/lightweight_index":
            return httpx.Response(200, json={"c202503": [
                {"id": 2374, "number": "25-022", "document_title": "KV (Änderung vom 27.11.2023)"}]})
        for lang in ("de", "fr"):
            prefix = f"/api/{lang}/texts_of_law/"
            if path.startswith(prefix):
                sysnr = path[len(prefix):]
                if sysnr not in ("101.1", "152.01", "170.11"):
                    return httpx.Response(404, text="not found")
                payload = _detail(sysnr, lang)
                if self.bad_date and sysnr == "101.1":
                    payload["text_of_law"]["old_versions"][0]["version_dates_str"] = \
                        "Fassung ohne Datum"
                return httpx.Response(200, json=payload)
        return httpx.Response(404, text=f"unmocked {path}")


@pytest.fixture
def host():
    return Host()


def _run(settings, host, **kw):
    return cantonal_acts_stage.run(settings, canton_code="BE",
                                   transport=httpx.MockTransport(host), **kw)


def test_discovers_acts_versions_and_change_documents_for_one_canton(conn, settings, host):
    report = _run(settings, host)
    assert report.acts == 3 and report.hosts_failed == [] and report.errors == 0
    assert report.by_canton == {"BE": 3}
    act = conn.execute(
        "SELECT jurisdiction, sr_number, abbreviation, title_de, title_fr, enforcement_status, "
        "in_force, eli_work_uri, date_document, date_entry_force "
        "FROM ch_act WHERE sr_number='101.1'").fetchone()
    assert act[:7] == ("BE", "101.1", "KV", "Verfassung des Kantons Bern",
                       "Constitution du canton de Berne", 0, True)
    assert act[7] == "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1"
    assert act[8] == datetime.date(1993, 6, 6) and act[9] == datetime.date(1995, 1, 1)

    versions = conn.execute(
        "SELECT v.lang, v.date_applicability, v.date_end_applicability, v.source, v.stage, v.xml_url, "
        "eli_consolidation_uri FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='101.1' ORDER BY date_applicability, lang").fetchall()
    assert len(versions) == 6, "current + 2 old versions, de and fr"
    assert versions[0][0] == "de" and versions[1][0] == "fr"
    assert versions[0][1] == datetime.date(2024, 1, 1)
    assert versions[0][2] == datetime.date(2024, 3, 2)
    assert versions[0][3:5] == ("lexwork", "discovered")
    assert versions[0][5] == ("https://www.belex.sites.be.ch/api/de/texts_of_law/101.1"
                              "/versions/2876/show_as_json")
    assert versions[0][6] == "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1/versions/2876"
    assert versions[-1][1] == datetime.date(2026, 1, 1) and versions[-1][2] is None
    assert report.versions == 18

    docs = conn.execute(
        "SELECT d.number, d.title, d.date_publication, d.date_decision, d.pdf_url, d.jurisdiction "
        "FROM ch_act_change_document d JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='101.1' ORDER BY number").fetchall()
    assert docs[0][:4] == ("24-018", "Verfassung des Kantons Bern (KV) (Änderung vom 03.03.2024)",
                           datetime.date(2024, 4, 17), datetime.date(2024, 3, 3))
    assert docs[0][4].endswith("/pdf_file") and docs[0][5] == "BE"
    assert report.change_documents == 6


def test_registry_numbers_not_on_the_host_are_counted_not_fatal(conn, settings, host):
    conn.execute("INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, "
                 "versions_json, version_count) VALUES (1, 'BE', '999.9', '[]', 0)")
    conn.execute("INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, "
                 "versions_json, version_count) VALUES (2, 'ZH', '101', '[]', 0)")
    report = _run(settings, host)
    assert report.not_on_host == 1 and report.acts == 3 and report.errors == 0
    assert "/api/de/texts_of_law/999.9" in host.calls
    assert "/api/de/texts_of_law/101" not in host.calls, "another canton's registry is not BE's"


def test_rerun_is_idempotent_and_a_superseded_version_gains_its_end_date(conn, settings, host):
    _run(settings, host)
    conn.execute("UPDATE ch_act_version SET date_end_applicability = NULL, stage = 'parsed'")
    _run(settings, host)
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 3
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 18
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 6
    ends = conn.execute("SELECT count(*) FROM ch_act_version WHERE date_end_applicability IS NOT NULL"
                        ).fetchone()[0]
    assert ends == 12, "old versions get their (inclusive) end back from the newest observation"
    assert conn.execute("SELECT DISTINCT stage FROM ch_act_version").fetchall() == [("parsed",)], \
        "a rerun never sends an already-parsed row back to discovered"


def test_an_unreachable_host_is_reported_and_skipped(conn, settings):
    report = _run(settings, Host(fail=True))
    assert report.hosts_failed == ["BE"] and report.acts == 0 and report.errors == 0


def test_only_restricts_the_walk(conn, settings, host):
    report = _run(settings, host, only={"101.1"})
    assert report.acts == 1
    assert conn.execute("SELECT sr_number FROM ch_act").fetchall() == [("101.1",)]


def test_an_unparseable_version_date_is_counted_and_the_version_skipped(conn, settings):
    report = _run(settings, Host(bad_date=True))
    assert report.dates_unparsed == 1
    assert "Fassung ohne Datum" in report.dates_unparsed_samples[0]
    assert report.versions == 16, "18 minus the skipped version in two languages"
    assert report.acts == 3, "the act itself and its other versions are still written"


def test_an_old_version_without_an_end_in_its_string_ends_before_its_successor(conn, settings):
    """GR/VS strings carry no 'bis'; found on prod: 1,167 'current' GR editions for 591 acts."""
    class NoEnds(Host):
        def __call__(self, request):
            response = super().__call__(request)
            if request.url.path.endswith("/texts_of_law/101.1") and response.status_code == 200:
                payload = response.json()
                t = payload["text_of_law"]
                t["old_versions"][0]["version_dates_str"] = \
                    "Version in Kraft von: 03.03.2024 (wurde formlos berichtigt am: 05.05.2024) (Beschlussdatum: 03.03.2024)"
                t["old_versions"][1]["version_dates_str"] = "Version in Kraft von: 01.01.2024 (Beschlussdatum: 12.03.2023)"
                t["future_versions"] = [{"id": 9999, "version_dates_str":
                    "Zukünftige Version in Kraft ab: 01.01.2027 (Beschlussdatum: 12.05.2026)"}]
                return httpx.Response(200, json=payload)
            return response
    _run(settings, NoEnds())
    rows = conn.execute(
        "SELECT v.date_applicability, v.date_end_applicability FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.sr_number='101.1' AND v.lang='de' ORDER BY v.date_applicability").fetchall()
    assert rows == [
        (datetime.date(2024, 1, 1), datetime.date(2024, 3, 2)),
        (datetime.date(2024, 3, 3), datetime.date(2025, 12, 31)),
        (datetime.date(2026, 1, 1), None),      # the host's current_version
        (datetime.date(2027, 1, 1), None),      # a future version
    ]
    assert conn.execute("SELECT count(*) FROM ch_act_version v JOIN ch_act a USING (act_id) "
                        "WHERE a.sr_number='101.1' AND v.lang='de' AND v.date_end_applicability IS NULL "
                        "AND v.date_applicability <= current_date").fetchone()[0] == 1


def test_versions_starting_the_same_day_leave_one_current_edition(conn, settings):
    """GR 502.100 on prod: three versions dated 2011-01-01; 3,804 acts had more
    than one open-ended edition before this rule."""
    class SameDay(Host):
        def __call__(self, request):
            response = super().__call__(request)
            if request.url.path.endswith("/texts_of_law/101.1") and response.status_code == 200:
                payload = response.json()
                t = payload["text_of_law"]
                t["current_version"]["version_dates_str"] = \
                    "Aktuelle Version in Kraft seit: 01.01.2026 (Beschlussdatum: 27.11.2023)"
                t["old_versions"] = [
                    {"id": 3020, "version_dates_str": "Version in Kraft von: 01.01.2024 (Beschlussdatum: 03.03.2024)"},
                    {"id": 2876, "version_dates_str": "Version in Kraft von: 01.01.2024 (Beschlussdatum: 12.03.2023)"},
                    {"id": 2000, "version_dates_str": "Version in Kraft von: 01.01.2020 (Beschlussdatum: 12.03.2019)"},
                ]
                return httpx.Response(200, json=payload)
            return response
    _run(settings, SameDay())
    rows = conn.execute(
        "SELECT v.eli_consolidation_uri, v.date_applicability, v.date_end_applicability "
        "FROM ch_act_version v JOIN ch_act a USING (act_id) WHERE a.sr_number='101.1' AND v.lang='de' "
        "ORDER BY v.date_applicability, v.eli_consolidation_uri").fetchall()
    by_id = {r[0].rsplit("/", 1)[1]: (r[1], r[2]) for r in rows}
    assert by_id["2000"] == (datetime.date(2020, 1, 1), datetime.date(2023, 12, 31))
    assert by_id["2876"] == (datetime.date(2024, 1, 1), datetime.date(2023, 12, 31)), "replaced the same day: never in force"
    assert by_id["3020"] == (datetime.date(2024, 1, 1), datetime.date(2025, 12, 31))
    assert by_id["3147"] == (datetime.date(2026, 1, 1), None)
    assert conn.execute("SELECT count(*) FROM ch_act_version v JOIN ch_act a USING (act_id) "
                        "WHERE a.sr_number='101.1' AND v.lang='de' AND v.date_end_applicability IS NULL").fetchone()[0] == 1


def test_an_abrogated_act_is_recorded_as_no_longer_in_force(conn, settings):
    class Abrogated(Host):
        def __call__(self, request):
            response = super().__call__(request)
            if request.url.path.endswith("/texts_of_law/152.01") and response.status_code == 200:
                payload = response.json()
                payload["text_of_law"]["abrogated"] = True
                payload["text_of_law"]["abrogated_dates_str"] = "Aufgehoben per 31.12.2021"
                return httpx.Response(200, json=payload)
            return response
    _run(settings, Abrogated())
    row = conn.execute("SELECT enforcement_status, in_force, date_no_longer_in_force FROM ch_act "
                       "WHERE sr_number='152.01'").fetchone()
    assert row == (3, False, datetime.date(2021, 12, 31))


def test_a_missing_french_title_does_not_fail_the_act(conn, settings):
    class NoFrench(Host):
        def __call__(self, request):
            if request.url.path.startswith("/api/fr/"):
                return httpx.Response(500, text="boom")
            return super().__call__(request)
    report = _run(settings, NoFrench())
    assert report.acts == 3 and report.errors == 0
    assert conn.execute("SELECT title_fr FROM ch_act WHERE sr_number='101.1'").fetchone()[0] is None


def test_an_unknown_canton_code_is_a_hard_error(settings):
    with pytest.raises(ValueError):
        cantonal_acts_stage.run(settings, canton_code="ZH")


# --- change documents as the other hosts serve them ------------------------
#
# One real, trimmed texts_of_law record per host touched on 2026-08-26 (a
# fixture from one host proves nothing about another).

def _tol(name):
    return json.loads((FIXTURES / f"lexwork_{name}.json").read_text())["text_of_law"]


@pytest.mark.parametrize("canton, name, expected", [
    ("AR", "ar_tol_111_3", []),                        # the host publishes no change documents
    ("TG", "tg_tol_110", []),                          # 101 documents on the whole host, none for 110
    ("LU", "lu_tol_1", [("2013-94", datetime.date(2013, 12, 14)),
                        ("2007-30", datetime.date(2007, 7, 14))]),
    ("ZG", "zg_tol_1021_001", [("2018/003", datetime.date(2018, 1, 19))]),
])
def test_change_documents_of_each_host_upsert_with_number_and_publication_date(
        conn, canton, name, expected):
    from chpipe import cantons
    tol = _tol(name)
    act_id = cantonal_acts_stage.upsert_act(conn, cantons.ALL[canton], tol, {"de": tol["title"]})
    written = cantonal_acts_stage.upsert_change_documents(
        conn, cantons.ALL[canton], act_id, tol["change_documents"])
    rows = conn.execute("SELECT number, date_publication, date_decision FROM ch_act_change_document "
                        "WHERE act_id=%s ORDER BY change_document_id", (act_id,)).fetchall()
    assert written == len(expected)
    assert [(n, p) for n, p, _ in rows] == expected
    assert all(d is None for _, _, d in rows), "no host but BE/FR carries a decision date"


def test_a_rewalk_keeps_a_backfilled_decision_date(conn):
    from chpipe import cantons
    tol = _tol("zg_tol_1021_001")
    act_id = cantonal_acts_stage.upsert_act(conn, cantons.ALL["ZG"], tol, {"de": tol["title"]})
    cantonal_acts_stage.upsert_change_documents(conn, cantons.ALL["ZG"], act_id, tol["change_documents"])
    conn.execute("UPDATE ch_act_change_document SET date_decision='2017-12-14' WHERE act_id=%s", (act_id,))
    cantonal_acts_stage.upsert_change_documents(conn, cantons.ALL["ZG"], act_id, tol["change_documents"])
    assert conn.execute("SELECT date_decision FROM ch_act_change_document WHERE act_id=%s",
                        (act_id,)).fetchone()[0] == datetime.date(2017, 12, 14)
