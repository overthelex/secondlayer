"""lexfind_versions_stage: ch_cantonal_registry -> ch_act / ch_act_version
(source 'lexfind', stage 'discovered', xml_url = the PDF), real Postgres,
no network. Registry rows are seeded in the shape lexfind_registry_stage
writes (document order = newest first, one language per version in the
seven LexFind-only cantons, `pdf_urls` present or not)."""
import datetime as dt
import json
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import lexfind_api, reports_cantonal
from chpipe.config import Settings
from chpipe.stages import lexfind_versions_stage as stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")

D = dt.date


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


def _v(vid, since, until=None, badge="not_current", langs=("de",), with_pdf=True,
       badge_date=None, **extra):
    """One versions_json entry as the registry holds it. On prod every
    abrogated version with version_inactive_since has info_badge_date equal
    to it (2,495 of 2,495); the fixture mirrors that unless told otherwise."""
    entry = {"id": vid, "version_active_since": since, "version_inactive_since": until,
             "info_badge": badge, "info_badge_date": badge_date or until,
             "is_active": badge == "current", "languages": list(langs),
             "title": f"v{vid}", **extra}
    if with_pdf:
        entry["pdf_urls"] = {lang: lexfind_api.pdf_url(vid, lang) for lang in langs}
    return entry


def _registry(conn, tol_id, canton, sysnr, versions, active=True, title=None, category="1 Staat"):
    conn.execute(
        "INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, title, "
        "is_active, category, original_url, versions_json, version_count) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (tol_id, canton, sysnr, title or f"Act {sysnr}", active, category,
         f"https://example.org/{sysnr}", json.dumps(versions), len(versions)))


def _lexwork_act(conn, canton, sysnr, in_force=True):
    return conn.execute(
        "INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, title_de, enforcement_status, "
        "metadata_json) VALUES (%s, %s, %s, %s, %s, %s) RETURNING act_id",
        (f"https://host.{canton.lower()}/app/de/texts_of_law/{sysnr}", canton, sysnr,
         f"Host {sysnr}", 0 if in_force else 3,
         json.dumps({"platform": "lexwork"}))).fetchone()[0]


def _lexwork_version(conn, act_id, date, end=None, lang="de", stage_="parsed"):
    conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "date_end_applicability, source, stage) VALUES (%s, %s, %s, %s, %s, 'lexwork', %s)",
        (act_id, f"https://host/{act_id}/v/{date}", lang, date, end, stage_))


def _versions(conn, sysnr, canton, lang=None):
    rows = conn.execute(
        "SELECT v.lang, v.date_applicability, v.date_end_applicability, v.source, v.stage, "
        "v.xml_url, v.eli_consolidation_uri FROM ch_act_version v JOIN ch_act a USING (act_id) "
        "WHERE a.jurisdiction = %s AND a.sr_number = %s AND (%s::text IS NULL OR v.lang = %s) "
        "ORDER BY v.lang, v.date_applicability, v.date_end_applicability NULLS LAST, v.version_id",
        (canton, sysnr, lang, lang)).fetchall()
    return rows


def _open_editions(conn, canton):
    """(act_id, lang, n_open) for every act/lang of the canton with more or
    fewer than exactly one open (date_end IS NULL) edition, excluding acts
    whose editions are all shadows."""
    return conn.execute(
        "SELECT a.act_id, v.lang, count(*) FILTER (WHERE v.date_end_applicability IS NULL) AS n "
        "FROM ch_act_version v JOIN ch_act a USING (act_id) WHERE a.jurisdiction = %s "
        "GROUP BY 1, 2 HAVING count(*) FILTER (WHERE v.date_end_applicability IS NULL) <> 1",
        (canton,)).fetchall()


# --- scope 'all': the seven cantons without a Lexwork host -----------------

