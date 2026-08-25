"""aliases_stage.run(): seeds ch_act_alias from ch_act.abbreviation, the
title parentheses, and the curated map.

Run against a throwaway database, never against prod:
    CHPIPE_TEST_DSN=postgresql://postgres@127.0.0.1:55432/chpipe_test \
        python3 -m pytest services/ch-pipeline/tests/test_aliases_stage.py
"""
import os
import pathlib

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.config import Settings
from chpipe.stages import aliases_stage

# Derive repo root from this file's location: services/ch-pipeline/tests/…
# is 3 levels down from the repo root -- same convention as
# test_as_bbl_stage.py and test_migration_199.py.
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION = _REPO_ROOT / "mcp_backend/src/migrations/199_ch_citation_graph.sql"

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def settings():
    return Settings(dsn=os.environ["CHPIPE_TEST_DSN"], raw_dir=pathlib.Path("/tmp"),
                    http_concurrency=1, cpu_workers=1, ocr_workers=1,
                    load_ceiling=0.0, max_attempts=3)


@pytest.fixture
def conn(settings):
    with psycopg.connect(settings.dsn, autocommit=True, row_factory=dict_row) as c:
        for t in ("ch_act_alias", "ch_case_citations", "ch_legislation_citations",
                  "ch_court_decisions", "ch_act"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        # minimal shape of migration 196's ch_court_decisions, just enough
        # for migration 199's ALTER TABLE / partial index -- same fixture
        # shape as test_migration_199.py.
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY, spider text, doc_id text, stage text)
        """)
        # minimal shape of migration 197's ch_act -- just the columns
        # aliases_stage reads.
        c.execute("""
            CREATE TABLE ch_act (
                act_id bigserial PRIMARY KEY,
                sr_number text,
                abbreviation text,
                title_de text,
                title_fr text,
                title_it text,
                enforcement_status int)
        """)
        c.execute(MIGRATION.read_text())
        yield c


def _act(conn, sr_number, abbreviation=None, title_de=None, title_fr=None,
        title_it=None):
    conn.execute(
        "INSERT INTO ch_act (sr_number, abbreviation, title_de, title_fr, "
        "title_it) VALUES (%s,%s,%s,%s,%s)",
        (sr_number, abbreviation, title_de, title_fr, title_it))


def _aliases(conn):
    return {(r["abbr"], r["lang"], r["sr_number"], r["source"])
            for r in conn.execute(
                "SELECT abbr, lang, sr_number, source FROM ch_act_alias").fetchall()}


def test_seeds_all_three_sources(conn, settings):
    _act(conn, "220", abbreviation="OR")
    _act(conn, "235.1",
        title_fr="Loi federale du 25 septembre 2020 sur la protection "
                 "des donnees (LPD)")
    _act(conn, "272",
        title_it="Codice di procedura civile del 19 dicembre 2008 "
                 "(Codice di procedura civile, CPC)")

    report = aliases_stage.run(settings)

    aliases = _aliases(conn)
    # 220/de/OR is discovered by ch_act.abbreviation first, so the curated
    # map's identical (abbr, lang, sr_number) triple collides on the primary
    # key and contributes nothing new -- fedlex_abbreviation is the source
    # of record for that slot, exactly the ON CONFLICT DO NOTHING contract.
    assert ("OR", "de", "220", "fedlex_abbreviation") in aliases
    assert ("LPD", "fr", "235.1", "title_paren") in aliases
    assert ("CPC", "it", "272", "title_paren") in aliases
    # fr/it have no other source for 220, so the curated map's CO entries
    # for those two languages land as-is.
    assert ("CO", "fr", "220", "curated") in aliases
    assert ("CO", "it", "220", "curated") in aliases

    assert report.inserted > 0
    assert report.total == len(aliases)


def test_running_twice_inserts_nothing_new(conn, settings):
    _act(conn, "220", abbreviation="OR")
    _act(conn, "235.1",
        title_fr="Loi federale du 25 septembre 2020 sur la protection "
                 "des donnees (LPD)")
    _act(conn, "272",
        title_it="Codice di procedura civile del 19 dicembre 2008 "
                 "(Codice di procedura civile, CPC)")

    first = aliases_stage.run(settings)
    before = _aliases(conn)
    second = aliases_stage.run(settings)
    after = _aliases(conn)

    assert second.inserted == 0
    assert before == after
    assert second.total == first.total


def test_a_title_without_parentheses_contributes_no_alias(conn, settings):
    _act(conn, "210", title_de="Schweizerisches Zivilgesetzbuch vom "
                              "10. Dezember 1907")
    aliases_stage.run(settings)
    assert not any(a[2] == "210" and a[3] == "title_paren"
                  for a in _aliases(conn))
    # but the curated ZGB alias is still there
    assert ("ZGB", "de", "210", "curated") in _aliases(conn)


def test_curated_rows_land_even_with_no_matching_ch_act_row(conn, settings):
    """The curated map is seeded unconditionally -- ch_act_alias has no FK
    to ch_act, so a curated row for an SR number this scratch ch_act does
    not carry is exactly what a fresh, mostly-empty corpus looks like."""
    aliases_stage.run(settings)
    aliases = _aliases(conn)
    assert ("BV", "de", "101", "curated") in aliases
    assert ("Cst.", "fr", "101", "curated") in aliases
    assert ("Cst", "fr", "101", "curated") in aliases


def test_report_total_matches_the_table(conn, settings):
    report = aliases_stage.run(settings)
    assert report.total == conn.execute(
        "SELECT count(*) AS n FROM ch_act_alias").fetchone()["n"]
