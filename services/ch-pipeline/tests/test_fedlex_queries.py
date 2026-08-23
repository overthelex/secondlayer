import httpx

from chpipe import fedlex_queries as q
from chpipe.sparql import SparqlClient


def test_every_select_query_is_distinct():
    """Fedlex serves the same triples from several named graphs. A versions
    query for SR 220 without DISTINCT returned the same edition six times."""
    for name in ("ACTS", "VERSIONS", "TITLES"):
        assert "SELECT DISTINCT" in getattr(q, name), f"{name} is missing DISTINCT"


def test_acts_filters_the_sr_notation_by_its_datatype():
    assert "id-systematique" in q.ACTS


def test_no_query_walks_by_offset():
    """The regression guard for the whole fix.

    Fedlex runs Virtuoso, which raises SR353 as soon as a sorted TOP clause
    asks for more than 10,000 rows -- and the limit is on OFFSET + LIMIT
    together, so a bigger page size only moves the wall. Verified live on
    2026-08-23: OFFSET 9990 LIMIT 10 returns rows, OFFSET 10000 LIMIT 10 does
    not. ACTS must cover 17,293 works, TITLES ~52,000 rows and VERSIONS
    ~170,000, so an OFFSET walk cannot reach most of the corpus at all. Every
    one of these three queries used to end in `LIMIT %(limit)d OFFSET
    %(offset)d`; none of them may again."""
    for name in ("ACTS", "TITLES", "VERSIONS"):
        text = getattr(q, name)
        assert "OFFSET" not in text.upper(), f"{name} walks by offset again"
        assert "%(offset)d" not in text, f"{name} walks by offset again"


def test_every_query_still_orders_stably():
    for name in ("ACTS", "TITLES", "VERSIONS"):
        assert "ORDER BY" in getattr(q, name), \
            f"{name} without ORDER BY can drop or repeat rows"


def test_acts_pages_by_key_not_by_a_row_counter():
    """ACTS has no driving set of its own, so it is walked by filtering past
    the last work seen. `>=` rather than `>`: a work can occupy two rows (see
    the dual-status test below) and a strict comparison would drop whichever
    of them fell on the far side of a page boundary."""
    assert "%(after)s" in q.ACTS
    assert "%(limit)d" in q.ACTS
    assert 'FILTER(STR(?work) >= "%(after)s")' in q.ACTS


def test_titles_and_versions_are_driven_by_a_values_batch():
    """Once ch_act is populated both are driven by batches of known work URIs
    rather than walked globally. That bounds every query far below the
    ceiling, makes the walk resumable act by act, and -- for VERSIONS -- makes
    an orphaned version impossible by construction, because the parent work is
    by definition already in ch_act."""
    for name in ("TITLES", "VERSIONS"):
        text = getattr(q, name)
        assert "VALUES ?work { %(values)s }" in text, f"{name} is not batch-driven"
        assert "%(limit)d" not in text, f"{name} should be bounded by its batch"


def test_the_work_batch_size_keeps_the_worst_case_under_the_ceiling():
    """Measured against the live endpoint on 2026-08-23 by grouping each query
    by ?work: the heaviest single work returns 770 title rows and 282 version
    rows, and the twenty heaviest works in the corpus sum to 8,692 title rows
    (the top twenty-five sum to 10,021, over the ceiling). TITLES is the
    binding constraint, so 20 is the largest batch whose absolute worst case
    still clears 10,000."""
    assert q.WORK_BATCH_SIZE == 20
    assert q.WORK_BATCH_SIZE * 770 < 20000     # sanity: one heavy work per slot


def test_status_code_extracts_the_trailing_integer():
    assert q.status_code(
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0") == 0
    assert q.status_code(
        "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3") == 3


def test_status_code_of_none_or_junk_is_none():
    assert q.status_code(None) is None
    assert q.status_code("not a uri") is None


def test_in_force_is_zero_not_one():
    """Verified against the vocabulary on 2026-08-23: 0 = 'In force',
    3 = 'Nicht mehr in Kraft'. Guessing 1 here would mark 5,087 acts repealed."""
    assert q.ENFORCEMENT_STATUS_IN_FORCE == 0


def test_acts_starts_from_the_beginning_when_the_key_is_empty():
    """The first page of a keyset walk passes an empty key; the filter must
    then admit every work rather than none."""
    assert 'STR(?work) >= ""' in (q.ACTS % {"limit": 5, "after": ""})


def test_acts_orders_by_status_too_for_full_determinism():
    """ORDER BY ?work alone does not order the two rows of a dual-status work
    against each other, so a paged walk could interleave them differently
    between runs. The ordering key must include ?inForce."""
    assert "ORDER BY ?work ?inForce" in q.ACTS


def test_a_work_with_two_conflicting_statuses_returns_both_rows_not_one():
    """Twelve works in the live Fedlex graph assert BOTH inForceStatus 0 (in
    force) and 3 (no longer in force) at once, e.g. cc/2003/31. SELECT
    DISTINCT is correct there -- the two rows genuinely differ -- and the
    client must not merge or drop either one. Resolving the conflict is the
    ingesting task's job, not the query's or the client's."""
    fixture = {
        "head": {"vars": ["work", "inForce"]},
        "results": {"bindings": [
            {"work": {"type": "uri",
                      "value": "https://fedlex.data.admin.ch/eli/cc/2003/31"},
             "inForce": {"type": "uri", "value":
                         "https://fedlex.data.admin.ch/vocabulary/enforcement-status/0"}},
            {"work": {"type": "uri",
                      "value": "https://fedlex.data.admin.ch/eli/cc/2003/31"},
             "inForce": {"type": "uri", "value":
                         "https://fedlex.data.admin.ch/vocabulary/enforcement-status/3"}},
        ]},
    }
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=fixture))
    client = SparqlClient("https://fake/sparql", transport=transport)

    rows = client.select(q.ACTS % {"limit": 5, "after": ""})

    assert len(rows) == 2, "neither row of the conflicting pair may be dropped"
    assert all(r["work"] == "https://fedlex.data.admin.ch/eli/cc/2003/31" for r in rows)
    statuses = {q.status_code(r["inForce"]) for r in rows}
    assert statuses == {0, 3}
