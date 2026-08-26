"""citations_resolve_stage: turns the raw edges citations_stage writes into
resolved ones -- abbreviation to act, act+date to edition, edition+number to
article, and BGE/docket/ECLI to a court decision. A mocked DB cannot validate
the UPDATE ... FROM SQL, so this is a scratch-database test like
test_citations_stage.py and test_migration_199.py.
"""
import os
import pathlib
from datetime import date

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe.config import Settings
from chpipe.stages import citations_resolve_stage

from conftest import apply_migration_200

# Derive repo root from this file's location: services/ch-pipeline/tests/
# test_citations_resolve_stage.py is 3 levels down from the repo root (matches
# the convention already used in tests/test_load_stage.py).
_REPO_ROOT = pathlib.Path(__file__).parent.parent.parent.parent
MIGRATION_197 = _REPO_ROOT / "mcp_backend/src/migrations/197_ch_legislation_corpus.sql"

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
        # Drop the citation-graph and legislation-corpus tables first for
        # isolation (same pattern as test_migration_199.py / test_migration_197.py),
        # then a minimal ch_court_decisions with migration 199's ALTER TABLE /
        # partial index applied on top -- that index needs doc_id, which
        # neither this stage nor the fixtures below otherwise touch.
        for t in ("ch_case_citations", "ch_legislation_citations", "ch_act_alias",
                  "ch_act_change", "ch_act_article", "ch_act_version", "ch_act",
                  "ch_court_decisions"):
            c.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        c.execute("""
            CREATE TABLE ch_court_decisions (
                ecli text PRIMARY KEY,
                spider text,
                doc_id text,
                docket_number text,
                stage text
            )
        """)
        c.execute(MIGRATION_197.read_text())
        # 197 has just created the real ch_act_article, so the helper's
        # IF NOT EXISTS stand-in is a no-op here and only 199 is applied.
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        yield c


def _act(conn, act_id, sr_number, enforcement_status=0, date_entry_force=None):
    conn.execute(
        "INSERT INTO ch_act (act_id, eli_work_uri, sr_number, enforcement_status, "
        "date_entry_force, stage) VALUES (%s, %s, %s, %s, %s, 'discovered')",
        (act_id, f"https://x/act/{act_id}", sr_number, enforcement_status, date_entry_force))


def _version(conn, version_id, act_id, lang, date_applicability, date_end_applicability=None):
    conn.execute(
        "INSERT INTO ch_act_version (version_id, act_id, eli_consolidation_uri, lang, "
        "date_applicability, date_end_applicability, stage) "
        "VALUES (%s, %s, %s, %s, %s, %s, 'parsed')",
        (version_id, act_id, f"https://x/act/{act_id}/{version_id}", lang,
         date_applicability, date_end_applicability))


def _article(conn, article_id, version_id, e_id, article_number, ordinal):
    conn.execute(
        "INSERT INTO ch_act_article (article_id, version_id, e_id, article_number, "
        "text, ordinal) VALUES (%s, %s, %s, %s, 't', %s)",
        (article_id, version_id, e_id, article_number, ordinal))


def _alias(conn, abbr, lang, sr_number, source="curated"):
    conn.execute(
        "INSERT INTO ch_act_alias (abbr, lang, sr_number, source) VALUES (%s, %s, %s, %s)",
        (abbr, lang, sr_number, source))


def _decision(conn, ecli, spider, docket_number):
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, docket_number, stage) "
        "VALUES (%s, %s, %s, 'loaded')", (ecli, spider, docket_number))


def _leg_citation(conn, from_ecli, abbr_raw, article, paragraph, lang, from_date):
    conn.execute(
        "INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article, paragraph, "
        "lang, from_date) VALUES (%s, %s, %s, %s, %s, %s)",
        (from_ecli, abbr_raw, article, paragraph, lang, from_date))


def _case_citation(conn, from_ecli, to_raw, cite_kind):
    conn.execute(
        "INSERT INTO ch_case_citations (from_ecli, to_raw, cite_kind) VALUES (%s, %s, %s)",
        (from_ecli, to_raw, cite_kind))


