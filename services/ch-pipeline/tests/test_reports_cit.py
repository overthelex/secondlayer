"""reports_cit.summary(): the citation graph's own numbers. A mocked DB
cannot validate the GROUP BY / FILTER SQL, so this is a scratch-database
test like test_citations_stage.py and test_citations_resolve_stage.py.
"""
import json
import os

import psycopg
import pytest
from psycopg.rows import dict_row

from chpipe import reports_cit

from conftest import apply_migration_200

pytestmark = pytest.mark.skipif(
    not os.environ.get("CHPIPE_TEST_DSN"), reason="CHPIPE_TEST_DSN not set")


@pytest.fixture
def conn():
    with psycopg.connect(os.environ["CHPIPE_TEST_DSN"], autocommit=True,
                         row_factory=dict_row) as c:
        for t in ("ch_case_citations", "ch_legislation_citations", "ch_act_alias",
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
        # ch_act_article (migration 197's table, which 199 indexes but does
        # not create) and migrations 199 + 200 -- see tests/conftest.py.
        # 200 is what creates ch_citation_state, which db.complete() writes
        # to on every 'extracted' and 'loaded' transition.
        c.execute("DROP TABLE IF EXISTS ch_citation_state")
        apply_migration_200(c)
        yield c


def _decision(conn, ecli, stage, stamped, attempts=0):
    """A decision plus its citation-queue row (ch_citation_state, migration
    200). The stamp lives on the queue row, not on the decision -- the
    decisions table is never written by the citation stages."""
    conn.execute(
        "INSERT INTO ch_court_decisions (ecli, spider, stage) "
        "VALUES (%s, 'CH_BGer', %s)", (ecli, stage))
    conn.execute(
        "INSERT INTO ch_citation_state (ecli, extracted_at, attempts) "
        "VALUES (%s, CASE WHEN %s THEN now() END, %s)",
        (ecli, stamped, attempts))


def _case_citation(conn, from_ecli, to_raw, cite_kind, resolved, match_method):
    conn.execute(
        "INSERT INTO ch_case_citations (from_ecli, to_raw, cite_kind, resolved, "
        "match_method) VALUES (%s, %s, %s, %s, %s)",
        (from_ecli, to_raw, cite_kind, resolved, match_method))


def _leg_citation(conn, from_ecli, abbr_raw, article, lang, resolved, match_method):
    conn.execute(
        "INSERT INTO ch_legislation_citations (from_ecli, abbr_raw, article, lang, "
        "resolved, match_method) VALUES (%s, %s, %s, %s, %s, %s)",
        (from_ecli, abbr_raw, article, lang, resolved, match_method))


@pytest.fixture
def seeded(conn):
    _decision(conn, "ECLI:1", "loaded", stamped=True)
    _decision(conn, "ECLI:2", "loaded", stamped=True)
    _decision(conn, "ECLI:3", "loaded", stamped=False)
    _decision(conn, "ECLI:4", "fetched", stamped=False)

    # Case citations: 2 bge (one resolved), 1 docket (resolved), 1 ecli
    # (unresolved) -- and a repeat "BGE 142 III 102" to exercise the top-N
    # ranking by count.
    _case_citation(conn, "ECLI:1", "BGE 142 III 102", "bge", True, "docket_exact")
    _case_citation(conn, "ECLI:2", "BGE 142 III 102", "bge", True, "docket_exact")
    _case_citation(conn, "ECLI:1", "BGE 1 I 1", "bge", False, "unresolved")
    _case_citation(conn, "ECLI:1", "4A_22/2017", "docket", True, "docket_exact")
    _case_citation(conn, "ECLI:2", "ECLI:CH:1", "ecli", False, "unresolved")

    # Legislation citations: de/fr, a mix of match_method, and a repeated
    # unresolved abbreviation ("XYZ" twice) to rank ahead of a single one.
    _leg_citation(conn, "ECLI:1", "OR", "336", "de", True, "edition_at_date")
    _leg_citation(conn, "ECLI:2", "OR", "1", "de", False, "act_only")
    _leg_citation(conn, "ECLI:1", "CO", "336", "fr", True, "latest_edition")
    _leg_citation(conn, "ECLI:2", "XYZ", "1", "de", False, "unresolved_abbr")
    _leg_citation(conn, "ECLI:3", "XYZ", "2", "de", False, "unresolved_abbr")
    _leg_citation(conn, "ECLI:3", "ABC", "1", "fr", False, "unresolved_abbr")
    return conn


def test_case_totals_and_by_kind(seeded):
    result = reports_cit.summary(seeded)
    cases = result["cases"]
    assert cases["total"] == 5
    assert cases["resolved"] == 3
    assert cases["resolved_share"] == pytest.approx(3 / 5)

    assert cases["by_kind"]["bge"] == {
        "total": 3, "resolved": 2, "resolved_share": pytest.approx(2 / 3)}
    assert cases["by_kind"]["docket"] == {
        "total": 1, "resolved": 1, "resolved_share": 1.0}
    assert cases["by_kind"]["ecli"] == {
        "total": 1, "resolved": 0, "resolved_share": 0.0}


def test_legislation_totals_by_lang_and_match_method(seeded):
    result = reports_cit.summary(seeded)
    leg = result["legislation"]
    assert leg["total"] == 6
    assert leg["resolved"] == 2
    assert leg["resolved_share"] == pytest.approx(2 / 6)

    assert leg["by_lang"]["de"]["total"] == 4
    assert leg["by_lang"]["fr"]["total"] == 2
    assert leg["by_match_method"]["unresolved_abbr"] == 3
    assert leg["by_match_method"]["edition_at_date"] == 1
    assert leg["by_match_method"]["act_only"] == 1
    assert leg["by_match_method"]["latest_edition"] == 1


def test_top_unresolved_abbr_ranks_by_count(seeded):
    result = reports_cit.summary(seeded)
    top = result["top_unresolved_abbr"]
    assert top[0] == {"abbr_raw": "XYZ", "count": 2}
    assert {"abbr_raw": "ABC", "count": 1} in top
    # OR/CO were resolved and must not appear -- this list is
    # match_method = 'unresolved_abbr' only.
    assert all(r["abbr_raw"] not in ("OR", "CO") for r in top)


def test_top_cited_bge_ranks_by_count_and_excludes_other_kinds(seeded):
    result = reports_cit.summary(seeded)
    top = result["top_cited_bge"]
    assert top[0] == {"to_raw": "BGE 142 III 102", "count": 2}
    # docket/ecli citations must never leak into the bge-only ranking.
    assert all("4A_22/2017" != r["to_raw"] and "ECLI:CH:1" != r["to_raw"]
              for r in top)


def test_decisions_loaded_vs_stamped(seeded):
    result = reports_cit.summary(seeded)
    # 3 rows at stage 'loaded' (ECLI:1/2/3); 2 of those are stamped, and
    # none of them has ever failed an extraction.
    assert result["decisions"] == {"loaded": 3, "stamped": 2,
                                   "retried": 0, "max_attempts": 0}


def test_decisions_reports_the_failed_extractions(conn):
    """The backlog is not all the same: a decision that has raised is not
    waiting its turn, it is being retried -- and once max_attempts reaches
    CHPIPE_MAX_ATTEMPTS some of them have been retired from the queue
    unstamped, which is the number an operator has to be able to see."""
    _decision(conn, "ECLI:1", "loaded", stamped=True)
    _decision(conn, "ECLI:2", "loaded", stamped=False, attempts=3)
    _decision(conn, "ECLI:3", "loaded", stamped=False)

    assert reports_cit.summary(conn)["decisions"] == {
        "loaded": 3, "stamped": 1, "retried": 1, "max_attempts": 3}


def test_an_empty_database_reports_none_not_zero_for_resolved_share(conn):
    """The empty-population discipline reports.gate_a already follows:
    resolved_share must read as "nothing measured yet", not as "we measured
    and nothing resolved" (0.0 would be indistinguishable from that)."""
    result = reports_cit.summary(conn)
    assert result["cases"]["resolved_share"] is None
    assert result["legislation"]["resolved_share"] is None
    assert result["top_unresolved_abbr"] == []
    assert result["top_cited_bge"] == []
    assert result["decisions"] == {"loaded": 0, "stamped": 0,
                                   "retried": 0, "max_attempts": 0}


def test_main_prints_the_summary_as_json(seeded, monkeypatch, capsys):
    monkeypatch.setenv("CHPIPE_DSN", os.environ["CHPIPE_TEST_DSN"])

    result = reports_cit.main()

    printed = json.loads(capsys.readouterr().out)
    assert printed == result
    assert printed["decisions"]["loaded"] == 3
