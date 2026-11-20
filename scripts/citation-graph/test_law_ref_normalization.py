#!/usr/bin/env python3
"""
Regression guard for law-reference spelling in extract-citations.py (LEXAI-2323).

- «КЗпП» / «КУпАП» are matched case-insensitively and upper-cased; the full-name lookup
  was keyed on the mixed-case abbreviation, so both codes were stored as 'КЗПП' /
  'КУПАП' (66M rows in the 20.11.2026 full-text pass).
- «2262-ХІІ» (Cyrillic numeral) and «2262-XII» (Latin) are one act and must get one key.

Run: python3 scripts/citation-graph/test_law_ref_normalization.py
"""

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("extract_citations", HERE / "extract-citations.py")
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)


def statute(text):
    return [(c.citation_type, c.law_ref, c.article_ref)
            for c in ec.extract_citations_from_text(1, text) if c.citation_type in ec._STATUTE_TYPES]


CASES = [
    ("ст. 117 КЗпП України", ("codex_article", "Кодекс законів про працю України", "117")),
    ("ст. 117 КЗПП", ("codex_article", "Кодекс законів про працю України", "117")),
    ("ст. 130 КУпАП", ("codex_article", "Кодекс України про адміністративні правопорушення", "130")),
    ("ст. 130 КУПАП", ("codex_article", "Кодекс України про адміністративні правопорушення", "130")),
    ("ст. 16 ЦК України", ("codex_article", "Цивільний кодекс України", "16")),
    ("статті 5 Закону № 2011-ХІІ", ("law_article", "2011-XII", "5")),
    ("статті 5 Закону № 2011-XII", ("law_article", "2011-XII", "5")),
]
NORMALIZE = [
    ("2262-ХІІ", "2262-XII"), ("2195-ІV", "2195-IV"), ("796 - ХІІ", "796-XII"),
    ("1058-IV", "1058-IV"), ("Про виконавче провадження", "Про виконавче провадження"), ("2262", "2262"),
]


def main():
    failures = 0
    for text, want in CASES:
        got = statute(text)
        if want not in got:
            failures += 1
            print(f"FAIL {text!r}: {got} lacks {want}")
    for raw, want in NORMALIZE:
        got = ec.normalize_law_ref(raw)
        if got != want:
            failures += 1
            print(f"FAIL normalize_law_ref({raw!r}) = {got!r}, want {want!r}")
    total = len(CASES) + len(NORMALIZE)
    print(f"{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
