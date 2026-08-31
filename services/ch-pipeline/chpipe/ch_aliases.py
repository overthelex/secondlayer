"""Abbreviation aliases for Swiss federal acts, keyed by SR number.

Two sources feed ch_act_alias (migration 199):

  title_paren   `aliases_from_title()` pulls the abbreviation Fedlex itself
                puts in parentheses at the end of a title -- "... sur la
                protection des donnees (LPD)" -> "LPD", "... (Codice di
                procedura civile, CPC)" -> "CPC". This covers most acts and
                needs no maintenance as Fedlex adds new ones.

  curated       CURATED below, for the acts that carry no parenthesised
                abbreviation at all -- the big codes ("Code civil suisse du
                10 decembre 1907", no "(CC)" anywhere in the title) that
                Swiss courts and lawyers nonetheless cite by abbreviation
                constantly (OR, ZGB, StGB, Cst. ...). This map is curated by
                hand from Fedlex act titles and standard Swiss legal
                citation practice (SR classification, BGE/ATF/DTF citation
                conventions), not derived mechanically from any source --
                each abbreviation was checked against how the act is
                actually cited in Swiss case law and legal writing.

                Cantonal abbreviations are deliberately absent: ch_act only
                carries federal acts (Fedlex's Classified Compilation is a
                federal-law compilation), so a cantonal abbreviation here
                would alias to nothing and, worse, could collide with an
                unrelated federal one (642.11's "641.10 (StG / LT ...)" is
                excluded from this map for exactly that reason -- StG/LT
                names a cantonal tax act, not anything in ch_act).

A third source, the German `abbreviation` column Fedlex supplies directly on
ch_act, needs no function here -- aliases_stage.py reads it straight off the
row.
"""
from __future__ import annotations

import re

# Matches the abbreviation Fedlex puts in parentheses at the very end of a
# title, optionally preceded by a comma-separated gloss ("Codice di
# procedura civile, CPC"). The abbreviation itself is a single token (no
# spaces) starting with an uppercase letter -- which is what keeps this from
# matching a trailing date or status note ("Stand am 1. Januar 2026"): such
# a parenthetical has no comma, so the whole run between "(" and ")" would
# have to satisfy the token alone, and a token cannot contain the spaces a
# date is made of.
_TITLE_ABBR_RE = re.compile(
    r"\(([^()]*?,\s*)?([A-ZÄÖÜ][A-Za-zÄÖÜäöü0-9.-]{1,11})\)\s*$"
)


def aliases_from_title(title: str) -> str | None:
    """The parenthesised abbreviation at the end of `title`, or None.

    >>> aliases_from_title("Loi federale ... sur la protection des donnees (LPD)")
    'LPD'
    >>> aliases_from_title("Codice di procedura civile del ... (Codice di procedura civile, CPC)")
    'CPC'
    >>> aliases_from_title("Loi federale du ... sur le Tribunal federal (LTF)")
    'LTF'
    >>> aliases_from_title("Code civil suisse du 10 decembre 1907") is None
    True
    >>> aliases_from_title("Codice penale svizzero (Stand am 1. Januar 2026)") is None
    True
    """
    if not title:
        return None
    match = _TITLE_ABBR_RE.search(title)
    return match.group(2) if match else None


