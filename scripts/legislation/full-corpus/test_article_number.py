#!/usr/bin/env python3
"""Guards the article-number contract across the pipeline.

These tests import the shipped modules and call their real functions. An earlier
test in this repo re-implemented the regex it was guarding and therefore could
never fail; nothing here restates a pattern.

    python3 -m pytest scripts/legislation/full-corpus/test_article_number.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DBURL", "postgresql://unused@127.0.0.1:1/unused")

import article_number
import rebuild_articles

# (raw, canonical). The dash variants are not hypothetical: en dash is what broke
# a rebuild three quarters of the way through, and both dashes occur inside a
# single act.
VECTORS = [
    ("5", "5"),
    ("111", "111"),
    ("111-14", "111-14"),
    ("111–14", "111-14"),      # en dash
    ("111—14", "111-14"),      # em dash
    ("111 - 14", "111-14"),
    ("111 - 14", "111-14"),   # NBSP around the dash
    (" 111-14 ", "111-14"),
    ("1109-1", "1109-1"),
]


def test_normalize_matches_the_stored_form():
    for raw, want in VECTORS:
        assert article_number.normalize(raw) == want, raw


def test_leading_int_survives_every_dash():
    for raw, _ in VECTORS:
        assert article_number.leading_int(raw) == int(raw.strip()[:4].split("-")[0]
                                                      .split("–")[0].split("—")[0].strip())


def test_number_pattern_captures_the_index():
    """The whole point: the index must not be left behind by the capture."""
    import re
    rx = re.compile(r"Стаття\s+(" + article_number.NUMBER + r")")
    for text, want in [("Стаття 111-14. Щось", "111-14"),
                       ("Стаття 111–14. Щось", "111–14"),
                       ("Стаття 111. Щось", "111")]:
        assert rx.search(text).group(1) == want, text


def test_chunker_no_longer_truncates_to_the_neighbour():
    """04_chunk.py used to capture (\\d+), filing «Стаття 111-14» under 111.

    That output is the `legislation_full_bge` collection, and MCP matches art_no
    exactly, so the truncated point answered «ст. 111» with the wrong article's
    text instead of answering nothing.
    """
    chunk = __import__("04_chunk")
    text = ("Стаття 110. Перша.\nТіло першої.\n"
            "Стаття 111-14. Друга.\nТіло другої.\n"
            "Стаття 112. Третя.\nТіло третьої.\n")
    nums = [n for n, _ in chunk.split_articles(text)]
    assert "111-14" in nums, nums
    assert "111" not in nums, nums


def test_rebuild_articles_agrees_with_the_chunker():
    """Both writers must spell the same heading the same way, or PG and Qdrant
    disagree about what an article is called."""
    text = ("Стаття 110. Перша.\nТіло.\n"
            "Стаття 111–14. Друга.\nТіло.\n"
            "Стаття 112. Третя.\nТіло.\n")
    parsed = rebuild_articles.parse(text)
    assert parsed is not None
    assert [no for no, _o, _t, _b in parsed] == ["110", "111-14", "112"]


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-q"]))