@pytest.fixture
def sz(conn):
    # 100.100: current + an old version that has a same-day "formless" twin
    # listed before it (SZ 172.113 on prod: ids 81436/81434 both 01.01.2014),
    # plus a version whose pdf_urls is absent (a row written before the
    # registry kept them) and a future one.
    _registry(conn, 1001, "SZ", "100.100", [
        _v(9004, "01.01.2027", badge="not_current"),
        _v(9003, "01.07.2024", badge="current"),
        _v(9002, "01.01.2013", with_pdf=False),
        _v(9001, "01.01.2005"),                       # the corrected text (doc-first)
        _v(9000, "01.01.2005"),                       # the shadow it replaced
    ], title="Verfassung des Kantons Schwyz")
    # 200.1: abrogated, its last version carries version_inactive_since
    _registry(conn, 1002, "SZ", "200.1", [
        _v(9102, "01.01.1995", until="01.01.2000", badge="abrogated"),
        _v(9101, "01.01.1990"),
    ], active=False)
    # 300.1: one version with an unparseable date, one with no language
    _registry(conn, 1003, "SZ", "300.1", [
        _v(9202, "01.01.2020", badge="current"),
        _v(9201, "irgendwann", ),
        _v(9200, "01.01.2010", langs=()),
    ])
    # 400.1: "removed" (renumbered, SZ 111.210 --> 111.200 on prod): no
    # version_inactive_since anywhere, the removal date is info_badge_date.
    # 599 such acts across the 7 cantons would otherwise keep an open edition.
    _registry(conn, 1004, "SZ", "400.1", [
        _v(9301, "01.01.2009", badge="removed", badge_date="31.12.2010"),
        _v(9300, "01.01.2000", badge="removed", badge_date="31.12.2010"),
    ], active=False)


def test_all_materialises_acts_and_every_dated_version_with_its_pdf(conn, settings, sz):
    report = stage.run(settings, canton_code="SZ", scope="all")
    c = report.by_canton["SZ"]
    assert report.scope == {"SZ": "all"} and report.errors == 0
    assert c.acts_created == 4 and c.acts_matched == 0
    assert c.versions_inserted == 10 and c.versions_updated == 0
    assert c.versions_unparseable_date == 1 and c.versions_no_pdf == 1
    assert c.versions_skipped_existing == 0 and c.versions_same_day_shadow == 1

    act = conn.execute(
        "SELECT eli_work_uri, jurisdiction, sr_number, title_de, title_fr, in_force, "
        "enforcement_status, metadata_json, stage FROM ch_act WHERE sr_number = '100.100'").fetchone()
    assert act[:7] == ("lexfind:1001", "SZ", "100.100", "Verfassung des Kantons Schwyz", None,
                       True, 0)
    assert act[7] == {"platform": "lexfind", "lexfind_tol_id": 1001, "category": "1 Staat",
                      "original_url": "https://example.org/100.100"}
    assert act[8] == "discovered"
    assert conn.execute("SELECT in_force FROM ch_act WHERE sr_number = '200.1'").fetchone()[0] is False

    rows = _versions(conn, "100.100", "SZ")
    assert [(r[1], r[2]) for r in rows] == [
        (D(2005, 1, 1), D(2004, 12, 31)),       # shadow: never in force a whole day
        (D(2005, 1, 1), D(2012, 12, 31)),
        (D(2013, 1, 1), D(2024, 6, 30)),
        (D(2024, 7, 1), D(2026, 12, 31)),
        (D(2027, 1, 1), None),                  # future, and the only open one
    ]
    assert {(r[0], r[3], r[4]) for r in rows} == {("de", "lexfind", "discovered")}
    assert rows[2][5] == "https://www.lexfind.ch/tolv/9002/de", "derived from the ids"
    assert rows[3][5] == "https://www.lexfind.ch/tolv/9003/de"
    assert rows[3][6] == "lexfind:9003/de"
    # the shadow is the doc-LATER entry (9000); the corrected text (9001) wins the range
    shadow = conn.execute("SELECT eli_consolidation_uri FROM ch_act_version "
                          "WHERE date_end_applicability = '2004-12-31'").fetchone()[0]
    assert shadow == "lexfind:9000/de"

    abrogated = _versions(conn, "200.1", "SZ")
    assert [(r[1], r[2]) for r in abrogated] == [
        (D(1990, 1, 1), D(1994, 12, 31)),
        (D(1995, 1, 1), D(1999, 12, 31)),       # until 01.01.2000, exclusive
    ]
    removed = _versions(conn, "400.1", "SZ")
    assert [(r[1], r[2]) for r in removed] == [
        (D(2000, 1, 1), D(2008, 12, 31)),       # successor wins over the act-level badge date
        (D(2009, 1, 1), D(2010, 12, 30)),       # info_badge_date 31.12.2010, exclusive
    ]
    closed = {conn.execute("SELECT act_id FROM ch_act WHERE sr_number=%s", (n,)).fetchone()[0]
              for n in ("200.1", "400.1")}
    assert _open_editions(conn, "SZ") == [(a, "de", 0) for a in sorted(closed)], \
        "abrogated and removed acts have no open edition; every other act/lang has exactly one"


