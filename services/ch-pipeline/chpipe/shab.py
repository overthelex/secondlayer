"""The amtsblattportal.ch (SHAB / FOSC) bulk-export list format.

The endpoint, probed live on 2026-08-26 with no authentication of any kind:

    GET https://amtsblattportal.ch/api/v1/publications/xml
        ?publicationStates=PUBLISHED
        &rubrics=HR
        &publicationDate.start=YYYY-MM-DD&publicationDate.end=YYYY-MM-DD
        &pageRequest.size=2000&pageRequest.page=N

It answers a `<bulk:bulk-export>` envelope carrying `<total>` (the size of the
WHOLE filtered result set, not of the page), a `<pageRequest>` echo, and one
`<publication ref="…/{uuid}/xml">` per hit whose `<meta>` block is all this
module reads. Measured totals for the two rubrics this pipeline walks:
HR (Handelsregister) 2,293,215 and KK (Konkurse und Schuldenrufe) 215,853.

Everything below was checked against 70 real titles captured that day and kept
in tests/fixtures/registries/shab_titles.txt, plus two three-publication pages
in shab_list_hr.xml / shab_list_kk.xml. What those captures actually contained
is what shaped three decisions here:

  * `<meta>` is read by DIRECT CHILD, never by a recursive walk. `<id>` occurs
    twice inside one meta block -- the publication's own id and the
    registration office's -- so a walk that takes the first `<id>` it finds is
    correct only as long as the two happen to stay in that order.
  * A KK title has NO SEAT. "Kollokationsplan und Inventar Christian Schwägli,
    ausgeschlagene Erbschaft" ends in a comma segment that is a statement
    about the estate, and "Avis préalable d'ouverture de faillite MOBS CH
    SARL, EN LIQUIDATION" ends in one that is part of the company's name.
    Applying HR's "the last segment is the seat" rule to KK would have written
    "ausgeschlagene Erbschaft" into 8 of 20 sampled seats.
  * HR03 in French is "Annulation", not the "Radiation" the plan predicted --
    4 of the 5 HR03 titles in the sample. A verb list written from the plan
    alone would have left the verb inside every one of those company names.

`legalRemedy` is deliberately not captured: it is the same paragraph of
statutory boilerplate on every publication of a sub-rubric, so storing it
would be ~2.5M copies of a dozen distinct strings.
"""
from __future__ import annotations

import calendar
import datetime as dt
import re
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

ENDPOINT = "https://amtsblattportal.ch/api/v1/publications/xml"

# The endpoint's own maximum; a larger value is silently clamped.
PAGE_SIZE = 2000

# executemany batch for the stage's upsert.
UPSERT_BATCH = 500

# The languages amtsblattportal publishes every title in.
LANGUAGES = ("de", "fr", "it", "en")

# Sub-rubric labels, used for ch_shab_publications.publication_type.
#
# Every entry below is the German title prefix of a publication the endpoint
# actually returned on 2026-08-26. The codes were found by probing each one
# with `subRubrics=<code>` over 2025-01-01..2026-08-26 and reading the
# `<total>` and the first title, plus the distribution over a full month of
# each rubric (KK 2026-08: 3,963 publications; HR 2026-08: 18,764).
#
# Two codes are deliberately absent:
#
#   HR04..HR07 -- they exist in the older ch_kantonsblatt importer's list, but
#   each of them answers total=0 over a 20-month window. Nothing to label.
#
#   KK10 (1,163 publications) -- its titles are free text written by the
#   office, IDENTICAL in all four languages and with no fixed opening phrase
#   ("Beschwerde mit aufschiebender Wirkung, Yalcin Mehmet, Unterkulm",
#   "Avviso di liquidazione speciale ai sensi dell'art. 230a LEF",
#   "Aufhebung Konkurseröffnung"). There is no phrase to label it with and no
#   verb to strip, so the code stands and parse_title leaves those titles whole.
#
# sub_rubric_label() returns the code itself for anything not here. A wrong
# label is worse than a bare code, because a bare code is visibly a code.
SUB_RUBRIC_LABELS = {
    "HR01": "Neueintragung",
    "HR02": "Mutation",
    "HR03": "Löschung",
    "KK01": "Vorläufige Konkursanzeige",
    "KK02": "Konkurspublikation/Schuldenruf",
    "KK03": "Einstellung des Konkursverfahrens",
    "KK04": "Kollokationsplan und Inventar",
    "KK05": "Verteilungsliste und Schlussrechnung",
    "KK06": "Schluss des Konkursverfahrens",
    "KK07": "Widerruf des Konkurses",
    "KK08": "Konkursamtliche Grundstücksteigerung",
    "KK09": "Lastenverzeichnisse",
    "KK11": "Anerkennung eines ausländischen Konkurses",
    "KK12": "Verzicht auf die Durchführung eines IPRG-Konkursverfahrens",
}

