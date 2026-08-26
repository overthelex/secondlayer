"""Applies migrations 197, 198 and 201 to a scratch database. A mocked DB
cannot validate SQL."""
import os
import psycopg
import pytest

from conftest import MIGRATION_201, reset_legislation_schema

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        reset_legislation_schema(c)
        yield c


def test_is_idempotent(conn):
    conn.execute(MIGRATION_201.read_text())
    conn.execute(MIGRATION_201.read_text())


def test_existing_acts_default_to_federal(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) VALUES ('eli/cc/27/317_321_377', '220')")
    assert conn.execute("SELECT jurisdiction FROM ch_act").fetchone()[0] == "CH"


def test_jurisdiction_is_checked_against_the_canton_list(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('x', 'XX')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('y', 'BE')")


def test_same_sr_number_may_exist_in_two_jurisdictions_and_twice_federally(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('a', '131.1', 'CH')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('b', '131.1', 'ZH')")
    # measured on prod 2026-08-26: "916.361.1" appears 36 times federally
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number, jurisdiction) VALUES ('c', '131.1', 'CH')")
    assert conn.execute("SELECT count(*) FROM ch_act WHERE sr_number='131.1'").fetchone()[0] == 3


def test_versions_default_to_fedlex_and_reject_unknown_sources(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('a')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, date_applicability) "
                 "SELECT act_id, 'c', 'de', '2020-01-01' FROM ch_act")
    assert conn.execute("SELECT source FROM ch_act_version").fetchone()[0] == "fedlex"
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                     "date_applicability, source) "
                     "SELECT act_id, 'd', 'de', '2020-01-01', 'pdf' FROM ch_act")


def test_change_document_is_unique_per_act_and_source_id(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('a', 'BE')")
    for _ in range(2):
        conn.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id, number) "
                     "SELECT act_id, 'BE', 2374, '25-022' FROM ch_act ON CONFLICT DO NOTHING")
    assert conn.execute("SELECT count(*) FROM ch_act_change_document").fetchone()[0] == 1


def test_provenance_can_point_at_a_change_document_and_survives_its_deletion(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, jurisdiction) VALUES ('a', 'BE')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                 "date_applicability, source) "
                 "SELECT act_id, 'c', 'de', '2020-01-01', 'lexwork' FROM ch_act")
    conn.execute("INSERT INTO ch_act_change_document (act_id, jurisdiction, source_id) "
                 "SELECT act_id, 'BE', 1 FROM ch_act")
    conn.execute("INSERT INTO ch_article_provenance (version_id, e_id, raw_note, change_document_id) "
                 "SELECT version_id, 't-0--a-1', 'x', change_document_id "
                 "FROM ch_act_version, ch_act_change_document")
    assert conn.execute("SELECT change_document_id FROM ch_article_provenance").fetchone()[0] is not None
    conn.execute("DELETE FROM ch_act_change_document")
    assert conn.execute("SELECT change_document_id FROM ch_article_provenance").fetchone()[0] is None


def test_registry_table_and_indexes_exist(conn):
    for name in ("ch_cantonal_registry", "idx_ch_cantonal_registry_canton",
                 "idx_ch_act_jur_sr", "idx_ch_act_version_source_stage"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (name,)).fetchone()[0], name