def test_all_is_idempotent(conn, settings, sz):
    stage.run(settings, canton_code="SZ", scope="all")
    before = conn.execute("SELECT count(*), max(updated_at) FROM ch_act_version").fetchone()
    conn.execute("UPDATE ch_act_version SET stage = 'parsed' WHERE eli_consolidation_uri = 'lexfind:9003/de'")
    report = stage.run(settings, canton_code="SZ", scope="all")
    c = report.by_canton["SZ"]
    assert c.acts_created == 0 and c.acts_matched == 4
    assert c.versions_inserted == 0 and c.versions_updated == 10
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == before[0]
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 4
    assert conn.execute("SELECT stage FROM ch_act_version WHERE eli_consolidation_uri = "
                        "'lexfind:9003/de'").fetchone()[0] == "parsed", "stage is never touched"


def test_default_scope_follows_the_platform_and_the_env_overrides_it(conn, settings, monkeypatch):
    _registry(conn, 1, "SZ", "1.1", [_v(1, "01.01.2020", badge="current")])
    _registry(conn, 2, "BE", "1.1", [_v(2, "01.01.2020", badge="current")])
    report = stage.run(settings, canton_code="SZ,BE")
    assert report.scope == {"SZ": "all", "BE": "gaps"}
    report = stage.run(settings, canton_code="SZ,BE", scope="all")
    assert report.scope == {"SZ": "all", "BE": "all"}
    with pytest.raises(ValueError):
        stage.run(settings, canton_code="SZ", scope="everything")
    with pytest.raises(ValueError):
        stage.run(settings, canton_code="XX")


def test_a_lexfind_version_within_7_days_of_a_foreign_edition_is_skipped(conn, settings):
    """Date offsets between LexFind and a host (123 of 19,073 prod
    mismatches are within +-7 days) are the same edition, not a new one."""
    act = _lexwork_act(conn, "SZ", "5.5")
    _lexwork_version(conn, act, "2020-01-04")
    _registry(conn, 55, "SZ", "5.5", [_v(5, "01.01.2020", badge="current"),
                                      _v(4, "01.01.2010")])
    report = stage.run(settings, canton_code="SZ", scope="all")
    c = report.by_canton["SZ"]
    assert c.acts_matched == 1 and c.acts_created == 0
    assert c.versions_skipped_existing == 1 and c.versions_inserted == 1
    rows = _versions(conn, "5.5", "SZ")
    assert [(r[1], r[2], r[3]) for r in rows] == [
        (D(2010, 1, 1), D(2019, 12, 31), "lexfind"),   # closed by the host's edition
        (D(2020, 1, 4), None, "lexwork"),
    ]
    assert _open_editions(conn, "SZ") == []


# --- act matching by (jurisdiction, sr_number) ------------------------------

