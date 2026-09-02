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
MIGRATION_206 = _REPO_ROOT / "mcp_backend/src/migrations/206_ch_cantonal_aliases.sql"

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
# 197, 198, 201 and 204). The cantonal stages read columns from all three, so
# a test that builds only 197's tables would pass against a shape production
# does not have -- the exact class of mismatch conftest's docstring above
# describes for ch_act_article.
# ---------------------------------------------------------------------------
MIGRATION_197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"
MIGRATION_198 = _REPO_ROOT / "mcp_backend/src/migrations/198_ch_as_bbl.sql"
MIGRATION_201 = _REPO_ROOT / "mcp_backend/src/migrations/201_ch_cantonal_legislation.sql"
MIGRATION_203 = _REPO_ROOT / "mcp_backend/src/migrations/203_ch_cantonal_sources.sql"
# 204 re-adds the ch_act_version.source CHECK as a superset of 203's list, so
# the pair applies cleanly in this order (and 204 alone applies cleanly on a
# database that never saw 203 -- prod recorded 203 by hand).
MIGRATION_204 = _REPO_ROOT / "mcp_backend/src/migrations/204_ch_fedlex_pdf.sql"

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
    starts from the real shape, migrations 201 and 204 included."""
    for table in _LEGISLATION_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    conn.execute(_CH_LEGISLATION_135)
    for migration in (MIGRATION_197, MIGRATION_198, MIGRATION_201, MIGRATION_203,
                      MIGRATION_204):
        conn.execute(migration.read_text())


MIGRATION_207 = _REPO_ROOT / "mcp_backend/src/migrations/207_ch_decision_index.sql"


def apply_migration_207(conn) -> None:
    """199 and then 207 -- decision_index_stage reads ch_case_citations (199)
    and writes ch_decision_index (207), so its tests want both, in order.
    Idempotent for the same reasons apply_migration_199() is."""
    apply_migration_199(conn)
    conn.execute(MIGRATION_207.read_text())


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
    # 206 (cantonal aliases) alters two tables 199 creates -- ch_act_alias
    # gains jurisdiction, ch_legislation_citations a partial index -- so the
    # citation stack a test stands up is 199 + 200 + 206, in order.
    conn.execute(MIGRATION_206.read_text())


# --- migration 202 (ch_zefix_* / ch_shab_*) --------------------------------
# Same problem, same shape: 202 ALTERs ch_zefix_companies and
# ch_shab_publications, which migration 129 creates, and adding indexes to a
# table that does not exist fails. The stand-ins below are the columns 202
# touches plus the ones a stage actually writes; 129 also creates a dozen
# unrelated tables (nl_insolvency, ch_finma_regulated, ...) that have nothing
# to do with 202, so applying 129 verbatim here would be dead weight.
#
# tests/test_migration_202.py keeps its own copy on purpose: it DROPs both
# tables first so it can assert on a database in a known state, while callers
# of this helper only want the tables to exist.
MIGRATION_202 = _REPO_ROOT / "mcp_backend/src/migrations/202_ch_registries.sql"

_CH_ZEFIX_COMPANIES = """
CREATE TABLE IF NOT EXISTS ch_zefix_companies (
    uid              text PRIMARY KEY,
    name             text NOT NULL,
    legal_form       text,
    legal_seat       text,
    register_office  text,
    status           text,
    purpose          text,
    capital          numeric,
    capital_currency text,
    address          text,
    canton           text,
    chid             text,
    ehraid           integer,   -- migration 129's type; ehraid_from_iri() returns
                                --  a string, so the upsert casts explicitly
    shab_pub_date    date,
    metadata_json    jsonb,
    imported_at      timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
)
"""

_CH_SHAB_PUBLICATIONS = """
CREATE TABLE IF NOT EXISTS ch_shab_publications (
    id               serial PRIMARY KEY,
    shab_id          text UNIQUE,
    publication_date date,
    publication_type text,
    rubric           text,
    sub_rubric       text,
    company_uid      text,
    company_name     text,
    canton           text,
    content          text,
    metadata_json    jsonb,
    imported_at      timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
)
"""


def apply_migration_202(conn) -> None:
    """Stand up migration 129's two registry tables if they are absent, then
    apply 202. Idempotent all the way down."""
    conn.execute(_CH_ZEFIX_COMPANIES)
    conn.execute(_CH_SHAB_PUBLICATIONS)
    conn.execute(MIGRATION_202.read_text())


# --- migration 208 (ch_commentary) -----------------------------------------
# 208 creates one table and two indexes and depends on nothing; what
# commentary_stage ALSO reads is ch_act_alias (199 + 206's jurisdiction
# column), so the stand-in below is that table in its 206 shape -- the same
# reasoning as _CH_ACT_ARTICLE above: the real columns, not a narrower set.
MIGRATION_208 = _REPO_ROOT / "mcp_backend/src/migrations/208_ch_commentary.sql"

_CH_ACT_ALIAS = """
CREATE TABLE IF NOT EXISTS ch_act_alias (
    abbr         text NOT NULL,
    lang         text NOT NULL,
    sr_number    text NOT NULL,
    source       text NOT NULL,
    jurisdiction text NOT NULL DEFAULT 'CH',
    PRIMARY KEY (abbr, lang, sr_number, jurisdiction)
)
"""


def apply_migration_208(conn) -> None:
    """ch_act_alias stand-in, then 208. Idempotent: IF NOT EXISTS throughout."""
    conn.execute(_CH_ACT_ALIAS)
    conn.execute(MIGRATION_208.read_text())


# --- migration 209 (ch_material) -------------------------------------------
# 209 references ch_as_act (198), which in turn needs 197: the whole
# legislation schema, so the helper is reset_legislation_schema() + 209.
MIGRATION_209 = _REPO_ROOT / "mcp_backend/src/migrations/209_ch_material.sql"


def apply_migration_209(conn) -> None:
    reset_legislation_schema(conn)
    conn.execute("DROP TABLE IF EXISTS ch_material CASCADE")
    conn.execute(MIGRATION_209.read_text())
