"""What the 2026 instrument kept, dropped and added.

The successor is not a revision of the 2002 text but a different document: it
numbers its sections in roman and restarts arabic numbering inside each, where
the old text used one decimal hierarchy throughout. So the two cannot be aligned
provision by provision, and the comparison is made on what each text says rather
than on where it says it.

The questions the audit sets: does the new text keep the collective dominance
machinery nobody cited, does it keep the restatement of the statutory threshold
the authority never cited, and does it keep the bare stage names that assert
nothing.

Usage:
    python3 successor.py
"""
from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

OLD = "/data/amcu/z0317-02.txt"
NEW = "/data/amcu/z1043-26.txt"
# Section I is typed with the Cyrillic І (U+0406), the rest with Latin
# numerals. A Latin-only pattern silently loses the first section.
ROMAN = re.compile(r"^([IVXІ]{1,5})\.\s+(\S.*)$", re.M)
ITEM = re.compile(r"^(\d{1,2})\.\s+(\S.*)$", re.M)

PROBES = {
    "колективне домінування: «між ними немає конкуренції»":
        r"між\s+(ними|цими|зазначеними)[^.]{0,80}немає\s+конкуренції",
    "сукупна частка трьох, 50 відсотків": r"трьох[^.]{0,120}50\s*(відсотк|%)",
    "сукупна частка п'яти, 70 відсотків": r"п.?яти[^.]{0,120}70\s*(відсотк|%)",
    "поріг 35 відсотків для одного суб'єкта": r"35\s*(відсотк|%)",
    "перелік етапів аналізу": r"етап|такі дії|такі етапи",
    "бар'єри вступу на ринок": r"бар.?єр\w*\s+(вступу|входу)",
    "часові межі ринку": r"часов\w+\s+меж\w+\s+ринку",
    "SSNIP / гіпотетичний монополіст": r"SSNIP|гіпотетичн\w+\s+монополіст",
    "замінність з боку пропозиції": r"замінн\w+[^.]{0,40}з боку пропозиції",
    "ринкова влада": r"ринков\w+\s+влад\w+",
    "потенційні конкуренти": r"потенційн\w+\s+конкурент",
    "джерела інформації": r"джерел\w+\s+інформаці",
}


def stats(path: str) -> tuple[str, dict]:
    text = pathlib.Path(path).read_text(encoding="utf-8")
    return text, {
        "символів": len(text),
        "римських розділів": len(ROMAN.findall(text)),
        "нумерованих пунктів": len(ITEM.findall(text)),
    }


def main() -> None:
    old, so = stats(OLD)
    new, sn = stats(NEW)
    print(f"{'':38}{'2002':>12}{'2026':>12}")
    for k in sn:
        print(f"{k:<38}{so.get(k, 0):>12}{sn[k]:>12}")

    print(f"\n{'ознака':<52}{'2002':>7}{'2026':>7}")
    for name, pat in PROBES.items():
        a = len(re.findall(pat, old, re.I))
        b = len(re.findall(pat, new, re.I))
        mark = "" if (a > 0) == (b > 0) else "   <-- змінилось"
        print(f"{name:<52}{a:>7}{b:>7}{mark}")

    print("\nРОЗДІЛИ 2026")
    for n, title in ROMAN.findall(new):
        print(f"  {n:<6} {title[:78]}")


if __name__ == "__main__":
    main()