def test_duplicate_numbers_match_by_status_and_the_other_tol_gets_its_own_act(conn, settings):
    """BE 322.1 on prod 2026-08-26: tol 21689 (inactive, 12 versions,
    "Jugendrechtspflegegesetz") and tol 35203 (active) share the number; the
    host's act is in force, so it is 35203's. 21689 is a different act."""
    host = _lexwork_act(conn, "BE", "322.1", in_force=True)
    _lexwork_version(conn, host, "2018-01-01")
    _registry(conn, 21689, "BE", "322.1", [_v(1, "01.01.2010", until="01.01.2018",
                                              badge="abrogated")], active=False)
    _registry(conn, 35203, "BE", "322.1", [_v(2, "01.01.2018", badge="current")], active=True)
    report = stage.run(settings, canton_code="BE", scope="all")
    c = report.by_canton["BE"]
    assert c.acts_matched == 1 and c.acts_created == 1
    acts = conn.execute("SELECT eli_work_uri, in_force FROM ch_act WHERE sr_number = '322.1' "
                        "ORDER BY 1").fetchall()
    assert acts == [("https://host.be/app/de/texts_of_law/322.1", True), ("lexfind:21689", False)]
    # the host act keeps its metadata; only the new act carries lexfind's
    assert conn.execute("SELECT metadata_json FROM ch_act WHERE act_id = %s", (host,)
                        ).fetchone()[0] == {"platform": "lexwork"}
    # and the rerun finds the created act again by its eli_work_uri
    report = stage.run(settings, canton_code="BE", scope="all")
    assert report.by_canton["BE"].acts_created == 0 and report.by_canton["BE"].acts_matched == 2
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 2


def test_a_single_tol_matches_the_host_act_whatever_the_status_says(conn, settings):
    _lexwork_act(conn, "BE", "1.1", in_force=True)
    _registry(conn, 7, "BE", "1.1", [_v(1, "01.01.2000")], active=False)
    report = stage.run(settings, canton_code="BE", scope="all")
    assert report.by_canton["BE"].acts_matched == 1 and report.by_canton["BE"].acts_created == 0


def test_duplicate_numbers_with_no_host_act_each_get_an_act(conn, settings):
    """BE 423.413 / 854.15 on prod: two inactive tols, nothing on the host."""
    _registry(conn, 1, "BE", "423.413", [_v(1, "01.01.2000")], active=False)
    _registry(conn, 2, "BE", "423.413", [_v(2, "01.01.1990")], active=False)
    report = stage.run(settings, canton_code="BE", scope="gaps")
    assert report.by_canton["BE"].acts_created == 2
    assert conn.execute("SELECT count(*) FROM ch_act WHERE sr_number='423.413'").fetchone()[0] == 2


# --- scope 'gaps': the 19 Lexwork cantons -----------------------------------

@pytest.fixture
def be(conn):
    # 101.1 shared: host history 2015-01-01 .. open 2020-01-01 (de + fr);
    # LexFind lists 2022 (inside), 2015-01-04 (offset), 2010, 2005 + shadow.
    host = _lexwork_act(conn, "BE", "101.1")
    for lang in ("de", "fr"):
        _lexwork_version(conn, host, "2015-01-01", end="2019-12-31", lang=lang)
        _lexwork_version(conn, host, "2020-01-01", lang=lang, stage_="failed")
    _registry(conn, 101, "BE", "101.1", [
        _v(5, "01.01.2022", badge="current", langs=("de", "fr")),
        _v(4, "04.01.2015", langs=("de", "fr")),
        _v(3, "01.01.2010", langs=("de", "fr")),
        _v(2, "01.01.2005", langs=("de", "fr")),
        _v(1, "01.01.2005", langs=("de", "fr")),
    ])
    # 999.9: LexFind only (the host answers 404), abrogated
    _registry(conn, 999, "BE", "999.9", [
        _v(12, "01.01.2008", until="01.01.2012", badge="abrogated"),
        _v(11, "01.01.2001"),
    ], active=False)
    return host


