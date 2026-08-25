"""Point-in-time question templates for the CH benchmark (de/fr/it).

Pure string formatting, no I/O. See docs/superpowers/plans/2026-08-25-ch-pit-benchmark.md,
"### Question templates (`templates.py`)", for the exact wording this module
reproduces.
"""
from __future__ import annotations

import datetime

# Month names spelled out per language, index 0 = January.
_MONTHS: dict[str, list[str]] = {
    "de": [
        "Januar", "Februar", "März", "April", "Mai", "Juni",
        "Juli", "August", "September", "Oktober", "November", "Dezember",
    ],
    "fr": [
        "janvier", "février", "mars", "avril", "mai", "juin",
        "juillet", "août", "septembre", "octobre", "novembre", "décembre",
    ],
    "it": [
        "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
        "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
    ],
}

# One template per language. `{n}` is the article number, `{abbr}` the act
# abbreviation, `{sr}` the SR (Systematische Rechtssammlung) number, `{date}`
# the pre-formatted date string from format_date().
_TEMPLATES: dict[str, str] = {
    "de": "Wie lautet Art. {n} {abbr} (SR {sr}) in der am {date} geltenden Fassung? Zitiere den Wortlaut.",
    "fr": "Quel est le texte de l'art. {n} {abbr} (RS {sr}) en vigueur le {date} ? Citez-le mot à mot.",
    "it": "Qual è il testo dell'art. {n} {abbr} (RS {sr}) in vigore il {date}? Citalo alla lettera.",
}


def format_date(d: datetime.date, lang: str) -> str:
    """Format D per LANG's convention: day without a leading zero, the
    month spelled out, then the year. German additionally puts a period
    after the day ("31. Dezember 2020"); French and Italian do not
    ("31 décembre 2020", "31 dicembre 2020").
    """
    month = _MONTHS[lang][d.month - 1]
    if lang == "de":
        return f"{d.day}. {month} {d.year}"
    return f"{d.day} {month} {d.year}"


def question(lang: str, n: str, abbr: str, sr: str, as_of: datetime.date) -> str:
    """Render the point-in-time question for one (article, act, date)."""
    return _TEMPLATES[lang].format(n=n, abbr=abbr, sr=sr, date=format_date(as_of, lang))
