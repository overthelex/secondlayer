from chpipe import fedlex_queries as q


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
