"""Applies migration 197 to a scratch database. A mocked DB cannot validate SQL."""
import os
import pathlib
import psycopg
import pytest

# Derive repo root from this file's location: services/ch-pipeline/tests/test_migration_197.py
# is 3 levels down from the repo root
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True) as c:
        for t in ("ch_act_change", "ch_act_article", "ch_act_version",
                  "ch_act", "ch_legislation"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        # migration 135's shape, which 197 must keep working
        c.execute("""
            CREATE TABLE ch_legislation (
                eli_uri text NOT NULL, lang text NOT NULL, sr_number text,
                title text, short_title text, version_date date, in_force boolean,
                date_entry_force date, date_end_validity date, akn_xml text,
                full_text text, html_url text, pdf_url text, xml_url text,
                source text DEFAULT 'fedlex', metadata_json jsonb,
                imported_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (eli_uri, lang))
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _cols(conn, table):
    return {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
        (table,)).fetchall()}


def test_creates_the_four_tables(conn):
    for t in ("ch_act", "ch_act_version", "ch_act_article", "ch_act_change"):
        assert conn.execute("SELECT to_regclass(%s) IS NOT NULL", (t,)).fetchone()[0]


def test_act_carries_a_nullable_sr_number_and_five_title_languages(conn):
    cols = _cols(conn, "ch_act")
    assert {"act_id", "eli_work_uri", "sr_number", "in_force",
            "title_de", "title_fr", "title_it", "title_en", "title_rm",
            "abbreviation", "date_document", "date_entry_force",
            "date_no_longer_in_force", "enforcement_status"} <= cols
    nullable = conn.execute(
        "SELECT is_nullable FROM information_schema.columns "
        "WHERE table_name='ch_act' AND column_name='sr_number'").fetchone()[0]
    assert nullable == "YES", "eli/cc/1/116_97_116 has no SR notation"


def test_act_is_unique_by_eli_work_uri(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('https://x/1')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('https://x/1')")


def test_several_acts_may_share_an_sr_number(conn):
    """SR numbers are reused across superseded works; uniqueness lives on the ELI."""
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) VALUES ('https://x/1','220')")
    conn.execute("INSERT INTO ch_act (eli_work_uri, sr_number) VALUES ('https://x/2','220')")
    assert conn.execute("SELECT count(*) FROM ch_act WHERE sr_number='220'").fetchone()[0] == 2


def test_version_is_unique_by_consolidation_and_language(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                 "date_applicability) VALUES (1,'https://x/1/2020','de','2020-01-01')")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                     "date_applicability) VALUES (1,'https://x/1/2020','de','2020-01-01')")


def test_deleting_an_act_cascades_to_versions_articles_and_changes(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
                 "ordinal) VALUES (1,'art_1','1','t',1)")
    conn.execute("DELETE FROM ch_act WHERE act_id = 1")
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == 0


def test_change_type_is_constrained(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_change (act_id, e_id, change_type, "
                     "date_applicability) VALUES (1,'art_1','rewritten','2020-01-01')")


def test_article_e_id_may_be_a_path(conn):
    """Verified in the real OR XML: transitional articles carry eIds like
    'disp_u17/art_7', so article numbers repeat within one document and only the
    eId is unique."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
                 "ordinal) VALUES (1,'art_7','7','a',1)")
    conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, text, "
                 "ordinal) VALUES (1,'disp_u17/art_7','7','b',2)")
    assert conn.execute("SELECT count(*) FROM ch_act_article").fetchone()[0] == 2
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_article (version_id, e_id, article_number, "
                     "text, ordinal) VALUES (1,'art_7','7','c',3)")


def test_ch_legislation_survives_untouched(conn):
    assert conn.execute("SELECT to_regclass('ch_legislation') IS NOT NULL").fetchone()[0]


def test_is_idempotent(conn):
    conn.execute(MIGRATION.read_text())      # must not raise


