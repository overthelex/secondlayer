#!/usr/bin/env python3
"""Guards normalize_flattened against the defect that cost 5.3M citation links.

The heuristic exists for procedural codes, where an inserted article is numbered
with a superscript (стаття 111⁵) that collapses to '1115' when the formatting is
lost. It used to split EVERY 4-5 digit token, which destroyed every genuine
four-digit article — the Civil Code has 301 of them, up to 1308. «ст. 1054 ЦК»
became '105-4'. Measured on prod 2026-08-18: 9 536 839 rows across 65 acts carried
the split signature, 5 320 562 of them resolved to nothing.

These tests import the shipped module and stub the registry, so they need no DB.

    python3 -m pytest scripts/citation-graph/test_flattened_article_numbers.py
"""
import importlib.util
import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("extract_citations",
                                               os.path.join(_HERE, "extract-citations.py"))
ec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ec)

CIVIL = "Цивільний кодекс України"
COMMERCIAL_PROC = "Господарський процесуальний кодекс України"


@pytest.fixture(autouse=True)
def registry():
    """Stub the index the way prod looks: the Civil Code really has 1054 and 1166;
    the commercial procedure code has the superscript insert 111-5 and no 1115."""
    ec._ART_INDEX.clear()
    ec._ART_INDEX.update({
        CIVIL: {"1054", "1166", "1268", "810-1", "681-1", "22"},
        COMMERCIAL_PROC: {"111-5", "111", "129-1"},
    })
    ec._ART_INDEX_READY = True
    yield
    ec._ART_INDEX.clear()
    ec._ART_INDEX_READY = False


@pytest.mark.parametrize("num", ["1054", "1166", "1268"])
def test_real_four_digit_civil_articles_survive(num):
    assert ec.normalize_flattened(num, CIVIL) == num


def test_flattened_superscript_still_splits_where_that_is_the_real_article():
    assert ec.normalize_flattened("1115", COMMERCIAL_PROC) == "111-5"


def test_unknown_act_keeps_the_literal_reading():
    # No index for this act: the document said 1054, so 1054 is what we keep.
    assert ec.normalize_flattened("1054", "Якийсь інший закон") == "1054"
    assert ec.normalize_flattened("1054", None) == "1054"


def test_missing_index_is_not_fatal():
    ec._ART_INDEX.clear()
    assert ec.normalize_flattened("1115", COMMERCIAL_PROC) == "1115"


@pytest.mark.parametrize("num", ["1", "22", "625", "п.38.6", "129-1"])
def test_short_and_non_numeric_pass_through(num):
    assert ec.normalize_flattened(num, CIVIL) == num


def test_end_to_end_the_citation_that_was_being_destroyed():
    cites = ec.extract_citations_from_text(1, "ст. 1054 ЦК України")
    arts = [c.article_ref for c in cites if c.citation_type == "codex_article"]
    assert arts == ["1054"], arts


def test_end_to_end_list_of_civil_articles():
    cites = ec.extract_citations_from_text(1, "ст.1268, 1270, 1272 ЦК України")
    arts = sorted(c.article_ref for c in cites if c.citation_type == "codex_article")
    assert arts == ["1268", "1270", "1272"], arts
