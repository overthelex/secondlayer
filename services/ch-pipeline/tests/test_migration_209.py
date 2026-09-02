"""Applies migration 209 to a scratch database. A mocked DB cannot validate SQL."""
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import MIGRATION_209, apply_migration_209

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        apply_migration_209(c)
        yield c


def _insert(conn, lang="de", eli="https://fedlex.data.admin.ch/eli/fga/2001/318", **over):
    row = dict(eli_work_uri=eli, lang=lang, material_type="botschaft", type_uri="t",
               pdf_url="https://fedlex.data.admin.ch/filestore/x.pdf")
    row.update(over)
    cols = ", ".join(row)
    vals = ", ".join(f"%({k})s" for k in row)
    conn.execute(f"INSERT INTO ch_material ({cols}) VALUES ({vals})", row)


def test_applies_twice_and_has_the_shape_the_stages_write(conn):
    conn.execute(MIGRATION_209.read_text())
    cols = {r["column_name"] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'ch_material'").fetchall()}
    assert cols >= {"material_id", "eli_work_uri", "lang", "material_type", "type_uri", "title",
                    "historical_id", "bbl_key", "memorial_year", "memorial_page", "date_document",
                    "publication_date", "as_id", "pdf_url", "stage", "attempts", "last_error",
                    "stage_updated_at", "full_text", "text_quality", "pdf_bytes", "fetched_at"}
    names = {r["indexname"] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'ch_material'").fetchall()}
    assert {"idx_ch_material_queue", "idx_ch_material_bbl_key", "idx_ch_material_type_date",
            "idx_ch_material_fts"} <= names


def test_work_and_language_are_the_key_and_the_checks_hold(conn):
    _insert(conn, "de")
    _insert(conn, "fr")
    with pytest.raises(psycopg.errors.UniqueViolation):
        _insert(conn, "de")
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, "en")
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, "it", material_type="gesetz")
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, "it", stage="queued")


def test_as_id_link_is_nullable_and_nulled_on_delete(conn):
    as_id = conn.execute(
        "INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://fedlex.data.admin.ch/eli/fga/2001/318', 'BBl') "
        "RETURNING as_id").fetchone()["as_id"]
    _insert(conn, "de", as_id=as_id)
    conn.execute("DELETE FROM ch_as_act WHERE as_id = %s", (as_id,))
    assert conn.execute("SELECT as_id FROM ch_material").fetchone()["as_id"] is None


def test_fts_index_expression_serves_a_query_over_title_and_text(conn):
    _insert(conn, "de", title="Botschaft zum Embargogesetz", full_text="Die Durchsetzung von Sanktionen.")
    hit = conn.execute(
        "SELECT lang FROM ch_material WHERE to_tsvector('simple', left(coalesce(title, '') || ' ' || "
        "coalesce(full_text, ''), 900000)) @@ plainto_tsquery('simple', %s)", ("Sanktionen",)).fetchall()
    assert [r["lang"] for r in hit] == ["de"]