@pytest.fixture
def seeded(conn):
    """The brief's fixture set, verbatim: act 220 (OR/de, CO/fr), two German
    editions of it (2015-2020 and 2020-onward) each carrying an article 336,
    plus a transitional-provision duplicate of 336 in the 2015 edition that
    must lose to the top-level one; two decisions to serve as case-citation
    targets; three raw legislation edges and three raw case edges."""
    _act(conn, 1, "220", enforcement_status=0, date_entry_force=date(1912, 1, 1))
    _alias(conn, "OR", "de", "220")
    _alias(conn, "CO", "fr", "220")

    # date_end_applicability is INCLUSIVE -- 10's last day in force is
    # 2019-12-31, not 2020-01-01 (that is 20's first day). See
    # citations_resolve_stage.py's _RESOLVE_EDITIONS comment for the prod
    # evidence.
    _version(conn, 10, 1, "de", date(2015, 1, 1), date(2019, 12, 31))
    _version(conn, 20, 1, "de", date(2020, 1, 1), None)

    # Top-level article 336 in both editions, plus a transitional-provision
    # duplicate (path e_id) in the 2015 edition with a LOWER ordinal -- so a
    # naive "first by ordinal" pick would choose the transitional one.
    _article(conn, 1001, 10, "art_336", "336", 50)
    _article(conn, 1002, 10, "disp_u17/art_336", "336", 1)
    _article(conn, 2001, 20, "art_336", "336", 50)

    _decision(conn, "ECLI:BGE1", "CH_BGE", "BGE 142 III 102")
    _decision(conn, "ECLI:X", "CH_BGer", "4A_22/2017")

    _leg_citation(conn, "ECLI:A", "OR", "336", "1", "de", date(2018, 6, 1))
    _leg_citation(conn, "ECLI:B", "OR", "336", None, "de", None)
    _leg_citation(conn, "ECLI:C", "XYZ", "1", None, "de", date(2018, 6, 1))

    _case_citation(conn, "ECLI:A", "BGE 142 III 102", "bge")
    _case_citation(conn, "ECLI:A", "4A_22/2017", "docket")
    _case_citation(conn, "ECLI:A", "BGE 1 I 1", "bge")
    return conn


def _leg_rows(conn):
    return {r["from_ecli"]: r for r in conn.execute(
        "SELECT * FROM ch_legislation_citations ORDER BY from_ecli").fetchall()}


def _case_rows(conn):
    return {r["to_raw"]: r for r in conn.execute(
        "SELECT * FROM ch_case_citations ORDER BY to_raw").fetchall()}


def test_resolves_acts_editions_articles_and_cases(seeded, settings):
    report = citations_resolve_stage.run(settings)

    # All four counters mean the same thing: rows this step RESOLVED, not
    # rows it attempted. Two of the three legislation edges find an act
    # (XYZ never does), and both of those go on to find an edition and an
    # article; two of the three case edges find a decision (BGE 1 I 1 does
    # not).
    assert report.acts == 2
    assert report.editions == 2
    assert report.articles == 2
    assert report.cases == 2

    leg = _leg_rows(seeded)

    a = leg["ECLI:A"]
    assert a["sr_number"] == "220"
    assert a["act_id"] == 1
    assert a["version_id"] == 10
    assert a["match_method"] == "edition_at_date"
    assert a["article_id"] == 1001, "the top-level article, not the transitional duplicate"
    assert a["resolved"] is True

    b = leg["ECLI:B"]
    assert b["version_id"] == 20
    assert b["match_method"] == "latest_edition"
    assert b["article_id"] == 2001
    assert b["resolved"] is True

    c = leg["ECLI:C"]
    assert c["match_method"] == "unresolved_abbr"
    assert c["act_id"] is None
    assert c["article_id"] is None
    assert c["resolved"] is False

    cases = _case_rows(seeded)

    bge = cases["BGE 142 III 102"]
    assert bge["to_ecli"] == "ECLI:BGE1"
    assert bge["match_method"] == "docket_exact"
    assert bge["resolved"] is True

    docket = cases["4A_22/2017"]
    assert docket["to_ecli"] == "ECLI:X"
    assert docket["match_method"] == "docket_exact"
    assert docket["resolved"] is True

    unresolved = cases["BGE 1 I 1"]
    assert unresolved["to_ecli"] is None
    assert unresolved["match_method"] == "unresolved"
    assert unresolved["resolved"] is False


