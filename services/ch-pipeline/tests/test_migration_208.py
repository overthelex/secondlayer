"""Applies migration 208 to a scratch database. A mocked DB cannot validate SQL.

208 creates ch_commentary and two indexes, nothing else, so what is worth
pinning is that it applies, applies twice as a no-op, has the shape the
stage's upsert writes and the tools read, and that (source, source_id) is
the natural key the upsert conflicts on.
"""
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from conftest import MIGRATION_208, apply_migration_208

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        c.execute("DROP TABLE IF EXISTS ch_commentary")
        yield c


def _insert(conn, source_id="u1", **over):
    row = dict(source="onlinekommentar", source_id=source_id, lang="de", kind="article",
               title="Art. 1 BV", content_html="<p>x</p>", content_text="x",
               licence="CC-BY-4.0", source_url="https://onlinekommentar.ch/x",
               content_hash="h")
    row.update(over)
    cols = ", ".join(row)
    vals = ", ".join(f"%({k})s" for k in row)
    conn.execute(f"INSERT INTO ch_commentary ({cols}) VALUES ({vals})", row)


def test_applies_and_is_idempotent(conn):
    apply_migration_208(conn)
    conn.execute(MIGRATION_208.read_text())
    cols = {r["column_name"] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'ch_commentary'").fetchall()}
    assert cols == {"id", "source", "source_id", "lang", "kind", "sr_number", "act_uuid",
                    "act_title", "abbr", "article_number", "title", "authors", "editors",
                    "version_date", "suggested_citation", "content_html", "content_text",
                    "legal_text", "licence", "source_url", "pdf_url", "content_hash",
                    "fetched_at", "last_seen_at"}
    names = {r["indexname"] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'ch_commentary'").fetchall()}
    assert {"idx_ch_commentary_act", "idx_ch_commentary_fts"} <= names


def test_source_and_source_id_are_the_key(conn):
    apply_migration_208(conn)
    _insert(conn, "u1")
    _insert(conn, "u1", source="openlegalcommentary")     # another source may reuse an id
    with pytest.raises(psycopg.errors.UniqueViolation):
        _insert(conn, "u1")


def test_lang_and_kind_are_checked(conn):
    apply_migration_208(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, "u2", lang="rm")
    with pytest.raises(psycopg.errors.CheckViolation):
        _insert(conn, "u3", kind="chapter")


def test_fts_index_serves_a_simple_query(conn):
    apply_migration_208(conn)
    _insert(conn, "u1", content_text="Die Fintech-Lizenz nach Art. 1b BankG")
    hit = conn.execute(
        "SELECT source_id FROM ch_commentary WHERE to_tsvector('simple', coalesce(title, '') "
        "|| ' ' || coalesce(content_text, '')) @@ plainto_tsquery('simple', %s)",
        ("Fintech-Lizenz",)).fetchall()
    assert [r["source_id"] for r in hit] == ["u1"]
