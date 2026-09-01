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

from conftest import apply_migration_200

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
                ecli text PRIMARY KEY, spider text, doc_id text, stage text,
                docket_number text)
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
                enforcement_status int,
                jurisdiction text NOT NULL DEFAULT 'CH')
        """)
        # ch_act_article (migration 197's table, which 199 indexes but does
        # not create) and migrations 199 + 200 -- see tests/conftest.py.
        # 200 is what creates ch_citation_state, which db.complete() writes
        # to on every 'extracted' and 'loaded' transition.
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        yield c


def _act(conn, sr_number, abbreviation=None, title_de=None, title_fr=None,
        title_it=None, jurisdiction="CH"):
    conn.execute(
        "INSERT INTO ch_act (sr_number, abbreviation, title_de, title_fr, "
        "title_it, jurisdiction) VALUES (%s,%s,%s,%s,%s,%s)",
        (sr_number, abbreviation, title_de, title_fr, title_it, jurisdiction))


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


def test_an_ambiguous_title_abbreviation_is_not_inserted(conn, settings):
    """"(KV)" ends the French/German title of every cantonal constitution
    under SR 131.xxx, so seeding it would map one abbreviation to 26 acts and
    a Uri court's "Art. 12 KV" would resolve to whichever one step 1 ranked
    first. An abbreviation a title parenthesis gives to more than one act in
    the same language identifies nothing, so it is not seeded at all."""
    _act(conn, "455", title_fr="Loi federale du 16 decembre 2005 sur la "
                              "protection des animaux (LPA)")
    _act(conn, "131.231", title_fr="Constitution du canton de Vaud du "
                                  "14 avril 2003 (LPA)")

    aliases_stage.run(settings)

    assert not any(a[0] == "LPA" and a[1] == "fr" and a[3] == "title_paren"
                  for a in _aliases(conn))


def test_a_unique_title_abbreviation_is_still_inserted(conn, settings):
    _act(conn, "455", title_fr="Loi federale du 16 decembre 2005 sur la "
                              "protection des animaux (LPA)")

    aliases_stage.run(settings)

    assert ("LPA", "fr", "455", "title_paren") in _aliases(conn)


def test_a_stale_title_paren_alias_is_reconciled_away_when_ambiguous(conn, settings):
    """A title_paren alias that was unique when a first run seeded it can
    become ambiguous once a later ch_act load adds a second act with the
    same title abbreviation. `ON CONFLICT DO NOTHING` only protects the
    fresh insert -- it never removes the stale row, so citations would keep
    resolving to the act that no longer uniquely owns the abbreviation
    unless the run itself reconciles the table."""
    _act(conn, "455", title_fr="Loi federale du 16 decembre 2005 sur la "
                              "protection des animaux (LPA)")
    _act(conn, "220", abbreviation="OR")

    aliases_stage.run(settings)
    assert ("LPA", "fr", "455", "title_paren") in _aliases(conn)

    _act(conn, "131.231", title_fr="Constitution du canton de Vaud du "
                                  "14 avril 2003 (LPA)")
    aliases_stage.run(settings)

    aliases = _aliases(conn)
    assert not any(a[0] == "LPA" and a[1] == "fr" and a[3] == "title_paren"
                  for a in aliases)
    # curated and fedlex_abbreviation rows are untouched by reconciliation --
    # only title_paren rows are ever deleted.
    assert ("OR", "de", "220", "fedlex_abbreviation") in aliases
    assert ("CO", "fr", "220", "curated") in aliases


def test_a_title_paren_alias_the_act_no_longer_carries_is_removed(conn, settings):
    """A title_paren row can also go stale because the act's title changed
    (a Fedlex re-publish, a corrected title) and no ch_act row claims that
    abbreviation any more. Reconciliation removes it even though there is no
    ambiguity -- it is simply not among what this run would seed."""
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source) "
        "VALUES ('OLDABBR', 'fr', '999', 'title_paren')")

    aliases_stage.run(settings)

    assert not any(a[0] == "OLDABBR" for a in _aliases(conn))


def test_the_same_abbreviation_in_two_languages_is_not_ambiguous(conn, settings):
    """Ambiguity is per (abbr, lang): one act's German and Italian titles may
    both end in the same abbreviation without either being ambiguous."""
    _act(conn, "935.62", title_de="Bundesgesetz über die Dolmetscher (DolmG)",
        title_it="Legge federale sugli interpreti (DolmG)")

    aliases_stage.run(settings)

    aliases = _aliases(conn)
    assert ("DolmG", "de", "935.62", "title_paren") in aliases
    assert ("DolmG", "it", "935.62", "title_paren") in aliases


def test_two_rows_of_the_same_act_are_not_ambiguous(conn, settings):
    """Two ch_act rows can carry the same sr_number (two editions of the same
    act). One SR number is one act, whatever the row count."""
    _act(conn, "455", title_fr="Loi federale sur la protection des animaux (LPA)")
    _act(conn, "455", title_fr="Loi federale sur la protection des animaux (LPA)")

    aliases_stage.run(settings)

    assert ("LPA", "fr", "455", "title_paren") in _aliases(conn)


def _aliases_j(conn):
    return {(r["abbr"], r["lang"], r["sr_number"], r["source"], r["jurisdiction"])
            for r in conn.execute(
                "SELECT abbr, lang, sr_number, source, jurisdiction "
                "FROM ch_act_alias").fetchall()}


def test_cantonal_titles_seed_under_their_own_canton(conn, settings):
    """A cantonal act's title_paren abbreviation lands under the canton's
    jurisdiction, not 'CH' -- and the same abbreviation in two different
    cantons is two independent aliases, not a collision (the resolver never
    offers a citation another canton's aliases)."""
    _act(conn, "E 2 05", jurisdiction="GE",
        title_fr="Loi sur l'organisation judiciaire du 26 septembre 2010 (LOJ)")
    _act(conn, "161.1", jurisdiction="VS",
        title_fr="Loi sur l'organisation de la Justice (LOJ)")

    aliases_stage.run(settings)

    aliases = _aliases_j(conn)
    assert ("LOJ", "fr", "E 2 05", "title_paren", "GE") in aliases
    assert ("LOJ", "fr", "161.1", "title_paren", "VS") in aliases


def test_cantonal_abbreviation_column_seeds_under_the_primary_language(conn, settings):
    _act(conn, "721.0", abbreviation="BauG", jurisdiction="BE",
        title_de="Baugesetz vom 9. Juni 1985")

    aliases_stage.run(settings)

    assert ("BauG", "de", "721.0", "cantonal_abbreviation", "BE") in _aliases_j(conn)


def test_a_within_canton_duplicate_abbreviation_is_not_seeded(conn, settings):
    """Unlike Fedlex's federal abbreviation column (one act's own assertion),
    the cantonal abbreviation column is scraped and demonstrably duplicated
    within a canton (AG carries 26 abbreviations claimed by two acts each on
    prod, 2026-08-31). Both sources of a canton pool into one claim map: an
    abbreviation two acts of the SAME canton claim -- whether via the
    abbreviation column, the title parentheses, or one of each -- identifies
    neither and is not seeded at all."""
    _act(conn, "210.100", abbreviation="KBüG", jurisdiction="AG",
        title_de="Einfuehrungsgesetz zum Schweizerischen Zivilgesetzbuch")
    _act(conn, "210.200", jurisdiction="AG",
        title_de="Gesetz ueber das Kantonsbürgerrecht (KBüG)")
    # The same abbreviation in ANOTHER canton stays seedable -- ambiguity is
    # per jurisdiction.
    _act(conn, "121.3", abbreviation="KBüG", jurisdiction="ZG")

    aliases_stage.run(settings)

    seeded = [a for a in _aliases_j(conn) if a[0] == "KBüG"]
    assert seeded == [("KBüG", "de", "121.3", "cantonal_abbreviation", "ZG")]


def test_the_federal_pass_no_longer_reads_cantonal_acts(conn, settings):
    """Before migration 206 the fedlex_abbreviation pass had no jurisdiction
    filter, so a cantonal act's abbreviation column leaked into the federal
    alias set (5,934 rows on prod, 2026-08-31) -- and resolved to whatever
    FEDERAL act happened to share the sr_number. The pass now reads
    jurisdiction='CH' only, and the reconcile evicts the leaked rows an
    earlier run left behind so they can re-seed under their real canton."""
    _act(conn, "220", abbreviation="OR")                       # genuine federal
    _act(conn, "210.1", abbreviation="EG ZGB", jurisdiction="ZG")
    # a pre-206 run's leaked row: cantonal abbreviation, pseudo-federal.
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source, jurisdiction) "
        "VALUES ('EG ZGB', 'de', '210.1', 'fedlex_abbreviation', 'CH')")

    aliases_stage.run(settings)

    aliases = _aliases_j(conn)
    assert ("OR", "de", "220", "fedlex_abbreviation", "CH") in aliases
    assert ("EG ZGB", "de", "210.1", "fedlex_abbreviation", "CH") not in aliases, \
        "the leaked pseudo-federal row is reconciled away"
    assert ("EG ZGB", "de", "210.1", "cantonal_abbreviation", "ZG") in aliases, \
        "and re-seeded under its real canton"


