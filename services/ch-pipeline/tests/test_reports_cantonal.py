"""Gate F on a seeded scratch database."""
import json
import os
import pathlib

import psycopg
import pytest
from conftest import reset_legislation_schema

from chpipe import reports_cantonal
from chpipe.config import Settings
from chpipe.stages import reports_cantonal_stage

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


def _act(conn, code, sysnr, in_force=True):
    return conn.execute(
        "INSERT INTO ch_act (eli_work_uri, jurisdiction, sr_number, enforcement_status) "
        "VALUES (%s, %s, %s, %s) RETURNING act_id",
        (f"{code}/{sysnr}", code, sysnr, 0 if in_force else 3)).fetchone()[0]


def _version(conn, act_id, date, stage="parsed", lang="de", text="x" * 500, count=3,
             error=None, source="lexwork"):
    return conn.execute(
        "INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability, "
        "source, stage, full_text, article_count, last_error) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING version_id",
        (act_id, f"{act_id}/{date}/{lang}", lang, date, source, stage, text, count, error)).fetchone()[0]


def _registry(conn, tol_id, code, sysnr, dates, active=True):
    conn.execute(
        "INSERT INTO ch_cantonal_registry (lexfind_tol_id, canton, systematic_number, is_active, "
        "versions_json, version_count) VALUES (%s, %s, %s, %s, %s, %s)",
        (tol_id, code, sysnr, active,
         json.dumps([{"version_active_since": d} for d in dates]), len(dates)))


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True) as c:
        reset_legislation_schema(c)
        # BE: 101.1 on both sides (3 of our 4 editions match LexFind's dates),
        # 152.01 ours only, 999.9 LexFind only (abrogated there).
        a = _act(c, "BE", "101.1")
        for d in ("2020-01-01", "2022-01-01", "2024-03-03", "2026-01-01", "2099-09-01"):
            _version(c, a, d)
            _version(c, a, d, lang="fr")
        _version(c, a, "2019-01-01", stage="failed", error="language 'de' not in payload (fr)")
        _version(c, a, "2018-01-01", stage="parsed", text="short", count=0)
        b = _act(c, "BE", "152.01")
        _version(c, b, "2021-01-01", stage="discovered")
        _registry(c, 1, "BE", "101.1", ["01.01.2020", "01.01.2022", "03.03.2024", "01.05.2025"])
        _registry(c, 2, "BE", "999.9", ["01.01.2000"], active=False)
        # amendments on 101.1
        vs = c.execute("SELECT version_id FROM ch_act_version WHERE act_id=%s AND lang='de' "
                       "ORDER BY date_applicability", (a,)).fetchall()
        c.execute("INSERT INTO ch_act_change (act_id, lang, from_version_id, to_version_id, e_id, "
                  "change_type, date_applicability) VALUES (%s, 'de', %s, %s, 'a-1', 'modified', "
                  "'2022-01-01')", (a, vs[2][0], vs[3][0]))
        c.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number) "
                  "VALUES (%s, 'BE', 1, '22-1'), (%s, 'BE', 2, '24-1')", (a, a))
        linked = c.execute("SELECT change_document_id FROM ch_act_change_document WHERE source_id=1"
                           ).fetchone()[0]
        c.execute("INSERT INTO ch_article_provenance (version_id, e_id, raw_note, change_document_id) "
                  "VALUES (%s, 'a-1', 'x', %s), (%s, 'a-2', 'y', NULL)", (vs[3][0], linked, vs[3][0]))
        # ZG: nothing loaded, one registry entry
        _registry(c, 3, "ZG", "111.1", ["01.01.2010"])
        # GE (SIL): one parsed sil edition dated from LexFind, one retired
        # without articles, one lexwork-sourced stray that must NOT count
        g = _act(c, "GE", "A 1 01")
        _version(c, g, "2013-06-01", lang="fr", source="sil")
        _version(c, g, "2013-06-02", lang="fr", source="sil", stage="failed",
                 error="no_articles: 812 chars of text, no Art. heading")
        _version(c, g, "2013-06-03", lang="fr", source="lexwork")
        _registry(c, 4, "GE", "A 1 01", ["19.05.1815", "01.06.2013"])
        _registry(c, 5, "GE", "A 1 02", ["01.01.1900"], active=False)
        yield c


