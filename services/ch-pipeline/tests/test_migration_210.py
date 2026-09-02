"""Applies migration 210 to a scratch database: the stored tsvector on
ch_material, generated from title + full_text, replacing 209's expression
index. A mocked DB cannot validate SQL."""
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import MIGRATION_210, apply_migration_210

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True, row_factory=dict_row) as c:
        apply_migration_210(c)
        yield c


def test_applies_twice_and_swaps_the_index(conn):
    conn.execute(MIGRATION_210.read_text())
    names = {r["indexname"] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'ch_material'").fetchall()}
    assert "idx_ch_material_tsv" in names and "idx_ch_material_fts" not in names


def test_tsv_follows_the_text_without_a_write_from_the_stage(conn):
    conn.execute(
        "INSERT INTO ch_material (eli_work_uri, lang, material_type, type_uri, pdf_url, title) "
        "VALUES ('https://fedlex.data.admin.ch/eli/fga/2001/318', 'de', 'botschaft', 't', 'u', 'Botschaft zum Embargogesetz')")
    assert conn.execute("SELECT count(*) FROM ch_material WHERE tsv @@ plainto_tsquery('simple', 'Embargogesetz')").fetchone()["count"] == 1
    assert conn.execute("SELECT count(*) FROM ch_material WHERE tsv @@ plainto_tsquery('simple', 'Sanktionen')").fetchone()["count"] == 0
    conn.execute("UPDATE ch_material SET full_text = 'Die Durchsetzung von Sanktionen.', stage = 'parsed'")
    assert conn.execute("SELECT count(*) FROM ch_material WHERE tsv @@ plainto_tsquery('simple', 'Sanktionen')").fetchone()["count"] == 1
