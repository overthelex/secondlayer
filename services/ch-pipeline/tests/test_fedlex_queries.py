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


def test_acts_and_versions_are_pageable():
    for name in ("ACTS", "VERSIONS"):
        text = getattr(q, name)
        assert "%(limit)d" in text and "%(offset)d" in text
        assert "ORDER BY" in text, "paging without ORDER BY can drop or repeat rows"


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

    rows = client.select(q.ACTS % {"limit": 5, "offset": 0})

    assert len(rows) == 2, "neither row of the conflicting pair may be dropped"
    assert all(r["work"] == "https://fedlex.data.admin.ch/eli/cc/2003/31" for r in rows)
    statuses = {q.status_code(r["inForce"]) for r in rows}
    assert statuses == {0, 3}
