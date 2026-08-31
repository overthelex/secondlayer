import os
import pathlib
import psycopg
import pytest

# Derive repo root from this file's location: services/ch-pipeline/tests/test_migration_198.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
M197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
M198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_article_provenance", "ch_act_as_link", "ch_as_act",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("DROP TABLE IF EXISTS ch_legislation CASCADE")
        c.execute("CREATE TABLE ch_legislation (eli_uri text, lang text, "
                  "PRIMARY KEY (eli_uri, lang))")
        c.execute(M197.read_text())
        c.execute(M198.read_text())
        yield c


def test_creates_the_three_tables(conn):
    for t in ("ch_as_act", "ch_act_as_link", "ch_article_provenance"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (t,)).fetchone()[0]


def test_as_act_is_unique_by_eli(conn):
    conn.execute("INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://x/1','AS')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://x/1','AS')")


def test_collection_is_constrained_to_as_and_bbl(conn):
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_as_act (eli_uri, collection) VALUES ('https://x/2','SR')")


def test_amendment_link_records_the_relation_type(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_as_act (as_id, eli_uri, collection) "
                 "VALUES (1,'https://oc/1','AS')")
    conn.execute("INSERT INTO ch_act_as_link (act_id, as_id, relation_type) "
                 "VALUES (1,1,'basic_act')")
    assert conn.execute(
        "SELECT relation_type FROM ch_act_as_link").fetchone()[0] == "basic_act"


def test_amendment_link_rejects_an_unknown_relation_type(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_as_act (as_id, eli_uri, collection) "
                 "VALUES (1,'https://oc/1','AS')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_as_link (act_id, as_id, relation_type) "
                     "VALUES (1,1,'amends_probably')")


def test_amendment_link_is_unique_per_triple(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_as_act (as_id, eli_uri, collection) "
                 "VALUES (1,'https://oc/1','AS')")
    conn.execute("INSERT INTO ch_act_as_link (act_id, as_id, relation_type) "
                 "VALUES (1,1,'basic_act')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_as_link (act_id, as_id, relation_type) "
                     "VALUES (1,1,'basic_act')")


def test_provenance_keeps_the_raw_note_alongside_the_parse(conn):
    """The parse is a best effort over prose; keeping the source text is what
    makes a wrong parse detectable later."""
    cols = {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name='ch_article_provenance'").fetchall()}
    assert {"version_id", "e_id", "action", "as_reference", "bbl_reference",
            "effective_date", "source_act_date", "raw_note"} <= cols


def test_provenance_action_is_constrained(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://cc/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, "
                 "eli_consolidation_uri, lang, date_applicability) "
                 "VALUES (1,1,'https://cc/1/2020','de','2020-01-01')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_article_provenance (version_id, e_id, action, "
                     "raw_note) VALUES (1,'art_1','tweaked','x')")


def _version(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) "
                 "VALUES ('https://x/w', '220')")
    act_id = conn.execute("SELECT act_id FROM ch_act").fetchone()[0]
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, "
                 "date_applicability, lang) VALUES (%s, 'https://x/c', "
                 "'2026-01-01', 'de')", (act_id,))
    return conn.execute("SELECT version_id FROM ch_act_version").fetchone()[0]


def test_provenance_anchor_defaults_to_article(conn):
    vid = _version(conn)
    conn.execute("INSERT INTO ch_article_provenance (version_id, e_id, raw_note) "
                 "VALUES (%s, 'art_1', 'x')", (vid,))
    assert conn.execute(
        "SELECT anchor_level, container_articles FROM ch_article_provenance"
    ).fetchone() == ("article", None)


def test_provenance_anchor_level_is_constrained(conn):
    vid = _version(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO ch_article_provenance (version_id, e_id, raw_note, "
            "anchor_level, container_articles) "
            "VALUES (%s, 'chap_7', 'x', 'chapter', 3)", (vid,))


def test_a_container_row_must_carry_its_fan_out(conn):
    vid = _version(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO ch_article_provenance (version_id, e_id, raw_note, "
            "anchor_level) VALUES (%s, 'chap_7', 'x', 'container')", (vid,))


def test_the_link_table_is_not_called_an_amendment(conn):
    """N5: nothing in this table is an amendment -- basicAct is
    establishment, rectifies a drafting correction, isFollowingAct
    succession -- and a consumer who reads the table name and not the
    COMMENT read basic_act rows as amendments."""
    assert conn.execute(
        "SELECT to_regclass('public.ch_act_amendment_link')").fetchone()[0] is None
    assert conn.execute(
        "SELECT to_regclass('public.ch_act_as_link')").fetchone()[0] is not None


def test_rerunning_over_the_old_table_name_carries_its_rows_across(conn):
    """198 is unapplied on prod, but a scratch database that ran an EARLIER
    copy of it holds the old name. The migration must end with one table,
    the new name, and the old rows in it."""
    conn.execute("DROP TABLE IF EXISTS ch_act_as_link CASCADE")
    conn.execute("""
        CREATE TABLE ch_act_amendment_link (
            link_id bigserial PRIMARY KEY,
            act_id bigint NOT NULL REFERENCES ch_act(act_id) ON DELETE CASCADE,
            as_id bigint NOT NULL REFERENCES ch_as_act(as_id) ON DELETE CASCADE,
            relation_type text NOT NULL)""")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) "
                 "VALUES ('https://x/w2', '221')")
    act_id = conn.execute("SELECT act_id FROM ch_act "
                          "WHERE sr_number='221'").fetchone()[0]
    conn.execute("INSERT INTO ch_as_act (eli_uri, collection) "
                 "VALUES ('https://x/as1','AS')")
    as_id = conn.execute("SELECT as_id FROM ch_as_act").fetchone()[0]
    conn.execute("INSERT INTO ch_act_amendment_link (act_id, as_id, relation_type) "
                 "VALUES (%s,%s,'basic_act')", (act_id, as_id))

    conn.execute(M198.read_text())

    assert conn.execute(
        "SELECT to_regclass('public.ch_act_amendment_link')").fetchone()[0] is None
    assert conn.execute(
        "SELECT act_id, as_id, relation_type FROM ch_act_as_link"
    ).fetchall() == [(act_id, as_id, "basic_act")]


def test_is_idempotent(conn):
    conn.execute(M198.read_text())


def test_is_idempotent_against_a_populated_database(conn):
    """Re-runnability is what makes editing an unapplied migration cheap;
    it stops being true the moment an ALTER or a rename is not guarded."""
    vid = _version(conn)
    conn.execute("INSERT INTO ch_article_provenance (version_id, e_id, raw_note, "
                 "anchor_level, container_articles) "
                 "VALUES (%s, 'chap_7', 'x', 'container', 3)", (vid,))
    conn.execute("INSERT INTO ch_as_act (eli_uri, collection) "
                 "VALUES ('https://x/as9','BBl')")

    conn.execute(M198.read_text())
    conn.execute(M198.read_text())

    assert conn.execute(
        "SELECT count(*) FROM ch_article_provenance").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM ch_as_act").fetchone()[0] == 1