def test_failed_stage_check_constraint_rejects_unknown_values(conn):
    """failed_stage should have a CHECK constraint listing legal values."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                     "lang, date_applicability, failed_stage) "
                     "VALUES (2,1,'https://x/1/2021','en','2021-01-01','unknown_stage')")


def test_failed_stage_accepts_all_five_legal_values(conn):
    """failed_stage should accept discovered, fetched, parsed, diff, and projection."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")

    for i, stage in enumerate(['discovered', 'fetched', 'parsed', 'diff', 'projection'], 2):
        conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                     "lang, date_applicability, failed_stage) "
                     "VALUES (%s, 1, %s, 'de', '2020-01-01', %s)",
                     (i, f'https://x/1/cons{i}', stage))

    assert conn.execute("SELECT count(*) FROM ch_act_version WHERE failed_stage IS NOT NULL").fetchone()[0] == 5


def test_change_table_unique_key_is_to_version_and_e_id_not_change_type(conn):
    """ux_ch_act_change key is (to_version_id, e_id): one statement per article per edition."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (2,1,'https://x/1/2021','de','2021-01-01')")

    # Insert first row: modified from version 1 to 2
    conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                 "change_type, date_applicability) "
                 "VALUES (1, 1, 2, 'art_1', 'modified', '2021-01-01')")

    # Inserting second row with same to_version_id and e_id but different from_version_id
    # should collide because the key is (to_version_id, e_id)
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                     "change_type, date_applicability) "
                     "VALUES (1, NULL, 2, 'art_1', 'modified', '2021-01-01')")


def test_change_table_unique_key_also_prevents_different_change_types(conn):
    """Two rows with same to_version_id and e_id but different change_type collide."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (2,1,'https://x/1/2021','de','2021-01-01')")

    # Insert first row
    conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                 "change_type, date_applicability) "
                 "VALUES (1, 1, 2, 'art_1', 'added', '2021-01-01')")

    # Attempting to insert second row with same to/e_id but different change_type should collide
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                     "change_type, date_applicability) "
                     "VALUES (1, 1, 2, 'art_1', 'modified', '2021-01-01')")


def test_change_table_allows_different_to_version_ids_or_e_ids(conn):
    """Rows differing in to_version_id or e_id coexist normally."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (1,1,'https://x/1/2020','de','2020-01-01')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (2,1,'https://x/1/2021','de','2021-01-01')")
    conn.execute("INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, "
                 "lang, date_applicability) VALUES (3,1,'https://x/1/2022','de','2022-01-01')")

    # Same to_version_id and change_type but different e_id: allowed
    conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                 "change_type, date_applicability) "
                 "VALUES (1, 1, 2, 'art_1', 'modified', '2021-01-01')")
    conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                 "change_type, date_applicability) "
                 "VALUES (1, 1, 2, 'art_2', 'modified', '2021-01-01')")

    # Same e_id and change_type but different to_version_id: allowed
    conn.execute("INSERT INTO ch_act_change (act_id, from_version_id, to_version_id, e_id, "
                 "change_type, date_applicability) "
                 "VALUES (1, 2, 3, 'art_1', 'modified', '2022-01-01')")

    assert conn.execute("SELECT count(*) FROM ch_act_change").fetchone()[0] == 3


# --- Finding 8: two columns nothing writes and nothing reads ---
# ch_act_version.html_url and .pdf_url were never written by any stage and
# never read by any query -- VERSIONS selects the XML manifestation's fileUrl
# and nothing else. Migration 197 is unapplied, so dropping them is clean now
# and would not be later. Widening VERSIONS to capture Fedlex's sibling
# manifestations was the alternative: rejected, because it multiplies every
# discovery batch by the four other formats for URLs no stage would use.

def test_the_version_table_ships_no_columns_nothing_writes(conn):
    """An empty url column reads as an absent format, not as a column
    nobody wired up -- the same class of quiet untruth this migration
    exists to correct."""
    cols = _cols(conn, "ch_act_version")
    assert "xml_url" in cols
    assert "html_url" not in cols
    assert "pdf_url" not in cols


def test_the_version_table_still_carries_everything_a_stage_does_write(conn):
    assert {"version_id", "act_id", "eli_consolidation_uri", "lang",
            "date_applicability", "date_end_applicability", "xml_url",
            "akn_xml", "full_text", "article_count", "stage", "attempts",
            "last_error", "failed_stage", "fetched_at", "stage_updated_at"} \
        <= _cols(conn, "ch_act_version")


# --- The stage machines and the status vocabulary, enforced not merely
# described. Every allowed set below was enumerated from the writers:
# versions_stage's INSERT, fetch_xml_stage/parse_akn_stage's
# complete_version, db.fail_version(), acts_stage's INSERT, and
# fedlex_queries.status_code(). ---

def test_version_stage_rejects_a_value_no_stage_ever_writes(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                     "date_applicability, stage) "
                     "VALUES (1,'https://x/1/2020','de','2020-01-01','loaded')")


def test_version_stage_rejects_diff_and_projection(conn):
    """failed_stage lists them; `stage` must not. diff and projection work on
    parsed rows in place and never advance them, so a row that SAT at either
    would be invisible to every claim query -- and
    db.retry_failed_versions(conn, stage='diff') is an operator one keystroke
    away from putting a whole backlog there."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    for bad in ("diff", "projection"):
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, "
                         "lang, date_applicability, stage) "
                         "VALUES (1,%s,'de','2020-01-01',%s)",
                         (f"https://x/1/{bad}", bad))