def test_acts_are_compared_by_systematic_number_with_both_differences(conn):
    row = reports_cantonal.gate_f(conn, "BE")[0]
    assert row["acts_lexwork"] == 2 and row["acts_lexfind"] == 2
    assert row["in_force_lexwork"] == 2 and row["active_lexfind"] == 1
    assert row["only_in_lexfind"] == ["999.9"] and row["only_in_lexfind_count"] == 1
    assert row["only_in_lexwork"] == ["152.01"] and row["only_in_lexwork_count"] == 1


def test_editions_are_compared_by_date_on_shared_acts_in_the_first_language(conn):
    row = reports_cantonal.gate_f(conn, "BE")[0]
    assert row["versions_lexwork"] == 8, "de rows of BE only: 5 + failed + short + 152.01's"
    assert row["versions_lexfind"] == 5
    assert row["date_matches"] == 3
    assert row["date_mismatches"] == 2, "2026-01-01 and 2018 are parsed but not in LexFind; the failed 2019 row is not compared"
    assert row["date_future"] == 1, "2099-09-01 is not a mismatch, LexFind lists in-force versions only"


def test_quality_counters_and_failure_reasons(conn):
    row = reports_cantonal.gate_f(conn, "BE")[0]
    assert row["parsed"] == 11 and row["failed"] == 1 and row["pending"] == 1
    assert row["empty_articles"] == 1 and row["short_text"] == 1
    assert row["failed_by_reason"] == {"language 'de' not in payload (fr)": 1}


def test_amendment_counters(conn):
    row = reports_cantonal.gate_f(conn, "BE")[0]
    assert row["changes"] == 1
    assert row["provenance_rows"] == 2 and row["provenance_linked"] == 1
    assert row["change_documents"] == 2 and row["change_documents_unlinked"] == 1


def test_all_text_cantons_are_reported_and_an_empty_one_reads_as_zero(conn):
    rows = reports_cantonal.gate_f(conn)
    assert [r["canton"] for r in rows] == sorted(
        c for c in ("AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "LU", "NE", "NW",
                    "OW", "SG", "SH", "SO", "TG", "UR", "VS", "ZG"))
    zg = next(r for r in rows if r["canton"] == "ZG")
    assert zg["acts_lexwork"] == 0 and zg["acts_lexfind"] == 1
    assert zg["only_in_lexfind"] == ["111.1"] and zg["versions_lexfind"] == 1


def test_the_stage_prints_one_block_per_canton(conn, settings, capsys):
    result = reports_cantonal_stage.run(settings, canton_code="BE")
    assert result.text.startswith("Gate F")
    assert "BE: acts lexwork 2 (in force 2) / lexfind 2 (active 1)" in result.text
    assert "dates match 3 / mismatch 2 / future 1" in result.text


def test_a_sil_canton_is_filtered_on_its_own_source(conn):
    row = reports_cantonal.gate_f(conn, "GE")[0]
    assert row["source"] == "sil"
    assert row["acts_lexwork"] == 1 and row["acts_lexfind"] == 2 and row["only_in_lexfind"] == ["A 1 02"]
    assert row["versions_lexwork"] == 2, "the lexwork-sourced stray is not a GE sil edition"
    assert row["versions_lexfind"] == 3
    assert row["date_matches"] == 1 and row["date_mismatches"] == 0
    assert row["parsed"] == 1 and row["failed"] == 1 and row["pending"] == 0
    assert row["failed_by_reason"] == {"no_articles: 812 chars of text, no Art. heading": 1}
    assert "GE: acts sil 1 (in force 1) / lexfind 2 (active 1)" in reports_cantonal.format_gate_f([row])