# The leading verb phrase a title opens with, in all four languages. Matched
# longest-first, so "Kollokationsplan und Inventar" wins over "Kollokationsplan"
# and the shorter one never truncates the longer one's title into a name
# beginning with "und Inventar".
#
# Every phrase here was READ OFF A LIVE PUBLICATION of the sub-rubric it
# belongs to (one probe per code, 2026-08-26), never predicted. Three of the
# predictions in the plan were wrong and would each have left the verb glued to
# a company name:
#
#   HR01 fr/it/en is "Nouvelles entrées" / "Nuove registrazioni" /
#        "New entries" -- plural, not the singular "Nouvelle inscription" /
#        "Nuova iscrizione" / "New entry".
#   HR03 fr is "Annulation", not "Radiation" -- all five HR03 titles in the
#        sampled page.
#   The renounced-estate qualifier in Italian is "eredità rifiutata", not
#        "eredità rinunciata", and in English "refused estate".
#
# Language-agnostic on purpose: the phrases do not collide across languages
# ("Mutation" is the same word and the same event in German and French), and a
# per-language table would fail on the one thing that actually varies -- a
# publication whose `language` is one thing and whose title, for an office that
# writes only in German, is another (KK10 is exactly that).
_VERBS = (
    # HR01 / HR02 / HR03
    "Neueintragung", "Nouvelles entrées", "Nuove registrazioni", "New entries",
    "Mutation", "Cambiamenti", "Change",
    "Löschung", "Annulation", "Cancellazione", "Deletion",
    # KK01..KK09, KK11, KK12 (KK10 is free text -- see SUB_RUBRIC_LABELS)
    "Vorläufige Konkursanzeige", "Avis préalable d'ouverture de faillite",
    "Avviso provvisorio di apertura di fallimento",
    "Provisional announcement of bankruptcy",
    "Konkurspublikation/Schuldenruf",
    "Publication de faillite/appel aux créanciers",
    "Pubblicazione di fallimento/diffida ai creditori",
    "Bankruptcy publication/call to creditors",
    "Einstellung des Konkursverfahrens", "Suspension de la procédure de faillite",
    "Sospensione della procedura di fallimento",
    "Suspension of bankruptcy proceedings",
    # KK04 publishes with and without the inventory, in German and in French
    # ("Kollokationsplan Econom Treuhand AG", "Etat de collocation Catherine
    # GRANDJEAN"). Both short forms are observed; no short Italian or English
    # one was, so none is invented.
    "Kollokationsplan und Inventar", "Kollokationsplan",
    "Etat de collocation et inventaire", "Etat de collocation",
    "Graduatoria e inventario", "Collocation plan and inventory",
    "Verteilungsliste und Schlussrechnung",
    "Liste de répartition et décompte final",
    "Stato di ripartizione e conto finale",
    "Distribution list and final accounts",
    "Schluss des Konkursverfahrens", "Clôture de faillite",
    "Chiusura della procedura di fallimento",
    "Closing of bankruptcy proceedings",
    "Widerruf des Konkurses", "Révocation de faillite", "Revoca del fallimento",
    "Revocation of bankruptcy",
    "Konkursamtliche Grundstücksteigerung",
    "Vente aux enchères forcée d'immeubles",
    "Pubblici incanti di fondi nel fallimento",
    "Auction of land by bankruptcy office",
    "Lastenverzeichnisse", "Etat des charges", "Elenco degli oneri",
    "Schedules of claims",
    "Anerkennung eines ausländischen Konkurses (Art. 166 ff. IPRG)",
    "Reconnaissance d'une faillite étrangère (cf. art. 166 ss. LDIP)",
    "Riconoscimento fallimento estero",
    "Recognition of a foreign bankruptcy (Art. 166 et seq. IPLA)",
    "Verzicht auf die Durchführung eines IPRG-Konkursverfahrens (Art. 174a IPRG)",
    "Renonciation à la procédure de faillite prévue par la LDIP "
    "(cf. art. 174a LDIP)",
    "Rinuncia all'esecuzione di una procedura di fallimento ancillare "
    "(art. 174a LDIP)",
    "Waiver of an IPLA bankruptcy proceeding (Art. 174a IPLA)",
)
_VERB_PREFIXES = tuple(sorted(_VERBS, key=len, reverse=True))