def test_version_stage_accepts_every_value_a_stage_writes(conn):
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri) VALUES (1,'https://x/1')")
    for i, stage in enumerate(("discovered", "fetched", "parsed", "failed"), 1):
        conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                     "date_applicability, stage) VALUES (1,%s,'de','2020-01-01',%s)",
                     (f"https://x/1/cons{i}", stage))
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 4


def test_act_stage_rejects_a_stage_nothing_writes(conn):
    """ch_act has no stage machine: acts_stage's INSERT writes 'discovered'
    and nothing moves it on. Widening this is a migration, not an accident."""
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act (eli_work_uri, stage) "
                     "VALUES ('https://x/1','fetched')")


def test_act_stage_accepts_the_one_value_acts_stage_writes(conn):
    conn.execute("INSERT INTO ch_act (eli_work_uri, stage) VALUES ('https://x/1','discovered')")
    conn.execute("INSERT INTO ch_act (eli_work_uri) VALUES ('https://x/2')")   # the default
    assert conn.execute("SELECT count(*) FROM ch_act WHERE stage='discovered'").fetchone()[0] == 2


@pytest.mark.parametrize("bad", [2, 4, -1, 99])
def test_enforcement_status_rejects_a_code_outside_the_verified_vocabulary(conn, bad):
    """status_code() reads whatever integer sits at the tail of the
    enforcement-status URI, and in_force is GENERATED AS
    (enforcement_status = 0) -- so an unrecognised code would have been
    rendered as "not in force" with nothing noticing."""
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO ch_act (eli_work_uri, enforcement_status) "
                     "VALUES ('https://x/1', %s)", (bad,))


def test_enforcement_status_accepts_the_three_verified_codes_and_null(conn):
    """NULL is legal on purpose: ~4,296 works publish no status, and the
    twelve works asserting two contradictory ones are stored NULL by
    acts_stage._resolve_status()."""
    for i, code in enumerate((0, 1, 3, None), 1):
        conn.execute("INSERT INTO ch_act (eli_work_uri, enforcement_status) "
                     "VALUES (%s, %s)", (f"https://x/{i}", code))
    assert conn.execute("SELECT count(*) FROM ch_act").fetchone()[0] == 4


def test_is_idempotent_with_the_new_constraints_against_a_populated_table(conn):
    """Re-applying must be a no-op even when the tables already hold rows the
    constraints have to validate again -- the shape a prod re-run has."""
    conn.execute("INSERT INTO ch_act (act_id, eli_work_uri, enforcement_status, stage) "
                 "VALUES (1,'https://x/1',0,'discovered')")
    conn.execute("INSERT INTO ch_act_version (act_id, eli_consolidation_uri, lang, "
                 "date_applicability, stage) "
                 "VALUES (1,'https://x/1/2020','de','2020-01-01','parsed')")
    conn.execute(MIGRATION.read_text())
    conn.execute(MIGRATION.read_text())
    assert conn.execute("SELECT count(*) FROM ch_act_version").fetchone()[0] == 1