# sr_number -> {lang -> (abbreviations...)}. See the module docstring for
# provenance and the deliberate absence of cantonal abbreviations. Where an
# abbreviation is conventionally written both with and without a trailing
# period (Cst./Cst, Cost./Cost), both forms are stored so lookup does not
# have to normalise punctuation.
CURATED: dict[str, dict[str, tuple[str, ...]]] = {
    "101": {"de": ("BV",), "fr": ("Cst.", "Cst"), "it": ("Cost.", "Cost")},
    "210": {"de": ("ZGB",), "fr": ("CC",), "it": ("CC",)},
    "220": {"de": ("OR",), "fr": ("CO",), "it": ("CO",)},
    "272": {"de": ("ZPO",), "fr": ("CPC",), "it": ("CPC",)},
    "281.1": {"de": ("SchKG",), "fr": ("LP",), "it": ("LEF",)},
    "311.0": {"de": ("StGB",), "fr": ("CP",), "it": ("CP",)},
    # 312.0 carries both the StPO (2011-) and the repealed Bundesstrafrechtspflege
    # (BStP / PPF / PP); the resolver picks the act in force on the decision date.
    "312.0": {"de": ("StPO", "BStP"), "fr": ("CPP", "PPF"), "it": ("CPP", "PP")},
    # 173.110 also names the repealed Bundesrechtspflegegesetz (OG / OJ / OG).
    "173.110": {"de": ("BGG", "OG"), "fr": ("LTF", "OJ"), "it": ("LTF", "OG")},
    "172.021": {"de": ("VwVG",), "fr": ("PA",), "it": ("PA",)},
    "173.32": {"de": ("VGG",), "fr": ("LTAF",), "it": ("LTAF",)},
    "235.1": {"de": ("DSG",), "fr": ("LPD",), "it": ("LPD",)},
    "830.1": {"de": ("ATSG",), "fr": ("LPGA",), "it": ("LPGA",)},
    "831.10": {"de": ("AHVG",), "fr": ("LAVS",), "it": ("LAVS",)},
    "831.20": {"de": ("IVG",), "fr": ("LAI",), "it": ("LAI",)},
    "832.10": {"de": ("KVG",), "fr": ("LAMal",), "it": ("LAMal",)},
    "832.20": {"de": ("UVG",), "fr": ("LAA",), "it": ("LAINF",)},
    "831.40": {"de": ("BVG",), "fr": ("LPP",), "it": ("LPP",)},
    "837.0": {"de": ("AVIG",), "fr": ("LACI",), "it": ("LADI",)},
    # 142.20: AIG since 2019, AuG 2008-2018, ANAG before; fr LEI / LEtr / LSEE.
    "142.20": {"de": ("AIG", "AuG", "ANAG"), "fr": ("LEI", "LEtr", "LSEE"), "it": ("LStrI", "LStr", "LDDS")},
    "142.31": {"de": ("AsylG",), "fr": ("LAsi",), "it": ("LAsi",)},
    # 641.10 (StG / LT) is deliberately omitted: it names a cantonal tax
    # act, not anything ch_act carries -- see the module docstring.
    "642.11": {"de": ("DBG",), "fr": ("LIFD",), "it": ("LIFD",)},
    "641.20": {"de": ("MWSTG",), "fr": ("LTVA",), "it": ("LIVA",)},
    "0.101": {"de": ("EMRK",), "fr": ("CEDH",), "it": ("CEDU",)},
    "351.1": {"de": ("IRSG",), "fr": ("EIMP",), "it": ("AIMP",)},
    "211.412.11": {"de": ("BGBB",), "fr": ("LDFR",), "it": ("LDFR",)},
    "221.229.1": {"de": ("VVG",), "fr": ("LCA",), "it": ("LCA",)},
    "232.11": {"de": ("MSchG",), "fr": ("LPM",), "it": ("LPM",)},
    "241": {"de": ("UWG",), "fr": ("LCD",), "it": ("LCSl",)},
    "251": {"de": ("KG",), "fr": ("LCart",), "it": ("LCart",)},
    "741.01": {"de": ("SVG",), "fr": ("LCR",), "it": ("LCStr",)},
    "700": {"de": ("RPG",), "fr": ("LAT",), "it": ("LPT",)},
    "814.01": {"de": ("USG",), "fr": ("LPE",), "it": ("LPAmb",)},
    "173.71": {"de": ("StBOG",), "fr": ("LOAP",), "it": ("LOAP",)},
    "152.3": {"de": ("BGÖ",), "fr": ("LTrans",), "it": ("LTras",)},
    "935.61": {"de": ("BGFA",), "fr": ("LLCA",), "it": ("LLCA",)},
}
