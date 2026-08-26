"""Shared scratch-database prelude for the tests that apply migration 199.

Nine test modules stand migration 199 up against CHPIPE_TEST_DSN. The
migration indexes ch_act_article (version_id, article_number) but does not
create that table -- migration 197 does -- so every one of them had to
create a stand-in for it first, and nine verbatim copies of the same DDL is
nine places to update in lockstep when the shape changes.

The stand-in is the REAL migration-197 shape (minus the FK to
ch_act_version, which only 197 itself can create), not a narrower one: the
scratch database is shared across the whole session and `IF NOT EXISTS`
means whichever module runs first wins. A narrow stand-in left behind by an
early module would then be handed to a later one that needs `text`,
`marginal_note` or `parent_e_id`, and it would fail on a column that exists
in production. Both NOT NULL text columns carry a DEFAULT so a caller that
only cares about (version_id, article_number) can still insert without
naming them.
"""
import pathlib

# tests/conftest.py is 3 levels down from the repo root, the same derivation
# every module here uses for its own migration paths.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_199 = _REPO_ROOT / "mcp_backend/src/migrations/199_ch_citation_graph.sql"
MIGRATION_200 = _REPO_ROOT / "mcp_backend/src/migrations/200_ch_citation_state.sql"

_CH_ACT_ARTICLE = """
CREATE TABLE IF NOT EXISTS ch_act_article (
    article_id     bigserial PRIMARY KEY,
    version_id     bigint,
    e_id           text NOT NULL,
    article_number text,
    marginal_note  text,
    text           text NOT NULL DEFAULT '',
    ordinal        integer NOT NULL DEFAULT 0,
    parent_e_id    text,
    notes          text[] NOT NULL DEFAULT '{}'::text[]
)
"""


def apply_migration_199(conn) -> None:
    """Create migration 199's missing prerequisite and apply the migration.

    The caller owns its own tables (ch_court_decisions, ch_act, ...): this
    only stands up what 199 needs from OTHER migrations and then runs 199
    itself. Idempotent -- both statements are IF NOT EXISTS all the way
    down, so a module that already applied 197 for real keeps 197's table.
    """
    conn.execute(_CH_ACT_ARTICLE)
    conn.execute(MIGRATION_199.read_text())


# ---------------------------------------------------------------------------
# Whole-schema reset for the legislation side (migration 135's stand-in, then
# 197, 198 and 201). The cantonal stages read columns from all three, so a
# test that builds only 197's tables would pass against a shape production
# does not have -- the exact class of mismatch conftest's docstring above
# describes for ch_act_article.
# ---------------------------------------------------------------------------
MIGRATION_197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
MIGRATION_198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"
MIGRATION_201 = _REPO_ROOT / "mcp_backend/src/migrations/201_ch_cantonal_legislation.sql"

_LEGISLATION_TABLES = (
    "ch_cantonal_registry", "ch_article_provenance", "ch_act_change_document",
    "ch_act_as_link", "ch_as_act", "ch_act_change", "ch_act_article",
    "ch_act_version", "ch_act", "ch_legislation",
)

_CH_LEGISLATION_135 = """
CREATE TABLE IF NOT EXISTS ch_legislation (
    eli_uri text NOT NULL, lang text NOT NULL, sr_number text,
    title text, short_title text, version_date date, in_force boolean,
    date_entry_force date, date_end_validity date, akn_xml text,
    full_text text, html_url text, pdf_url text, xml_url text,
    source text DEFAULT 'fedlex', metadata_json jsonb,
    imported_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    PRIMARY KEY (eli_uri, lang))
"""


def reset_legislation_schema(conn) -> None:
    """Drop and re-create the whole CH legislation schema so a stage test
    starts from the real shape, migration 201 included."""
    for table in _LEGISLATION_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    conn.execute(_CH_LEGISLATION_135)
    for migration in (MIGRATION_197, MIGRATION_198, MIGRATION_201):
        conn.execute(migration.read_text())


def apply_migration_200(conn) -> None:
    """199 and then 200 -- the pair the citation stages actually run against.

    200 does not stand alone: it seeds ch_citation_state from the column 199
    adds to ch_court_decisions, and drops the index 199 creates. Applying it
    on its own would fail on the missing column, so every caller wants both,
    in order. Idempotent for the same reasons apply_migration_199() is, plus
    200's own emptiness guard around the seed.
    """
    apply_migration_199(conn)
    conn.execute(MIGRATION_200.read_text())