def test_running_twice_changes_nothing(seeded, settings):
    citations_resolve_stage.run(settings)
    leg_before = seeded.execute(
        "SELECT * FROM ch_legislation_citations ORDER BY from_ecli").fetchall()
    case_before = seeded.execute(
        "SELECT * FROM ch_case_citations ORDER BY to_raw").fetchall()

    second = citations_resolve_stage.run(settings)

    leg_after = seeded.execute(
        "SELECT * FROM ch_legislation_citations ORDER BY from_ecli").fetchall()
    case_after = seeded.execute(
        "SELECT * FROM ch_case_citations ORDER BY to_raw").fetchall()

    assert leg_before == leg_after
    assert case_before == case_after
    assert second.acts == 0
    assert second.editions == 0
    assert second.articles == 0
    assert second.cases == 0


def test_resolve_all_recomputes_even_terminal_rows(seeded, settings):
    """CHPIPE_CIT_RESOLVE_ALL's contract: everything is reset and
    recomputed, including rows already sitting at a terminal state like
    unresolved_abbr or unresolved -- not just rows with match_method NULL."""
    citations_resolve_stage.run(settings)

    second = citations_resolve_stage.run(settings, resolve_all=True)

    assert second.acts == 2
    assert second.editions == 2
    assert second.articles == 2
    assert second.cases == 2

    leg = _leg_rows(seeded)
    assert leg["ECLI:A"]["article_id"] == 1001
    assert leg["ECLI:C"]["match_method"] == "unresolved_abbr"

    cases = _case_rows(seeded)
    assert cases["BGE 142 III 102"]["to_ecli"] == "ECLI:BGE1"


def test_a_shared_docket_number_resolves_the_same_way_every_run(conn, settings):
    """Two CH_BGer decisions can legitimately carry the same docket_number
    (a correction, a re-published ruling). Without a final tiebreak on the
    ORDER BY, which of the two 'wins' is whatever order Postgres happens to
    return matching rows in -- not guaranteed stable across runs, and not
    even guaranteed stable within one run's plan choice. `, d.ecli` makes it
    the same answer (the lexicographically smallest ecli) every time."""
    _decision(conn, "ECLI:CH_BGer:2", "CH_BGer", "4A_99/2020")
    _decision(conn, "ECLI:CH_BGer:1", "CH_BGer", "4A_99/2020")
    _case_citation(conn, "ECLI:Z", "4A_99/2020", "docket")

    citations_resolve_stage.run(settings)
    first = conn.execute(
        "SELECT to_ecli FROM ch_case_citations WHERE from_ecli = 'ECLI:Z'"
    ).fetchone()["to_ecli"]

    conn.execute(
        "UPDATE ch_case_citations SET to_ecli = NULL, resolved = false, "
        "match_method = NULL WHERE from_ecli = 'ECLI:Z'")
    citations_resolve_stage.run(settings)
    second = conn.execute(
        "SELECT to_ecli FROM ch_case_citations WHERE from_ecli = 'ECLI:Z'"
    ).fetchone()["to_ecli"]

    assert first == second == "ECLI:CH_BGer:1"


def test_an_alias_in_another_language_still_resolves(conn, settings):
    """A citation's `lang` is a hint, not a fact: the extractor falls back to
    'de' whenever no keyword decides, so "les art. 9 et 10 LPGA" -- French
    text, no paragraph keyword -- arrives here as lang 'de'. Filtering
    ch_act_alias on the language would drop it against an alias that exists
    only under 'fr'. Language ranks candidates; it must not exclude them."""
    _act(conn, 5, "830.1", enforcement_status=0, date_entry_force=date(2003, 1, 1))
    _alias(conn, "LPGA", "fr", "830.1")
    _leg_citation(conn, "ECLI:D", "LPGA", "9", None, "de", date(2018, 6, 1))

    citations_resolve_stage.run(settings)

    row = conn.execute(
        "SELECT sr_number, act_id, match_method FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:D'").fetchone()
    assert row["sr_number"] == "830.1"
    assert row["act_id"] == 5
    assert row["match_method"] == "act_only", "no edition exists, but the act resolved"