# The gazette writes the French and Italian apostrophe both ways -- KK08 fr has
# "d'immeubles" with U+0027 and KK11 fr has "d’une" with U+2019, in the same
# rubric on the same day. Normalised for MATCHING only, and the substitution is
# one character for one so the offsets used to slice the original still hold.
_APOSTROPHES = str.maketrans({"\u2019": "'", "\u02bc": "'"})

# "Mutation X, <old seat>, neu <new seat>" -- the tail announces the change,
# so it is cut before the seat is read and the row keeps the seat the company
# had at publication time. shab-detail overwrites both from the detail XML.
_NEW_TAIL = re.compile(r",\s+(?:neu|nouveau|nouvelle|nuovo|nuova|new)\s+")

# A KK debtor is often an estate rather than a person; the qualifier is a fact
# about the proceedings, not part of the name, and leaving it in stops the name
# from ever matching Zefix. All four forms are from live KK04/KK06/KK08 titles.
# Bare "succession" is the Geneva office's own short form ("Etat de collocation
# Gérard Daniel COQUOZ, succession"), seen alongside the full "succession
# répudiée" in the same rubric. Anchored at the end, so it cannot eat a comma
# segment in the middle of a name.
_ESTATE_QUALIFIER = re.compile(
    r",\s+(?:ausgeschlagene\s+Erbschaft|succession\s+répudiée|succession|"
    r"eredità\s+rifiutata|refused\s+estate)\s*$", re.IGNORECASE)


def sub_rubric_label(code: str | None) -> str | None:
    """The human label for a sub-rubric, or the code itself when unobserved."""
    if not code:
        return None
    return SUB_RUBRIC_LABELS.get(code, code)


def month_bounds(month: dt.date) -> tuple[dt.date, dt.date]:
    """(first day, last day) of the month `month` falls in."""
    first = month.replace(day=1)
    return first, first.replace(day=calendar.monthrange(first.year, first.month)[1])


def list_url(rubric: str, start: dt.date, end: dt.date, page: int = 0,
             size: int = PAGE_SIZE) -> str:
    """One page of one rubric over one date window.

    publicationDate.start/end are inclusive on both ends (checked against a
    single-day window that returned that day's publications).
    """
    return ENDPOINT + "?" + urlencode({
        "publicationStates": "PUBLISHED",
        "rubrics": rubric,
        "publicationDate.start": start.isoformat(),
        "publicationDate.end": end.isoformat(),
        "pageRequest.size": size,
        "pageRequest.page": page,
    })


def _tag(element) -> str:
    tag = element.tag
    return tag.split("}", 1)[-1] if isinstance(tag, str) and "}" in tag else tag


def _text(element) -> str:
    return (element.text or "").strip() if element is not None else ""