def test_gaps_inserts_only_what_predates_the_host_history(conn, settings, be):
    report = stage.run(settings, canton_code="BE", scope="gaps")
    c = report.by_canton["BE"]
    assert report.scope == {"BE": "gaps"}
    assert c.acts_matched == 1 and c.acts_created == 1
    assert c.versions_inserted == 3 * 2 + 2       # 2010, 2005, 2005-shadow x (de, fr); 999.9 x2
    assert c.versions_skipped_existing == 2       # 04.01.2015 de+fr, offset of the host's 2015-01-01
    assert c.versions_skipped_in_history == 2     # 2022 de+fr
    assert c.versions_same_day_shadow == 2

    for lang in ("de", "fr"):
        rows = _versions(conn, "101.1", "BE", lang=lang)
        assert [(r[1], r[2], r[3]) for r in rows] == [
            (D(2005, 1, 1), D(2004, 12, 31), "lexfind"),
            (D(2005, 1, 1), D(2009, 12, 31), "lexfind"),
            (D(2010, 1, 1), D(2014, 12, 31), "lexfind"),   # host earliest - 1
            (D(2015, 1, 1), D(2019, 12, 31), "lexwork"),
            (D(2020, 1, 1), None, "lexwork"),
        ]
    only = _versions(conn, "999.9", "BE")
    assert [(r[1], r[2]) for r in only] == [(D(2001, 1, 1), D(2007, 12, 31)),
                                            (D(2008, 1, 1), D(2011, 12, 31))]
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE source = 'lexfind' "
                        "AND stage = 'discovered' AND xml_url LIKE 'https://www.lexfind.ch/tolv/%'"
                        ).fetchone()[0] == 8


def test_gaps_keeps_exactly_one_open_edition_per_act_and_lang(conn, settings, be):
    stage.run(settings, canton_code="BE", scope="gaps")
    stage.run(settings, canton_code="BE", scope="gaps")
    abrogated = conn.execute("SELECT act_id FROM ch_act WHERE sr_number = '999.9'").fetchone()[0]
    assert _open_editions(conn, "BE") == [(abrogated, "de", 0)]


def test_gaps_never_writes_inside_or_after_the_host_history(conn, settings):
    """A host with a single edition and LexFind listing later versions: the
    later ones are the host's job (delta), not a second history."""
    host = _lexwork_act(conn, "BE", "2.2")
    _lexwork_version(conn, host, "2019-01-01")
    _registry(conn, 22, "BE", "2.2", [_v(3, "01.01.2024", badge="current"),
                                      _v(2, "01.01.2021"),
                                      _v(1, "01.01.2019")])
    report = stage.run(settings, canton_code="BE", scope="gaps")
    c = report.by_canton["BE"]
    assert c.versions_inserted == 0 and c.versions_skipped_existing == 1
    assert c.versions_skipped_in_history == 2
    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE source='lexfind'").fetchone()[0] == 0


def test_gaps_is_idempotent(conn, settings, be):
    first = stage.run(settings, canton_code="BE", scope="gaps").by_canton["BE"]
    second = stage.run(settings, canton_code="BE", scope="gaps").by_canton["BE"]
    assert second.versions_inserted == 0 and second.versions_updated == first.versions_inserted
    assert second.acts_created == 0 and second.acts_matched == 2


# --- Gate F still reads sensibly with lexfind-materialised rows --------------

def test_gate_f_reports_the_source_split(conn, settings, be):
    stage.run(settings, canton_code="BE", scope="gaps")
    row = reports_cantonal.gate_f(conn, "BE")[0]
    assert row["acts_lexwork"] == 2 and row["acts_from_lexfind"] == 1
    assert row["editions_from_lexfind"] == 8
    text = reports_cantonal.format_gate_f([row])
    assert "from lexfind: acts 1, editions 8" in text


def test_report_totals_sum_the_cantons(conn, settings):
    _registry(conn, 1, "SZ", "1.1", [_v(1, "01.01.2020", badge="current")])
    _registry(conn, 2, "ZH", "1.1", [_v(2, "01.01.2020", badge="current"), _v(3, "x")])
    report = stage.run(settings, canton_code="SZ,ZH")
    total = report.total()
    assert total.acts_created == 2 and total.versions_inserted == 2
    assert total.versions_unparseable_date == 1