def test_the_citations_language_still_wins_when_two_acts_share_an_abbreviation(
        conn, settings):
    """The other half of the same rule: dropping the language filter must not
    cost the language *preference*. "CP" is the French penal code and the
    Italian code of civil procedure; an Italian citation must get the Italian
    act even though the French alias would win every remaining tiebreak (same
    enforcement status, same entry-force date, lower act_id)."""
    _act(conn, 6, "311.0", enforcement_status=0, date_entry_force=date(1942, 1, 1))
    _act(conn, 7, "272", enforcement_status=0, date_entry_force=date(1942, 1, 1))
    _alias(conn, "CP", "fr", "311.0")
    _alias(conn, "CP", "it", "272")
    _leg_citation(conn, "ECLI:E", "CP", "1", None, "it", None)

    citations_resolve_stage.run(settings)

    row = conn.execute(
        "SELECT sr_number FROM ch_legislation_citations "
        "WHERE from_ecli = 'ECLI:E'").fetchone()
    assert row["sr_number"] == "272"


def test_the_counters_count_resolutions_not_attempts(conn, settings):
    """One edge that resolves and one that cannot, for each of the two entry
    points. Counting attempts made `acts`/`cases` mean something different
    from `editions`/`articles` (which only ever counted rows they actually
    updated), so a report line could not be read across its four numbers."""
    _act(conn, 8, "220", enforcement_status=0, date_entry_force=date(1912, 1, 1))
    _alias(conn, "OR", "de", "220")
    _leg_citation(conn, "ECLI:F", "OR", "1", None, "de", None)
    _leg_citation(conn, "ECLI:F", "NOPE", "1", None, "de", None)
    _decision(conn, "ECLI:T", "CH_BGer", "4A_1/2020")
    _case_citation(conn, "ECLI:F", "4A_1/2020", "docket")
    _case_citation(conn, "ECLI:F", "4A_2/2020", "docket")

    report = citations_resolve_stage.run(settings)

    assert report.acts == 1
    assert report.cases == 1
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_legislation_citations "
        "WHERE match_method = 'unresolved_abbr'").fetchone()["n"] == 1, \
        "the row that did not resolve is still stamped terminal"
    assert conn.execute(
        "SELECT count(*) AS n FROM ch_case_citations "
        "WHERE match_method = 'unresolved'").fetchone()["n"] == 1


def test_edition_end_date_is_inclusive(seeded, settings):
    """date_end_applicability is the LAST DAY an edition is in force, not
    the first day it is not: a citation dated exactly on the boundary must
    resolve to the edition that date_end_applicability names, not fall
    through to no edition at all (the pre-fix `<` predicate) and not jump
    ahead to the next edition either."""
    _leg_citation(seeded, "ECLI:BOUND_OLD", "OR", "336", None, "de", date(2019, 12, 31))
    _leg_citation(seeded, "ECLI:BOUND_NEW", "OR", "336", None, "de", date(2020, 1, 1))

    citations_resolve_stage.run(settings)

    leg = _leg_rows(seeded)
    assert leg["ECLI:BOUND_OLD"]["version_id"] == 10, \
        "2019-12-31 is the 2015 edition's last day in force -- inclusive"
    assert leg["ECLI:BOUND_OLD"]["article_id"] == 1001
    assert leg["ECLI:BOUND_NEW"]["version_id"] == 20, \
        "2020-01-01 is the 2020 edition's first day"
    assert leg["ECLI:BOUND_NEW"]["article_id"] == 2001


def test_editions_sharing_an_applicability_date_resolve_deterministically(
        seeded, settings):
    """Two parsed editions of one act can carry the same date_applicability
    (Fedlex re-publishes a correction under the date it corrects). With only
    (lang, date_applicability) in the ORDER BY, which of them the LATERAL
    returns is whatever order Postgres happened to produce -- so the same
    citation could resolve to a different edition, and therefore a different
    article_id, from one run to the next. `, v.version_id` makes the pick a
    property of the data instead of the plan."""
    _version(seeded, 30, 1, "de", date(2020, 1, 1), None)
    _article(seeded, 3001, 30, "art_336", "336", 50)

    citations_resolve_stage.run(settings)
    first = _leg_rows(seeded)["ECLI:B"]
    assert first["version_id"] == 20, "the lower version_id breaks the tie"
    assert first["article_id"] == 2001

    # Same answer when the whole corpus is resolved again from scratch.
    citations_resolve_stage.run(settings, resolve_all=True)
    second = _leg_rows(seeded)["ECLI:B"]
    assert second["version_id"] == first["version_id"]
    assert second["article_id"] == first["article_id"]
