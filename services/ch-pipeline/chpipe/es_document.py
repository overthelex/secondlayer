"""entscheidsuche document JSON -> row fields.

Payload shape, captured 2026-08-23 from ZG_Obergericht:

    {"Signatur": "ZG_OG_001", "Spider": "ZG_Obergericht", "Datum": "2022-02-18",
     "PDF": {"Datei": "ZG_Obergericht/....pdf", "URL": "https://alt....", "Checksum": "..."},
     "Scrapedate": "2023-01-01", "Num": ["Z1 2020 5"],
     "Kopfzeile": [{"Sprachen": ["de"], "Text": "..."}, ...],
     "Meta": [{"Sprachen": ["de"], "Text": "..."}, ...]}

Note what is NOT here: any key holding the decision text. The text is a separate
file named by PDF.Datei or HTML.Datei. And `Datum` is top level, not under
`Meta` — reading it from `Meta` is what left every row dateless.

WHAT `chamber` HOLDS, AND WHY IT IS `Meta`'s FIRST ENTRY
--------------------------------------------------------
`Meta` is a LANGUAGE array, not a specificity ladder. Measured 2026-08-24
against both committed fixtures and eight spiders live on entscheidsuche.ch:

    spider                  entries  shape
    CH_BGer      (fixture)    3      de / fr / it of one label
    ZG_Obergericht (fixture)  4      de / fr / it, + one all-language entry
    AI_Aktuell                3      de / fr / it of one label
    NW_Gerichte               3      de / fr / it of one label
    SH_OG                     3      de / fr / it of one label
    OW_Gerichte               3      de / fr / it of one label
    CH_EDOEB                  3      de / fr / it of one label
    GE_Gerichte               3      de / fr / it of one label
    TI_Gerichte               3      de / fr / it of one label
    ZG_Verwaltungsgericht     4      de / fr / it, + one all-language entry

Eight of the ten carry the three-language shape and nothing else, and in
every one of them entry [0] is the German rendering and the LAST entry is
the Italian one — so "take the most specific entry" implemented as "take the
last" would store `Confederazione Tribunale federale I Corte di diritto
pubblico` on a German Bundesgericht decision, and an Italian label on all
91,866 French GE_Gerichte documents.

The two ZG spiders do carry a fourth, language-independent entry, and on
most of their documents it IS the more specific chamber (`I. Zivilabteilung`
against `Zug Obergericht Zivilabteilung`). It is not reliably a chamber even
there: ZG_VG_999 carries `Korrespondenz Verwaltungsgericht`, a document
category. Preferring it where it exists would also make one column mean two
different things — a chamber on two spiders, a court label on the other
fifty-two — which is worse for a reader than one meaning applied uniformly.

So `chamber` holds **entry [0] of `Meta`: entscheidsuche's own court label in
German, canton + court + division** (`Zug Obergericht Zivilabteilung`,
`Eidgenossenschaft Bundesgericht I. Öffentlich-rechtliche Abteilung`). It is
in German regardless of the decision's own language, because that is the
order entscheidsuche publishes the array in. The court's identity is also
carried structurally by `canton`, `court_code` (the `Signatur`) and `spider`;
this column is the human-readable name that goes with them.
"""
from __future__ import annotations

import datetime
import re
from dataclasses import dataclass, field

# Spiders whose prefix is the Confederation rather than a canton.
_FEDERAL_PREFIX = "CH"
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


@dataclass(frozen=True)
class DocumentFields:
    ecli: str
    doc_id: str
    spider: str
    canton: str | None
    court_code: str | None
    chamber: str | None
    decision_date: datetime.date | None
    docket_number: str | None
    abstract: str | None
    languages: list[str]
    html_path: str | None
    pdf_path: str | None
    source_pdf_url: str | None
    metadata_json: dict = field(default_factory=dict)


def _parse_date(raw) -> datetime.date | None:
    if not isinstance(raw, str):
        return None
    m = _ISO_DATE.match(raw.strip())
    if not m:
        return None
    try:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None          # 0000-00-00 and friends


def _localised_text(entries, want: str | None = None) -> str | None:
    """First Text from a list of {"Sprachen": [...], "Text": "..."} entries."""
    if not isinstance(entries, list):
        return entries if isinstance(entries, str) else None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if want and want not in (entry.get("Sprachen") or []):
            continue
        text = entry.get("Text")
        if text:
            return str(text)
    return None


def _languages(data: dict) -> list[str]:
    seen: list[str] = []
    for key in ("Kopfzeile", "Meta"):
        for entry in data.get(key) or []:
            if isinstance(entry, dict):
                for lang in entry.get("Sprachen") or []:
                    if lang not in seen:
                        seen.append(str(lang))
    # Handle Sprache as either a string or a list of strings
    sprache = data.get("Sprache")
    if sprache:
        if isinstance(sprache, str):
            if sprache not in seen:
                seen.append(sprache)
        elif isinstance(sprache, list):
            for lang in sprache:
                if lang not in seen:
                    seen.append(str(lang))
    return seen


def parse(spider: str, doc_id: str, data: dict) -> DocumentFields:
    prefix = spider.split("_")[0] if "_" in spider else spider
    canton = _FEDERAL_PREFIX if prefix == _FEDERAL_PREFIX else prefix

    num = data.get("Num")
    docket = None
    if isinstance(num, list) and num:
        docket = str(num[0])
    elif isinstance(num, str):
        docket = num

    pdf = data.get("PDF") if isinstance(data.get("PDF"), dict) else {}
    html = data.get("HTML") if isinstance(data.get("HTML"), dict) else {}

    return DocumentFields(
        ecli=doc_id if doc_id.startswith("ECLI:") else f"ECLI:CH:{spider}:{doc_id}",
        doc_id=doc_id,
        spider=spider,
        canton=canton,
        court_code=data.get("Signatur") or None,
        chamber=_localised_text(data.get("Meta")),
        decision_date=_parse_date(data.get("Datum")),
        docket_number=docket[:5000] if docket else None,
        abstract=(_localised_text(data.get("Abstract")) or None),
        languages=_languages(data),
        html_path=html.get("Datei") or None,
        pdf_path=pdf.get("Datei") or None,
        source_pdf_url=pdf.get("URL") or None,
        metadata_json={k: v for k, v in data.items() if k not in ("HTML", "PDF")},
    )
