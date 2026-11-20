#!/usr/bin/env python3
"""
Regression guard for decision -> case-number extraction (LEXAI-2314).

Every positive and negative case below is a shape seen in sampled prod texts
(edrsr_fulltext, 2026-11-20). See case_numbers.py for the measurements.

Run: python3 scripts/citation-graph/test_case_number_extraction.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from case_numbers import find_case_refs  # noqa: E402

# (text, [normalized numbers])
POSITIVE = [
    ("у справі № 761/9584/15-ц (провадження № 14-1ц18)", ["761/9584/15-ц"]),
    ("Справа №668/3480/16-п \n\n Пров. №3/766/262/16", ["668/3480/16-п"]),
    ("у справах №120/8603/21-а (постанова", ["120/8603/21-а"]),
    ("справа № 165/1630/15-к\\~\\~\\~", ["165/1630/15-к"]),
    ("у справі № 462/5368/16-ц).", ["462/5368/16-ц"]),
    ("у справі №548/2056/16-а, від", ["548/2056/16-а"]),
    ("у справі № 908/976/19, від", ["908/976/19"]),
    ("Справа № 140/203/19\n\n Провадження", ["140/203/19"]),
    # dash look-alikes, Latin look-alike / layout-typo suffixes, upper case
    ("у справі № 761/9584/15–ц", ["761/9584/15-ц"]),
    ("у справі № 761/9584/15—Ц.", ["761/9584/15-ц"]),
    ("у справі № 120/8603/21-a,", ["120/8603/21-а"]),   # Latin a
    ("у справі № 120/8603/21-e ", ["120/8603/21-е"]),   # Latin e
    ("у справі № 640/1234/19-k;", ["640/1234/19-к"]),   # Latin k
    ("у справі № 640/1234/19-w;", ["640/1234/19-ц"]),   # w = ц key
    ("справа № 916/123/20-Е", ["916/123/20-е"]),
    ("у справі № 911/2345/17-нр", ["911/2345/17-нр"]),
    # a space on one side of the dash only
    ("у справі № 761/9584/15 -ц ", ["761/9584/15-ц"]),
    ("у справі № 761/9584/15- ц ", ["761/9584/15-ц"]),
    # four-digit years and leading-zero court codes are real cause_num shapes
    ("справа № 0870/1234/2012", ["0870/1234/2012"]),
    # the case number inside criminal-proceeding wording IS the case number
    ("Розгляд кримінального провадження №766/2436/16-к за", ["766/2436/16-к"]),
    ("об'єднані в одне провадження № 446/545/26, номер", ["446/545/26"]),
    # several references, one beyond 10,000 characters
    ("справі № 1/2/20 " + "x" * 12000 + " справі № 3/4/21-ц", ["1/2/20", "3/4/21-ц"]),
]

# Text after the number that is not a suffix: the base is kept, the tail is not.
BASE_ONLY = [
    ("у справі № 761/9584/15 - а також", ["761/9584/15"]),       # spaced dash + word
    ("у справі № 761/9584/15-цивільна", ["761/9584/15"]),        # a word, not a suffix
    ("у справі № 761/9584/15-та інших", ["761/9584/15"]),        # unknown letters
    ("у справі № 761/9584/15-кп", ["761/9584/15"]),              # not a cause_num suffix
    ("у справі №19/5007/10-Б/12 про", ["19/5007/10"]),           # suffix glued to /12
]

# Not case numbers at all: must yield nothing.
NEGATIVE = [
    "Провадження № 3/766/262/16 \n\n 27.04.2016",                # 4-part proceeding no.
    "Провадження №2/140/323/19\n\n У Х В А Л А",
    "пр. № 3/759/833/23 \n\n ПОСТАНОВА",
    "Номер провадження №2/318/16/2016 ",
    "провадження № 3/641/511/25",
    "кредитний договір №675/07/2013/0312,",                     # 4-part contract no.
    "Супровідний лист №125/7/02-97-03 від 27.01.2021",           # letter no., numeric tail
    "Супровідний лист № 239/10/02-97-03-03 від",
    "висновок експертів №752/11428/21-35 від",
    "рішенням ВРП від 17.08.2021 № 1845/0/15-21 (далі",
    "провадження № 1-кп/761/1234/20",                            # prefixed proceeding no.
    "провадження № 61-1234св20",
    "ЄРДР № 12020100000000123",
    "провадження № 2 /756/20/16",
    "справа 761/9584/15-ц",                                      # no «№»: out of scope
]


def main() -> int:
    failed = 0
    for text, expected in POSITIVE + BASE_ONLY:
        got = [n for n, _ in find_case_refs(text)]
        if got != expected:
            failed += 1
            print(f"FAIL {text[:70]!r}: expected {expected}, got {got}")
    for text in NEGATIVE:
        got = find_case_refs(text)
        if got:
            failed += 1
            print(f"FAIL (negative) {text!r}: got {got}")

    # The written form must be findable in the text again (readers cut snippets with strpos).
    for text, _ in POSITIVE:
        for _, written in find_case_refs(text):
            if written not in text:
                failed += 1
                print(f"FAIL written form {written!r} not in {text[:60]!r}")

    total = len(POSITIVE) + len(BASE_ONLY) + len(NEGATIVE)
    print(f"{total - failed}/{total} passed" if not failed else f"{failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