def test_a_stale_cantonal_alias_is_reconciled_away(conn, settings):
    _act(conn, "721.0", abbreviation="BauG", jurisdiction="BE")
    aliases_stage.run(settings)
    assert ("BauG", "de", "721.0", "cantonal_abbreviation", "BE") in _aliases_j(conn)

    # The canton renames the act's abbreviation; the old alias must go.
    conn.execute("UPDATE ch_act SET abbreviation = 'BauG-BE' WHERE sr_number = '721.0'")
    aliases_stage.run(settings)

    aliases = _aliases_j(conn)
    assert ("BauG", "de", "721.0", "cantonal_abbreviation", "BE") not in aliases
    assert ("BauG-BE", "de", "721.0", "cantonal_abbreviation", "BE") in aliases


def test_federal_ambiguity_is_judged_without_the_cantons(conn, settings):
    """Scoping the title pass by jurisdiction also repairs the other leak:
    a cantonal title ending in the same abbreviation as a federal one used
    to make the FEDERAL abbreviation ambiguous and suppress it. Ambiguity is
    per (jurisdiction, lang) now, so each side seeds independently."""
    _act(conn, "235.1",
        title_fr="Loi federale sur la protection des donnees (LPD)")
    _act(conn, "I 3 05", jurisdiction="GE",
        title_fr="Loi genevoise sur la protection des donnees (LPD)")

    aliases_stage.run(settings)

    aliases = _aliases_j(conn)
    assert ("LPD", "fr", "235.1", "title_paren", "CH") in aliases
    assert ("LPD", "fr", "I 3 05", "title_paren", "GE") in aliases
