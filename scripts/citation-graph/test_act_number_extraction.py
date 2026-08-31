#!/usr/bin/env python3
"""
Regression guard for act-number extraction in extract-citations.py.

The number patterns silently lost every suffix for the life of the citation
graph: `[\\d\\-]{1,20}(?:\\-[IVX]{1,5})?` is greedy on the first class, eats the
separating hyphen, and the optional group then needs a SECOND one and matches
empty without backtracking. Latin «2262-XII» was truncated to «2262-» exactly
as reliably as Cyrillic «2262-ХІІ» — of 168K sampled rows on prod, not one
carried a Roman suffix in either alphabet, which is what made ~1.9M citations
unresolvable rather than merely imprecise.

Run: python3 scripts/citation-graph/test_act_number_extraction.py
"""

import importlib
import importlib.util
import re
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_patterns():
    """
    Import a module whose filename has a dash in it.

    extract-citations.py imports psycopg2 at module level, but these are pure
    regex assertions and must not need a database driver to run. Stub it if it
    is absent so the suite works anywhere -- a test that cannot start on a
    clean checkout is a test nobody runs.
    """
    try:
        importlib.import_module("psycopg2")
    except ImportError:
        # Stub the package AND its submodules in one pass. Importing the
        # submodules instead would make the machinery read psycopg2.__path__,
        # and a module __getattr__ that answers every name would hand it a
        # non-iterable -- TypeError, not a clean stub.
        for name in ("psycopg2", "psycopg2.extras", "psycopg2.extensions"):
            stub = types.ModuleType(name)
            stub.__path__ = []  # type: ignore[attr-defined]  # package-like
            stub.__getattr__ = lambda _attr: object  # type: ignore[attr-defined]
            sys.modules[name] = stub

    spec = importlib.util.spec_from_file_location("extract_citations", HERE / "extract-citations.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["extract_citations"] = mod
    try:
        spec.loader.exec_module(mod)
    except SystemExit:
        pass
    return mod.PATTERNS


PATTERNS = load_patterns()

# (text, expected number). Covers every shape the corpus actually uses.
LAW_BY_NUMBER = [
    ("Закону України від 09.04.1992 № 2262-XII", "2262-XII"),      # Latin Roman
    ("Закону України від 09.04.1992 № 2262-ХІІ", "2262-ХІІ"),      # Cyrillic Roman
    ("Закону України від 02.12.2010 № 2755-VІ", "2755-VІ"),        # MIXED Latin V + Cyrillic І
    ("Закон України № 2755-VI", "2755-VI"),
    ("Закону України № 1402-VIII", "1402-VIII"),
    ("Закону України № 996-XIV, який", "996-XIV"),                 # trailing punctuation
    ("Закону України № 254к/96-ВР", "254к/96-ВР"),                 # Constitution: slash + Cyrillic
    ("Закону України № 1199-2022-п", "1199-2022-п"),               # КМУ: year + word suffix
    ("Закону України № 2262-12", "2262-12"),                       # registry id in running text
    ("Закону України № 1030а-12", "1030а-12"),                     # letter-indexed core
    ("Закону України № 3674-VI від 08.07.2011", "3674-VI"),        # date AFTER the number
    ("Закону України № 2755-VI (Податковий кодекс)", "2755-VI"),   # parenthesis follows
    # «р.» / «року» between the date and the number is standard in judgments.
    ("Закону України від 09.04.1992 р. № 2262-ХІІ", "2262-ХІІ"),
    ("Закону України від 09.04.1992 року № 2262-XII", "2262-XII"),
]

# Tokens outside the measured shapes (core > 5 digits, suffix > 2 letters where
# the corpus allows at most 2) must match NOTHING. Capturing a prefix would
# store a truncated identifier -- the very defect this file guards against.
MUST_NOT_TRUNCATE = [
    "Закону України № 1234567-XII",
    "Закону України № 123456",
]

# (text, expected article, expected number)
LAW_ARTICLE = [
    ("ст. 5 Закону України № 2262-XII", "5", "2262-XII"),
    ("статті 12 Закону України № 254к/96-ВР", "12", "254к/96-ВР"),
    ("ст. 3 Закону України № 1199-2022-п", "3", "1199-2022-п"),
    # The alternation used to be (?:від|№) and «від» wins, so this stored the
    # DATE as the law number. «20.12.1991» and «09.04.1992» are really sitting
    # in law_number_raw on prod because of it.
    ("ст. 8 Закону України від 09.04.1992 № 2262-ХІІ", "8", "2262-ХІІ"),
]

DATE_RE = re.compile(r"^\d{1,2}\.\d{1,2}\.\d{4}$")


def main() -> int:
    failures = []

    for text, expected in LAW_BY_NUMBER:
        m = PATTERNS["law_by_number"].search(text)
        got = m.group(2) if m else None
        if got != expected:
            failures.append(f"law_by_number {text!r}: got {got!r}, want {expected!r}")

    for text, exp_art, exp_num in LAW_ARTICLE:
        m = PATTERNS["law_article"].search(text)
        art = m.group(1).strip() if m else None
        num = m.group(3) if m else None
        if art != exp_art or num != exp_num:
            failures.append(f"law_article {text!r}: got art={art!r} num={num!r}, want {exp_art!r}/{exp_num!r}")
        if num and DATE_RE.match(num):
            failures.append(f"law_article {text!r}: captured a DATE as the law number ({num!r})")

    # The quoted-name branch must keep working — it is how most citations name a law.
    m = PATTERNS["law_article"].search('ст. 5 Закону України «Про оренду землі»')
    if not m or m.group(2) != "Про оренду землі":
        failures.append("law_article: quoted-name branch broke")

    for text in MUST_NOT_TRUNCATE:
        m = PATTERNS["law_by_number"].search(text)
        if m:
            failures.append(f"law_by_number {text!r}: matched a prefix {m.group(2)!r} instead of declining")

    # No captured number may end in a bare hyphen. That is the exact shape the
    # old regex produced, and the one to never see again.
    for text, _ in LAW_BY_NUMBER:
        m = PATTERNS["law_by_number"].search(text)
        if m and m.group(2) and m.group(2).endswith("-"):
            failures.append(f"law_by_number {text!r}: truncated at the hyphen ({m.group(2)!r})")

    for f in failures:
        print("FAIL:", f)
    total = len(LAW_BY_NUMBER) + len(LAW_ARTICLE) + len(MUST_NOT_TRUNCATE) + 1
    print(f"{total - len(failures)}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