def _child(parent, name: str):
    """The first DIRECT child called `name`. See the module docstring for why
    this is not a recursive search."""
    for child in parent:
        if _tag(child) == name:
            return child
    return None


def _date(raw: str) -> dt.date | None:
    try:
        return dt.date.fromisoformat(raw)
    except ValueError:
        return None


def parse_list_page(xml_bytes: bytes) -> tuple[int, list[dict]]:
    """(total, one meta dict per publication).

    `total` is the size of the whole filtered result set, which is what the
    caller needs to know how many pages to ask for; len(metas) is this page.

    A publication with no `<id>` is dropped: shab_id is the upsert key, so a
    row without one could be written but never found, updated or given a
    detail. Everything else is best effort -- a missing field is None and the
    row still lands, because a list row is a pointer to a detail fetch, not
    the final record.
    """
    root = ET.fromstring(xml_bytes)
    total = int(_text(_child(root, "total")) or 0)

    metas: list[dict] = []
    for publication in root:
        if _tag(publication) != "publication":
            continue
        meta = _child(publication, "meta")
        if meta is None:
            continue
        shab_id = _text(_child(meta, "id"))
        if not shab_id:
            continue

        office = _child(meta, "registrationOffice")
        title_element = _child(meta, "title")
        titles = {}
        if title_element is not None:
            for child in title_element:
                text = _text(child)
                if text:
                    titles[_tag(child)] = text
        language = _text(_child(meta, "language")) or None

        cantons = [_text(node) for node in meta if _tag(node) == "cantons"]
        # <cantons>NE</cantons> in every sample, but the plural is the schema's
        # own word for the field, so a nested <canton> list is accepted too.
        nested = [_text(node) for element in meta if _tag(element) == "cantons"
                  for node in element if _tag(node) == "canton"]
        cantons = [c for c in cantons + nested if c]

        metas.append({
            "id": shab_id,
            "ref": publication.get("ref"),
            "rubric": _text(_child(meta, "rubric")) or None,
            "sub_rubric": _text(_child(meta, "subRubric")) or None,
            "language": language,
            "publication_number": _text(_child(meta, "publicationNumber")) or None,
            "publication_date": _date(_text(_child(meta, "publicationDate"))),
            "cantons": cantons[0] if cantons else None,
            "all_cantons": cantons,
            "title": titles.get(language) or titles.get("de") or None,
            "titles": titles,
            "registration_office": _text(_child(office, "displayName")) or None
                                   if office is not None else None,
        })
    return total, metas


def parse_title(title: str | None, lang: str | None = None,
                rubric: str | None = None) -> tuple[str | None, str | None]:
    """(company_name, seat) from a publication title.

    `lang` is accepted because callers have it and the signature is part of
    the stage contract; the verb table is deliberately language-agnostic (see
    _VERBS). `rubric` is what actually changes the shape: only HR titles carry
    a seat.

    Forgiving by construction. A verb this table has never seen -- HR04..HR07
    and KK05 were not in the captures -- leaves the title whole rather than
    cutting it at a guessed word boundary, so the worst case is a name with a
    verb glued to its front, which still matches on a trigram search.
    """
    text = " ".join((title or "").split())
    if not text:
        return None, None

    probe = text.translate(_APOSTROPHES)
    for verb in _VERB_PREFIXES:
        # ", " as well as " ": KK10-style titles put a comma after the phrase,
        # and so does the occasional office elsewhere.
        for separator in (" ", ", "):
            if probe.startswith(verb + separator):
                text = text[len(verb) + len(separator):].strip()
                break
        else:
            if probe == verb:
                return None, None
            continue
        break

    if rubric == "KK":
        return _ESTATE_QUALIFIER.sub("", text).strip() or None, None

    tail = _NEW_TAIL.search(text)
    if tail:
        text = text[:tail.start()].strip()
    if "," in text:
        name, _, seat = text.rpartition(",")
        return name.strip() or None, seat.strip() or None
    return text or None, None
